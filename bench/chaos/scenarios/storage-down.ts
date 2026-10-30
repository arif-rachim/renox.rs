// storage-down: the object storage that holds artifacts stops answering.
// docs/23 "Object storage unreachable": a tenant whose artifact the node has
// cached keeps serving; a cold start that needs the artifact answers 503
// RENOX_UNAVAILABLE; the worker reports `object_storage` degraded; when the
// storage is back, the cold start works.
//
// Needs an S3 endpoint for control/api and commands that cut and restore it:
//   RENOX_CHAOS_S3_ENDPOINT, RENOX_CHAOS_S3_ACCESS_KEY_ID, RENOX_CHAOS_S3_SECRET_ACCESS_KEY,
//   RENOX_CHAOS_S3_DOWN (e.g. `docker pause renox-control-minio-1`), RENOX_CHAOS_S3_UP.
// CI's chaos workflow starts MinIO from control/docker-compose.yml and sets
// them; without them the scenario is skipped with the reason.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { type Check, type Outcome, verdictOf } from "../lib/result.ts";
import { Stack, until } from "../lib/stack.ts";

const env = (k: string): string | undefined => process.env[k] || undefined;

function sh(cmd: string): void {
  const r = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd}: exit ${r.status}`);
}

export async function run(worker: string): Promise<Outcome> {
  const base: Omit<Outcome, "verdict" | "result" | "checks" | "metrics"> = {
    scenario: "storage-down",
    title: "Object storage unreachable",
    failureModes: ["Object storage unreachable"],
    description: "control/api keeps artifacts in S3 (MinIO); the storage is paused while one tenant is warm and another's artifact is removed from its node's cache, then resumed",
    target: "cached tenant 200 throughout; uncached cold start 503 RENOX_UNAVAILABLE while down, 200 after; /healthz reports object_storage",
    alerts: [{ rule: "RenoxObjectStorageUnreachable", observed: "reads renox_worker_degraded{component=\"object_storage\"} (pending #295); the reason is on /healthz" }],
    notes: [],
  };
  const endpoint = env("RENOX_CHAOS_S3_ENDPOINT");
  const down = env("RENOX_CHAOS_S3_DOWN");
  const up = env("RENOX_CHAOS_S3_UP");
  if (endpoint === undefined || down === undefined || up === undefined) {
    return { ...base, verdict: "SKIPPED", skipped: "RENOX_CHAOS_S3_ENDPOINT, RENOX_CHAOS_S3_DOWN and RENOX_CHAOS_S3_UP are not set (CI's chaos workflow sets them with MinIO)", result: "", checks: [], metrics: {} };
  }
  const s = await Stack.start(worker, {
    s3: { endpoint, accessKeyId: env("RENOX_CHAOS_S3_ACCESS_KEY_ID") ?? "", secretAccessKey: env("RENOX_CHAOS_S3_SECRET_ACCESS_KEY") ?? "" },
  });
  let keep = true;
  let storageDown = false;
  try {
    const { victim, victimNode, byNode } = await s.place(4);
    const cold = (byNode.get(victimNode.node) ?? []).find((t) => t !== victim) ?? null;
    if ((await s.hit(victimNode, victim)).status !== 200) throw new Error("warming the victim failed");
    // The cold tenant's artifact leaves the node's cache, so its cold start must fetch it.
    if (cold !== null) rmSync(join(victimNode.dir, "artifacts", cold.hash), { recursive: true, force: true });

    sh(down);
    storageDown = true;
    const warm = await s.hit(victimNode, victim);
    const coldDown = cold === null ? null : await s.hit(victimNode, cold, "GET", 30_000);
    const degraded = await until("object_storage on /healthz", 30_000, async () => ((await s.health(victimNode))?.reasons?.some((r) => r.startsWith("object_storage")) ? true : null)).catch(() => false);
    sh(up);
    storageDown = false;
    const coldUp = cold === null ? null : await until("the cold start after the storage is back", 60_000, async () => {
      const r = await s.hit(victimNode, cold, "GET", 30_000);
      return r.status === 200 ? r : null;
    }).catch(() => null);

    const checks: Check[] = [
      { name: "cached tenant serves", ok: warm.status === 200, detail: `${victim.id}: ${warm.status}` },
      {
        name: "uncached cold start refused",
        ok: coldDown === null || (coldDown.status === 503 && coldDown.text.includes("RENOX_UNAVAILABLE")),
        detail: coldDown === null ? "no second tenant on the node" : `${cold?.id}: ${coldDown.status} ${coldDown.text.slice(0, 100)}`,
      },
      { name: "the worker reports it", ok: degraded === true, detail: degraded === true ? "object_storage on /healthz" : "no object_storage reason within 30 s" },
      { name: "cold start after recovery", ok: cold === null || coldUp !== null, detail: coldUp === null ? "not 200 within 60 s" : "200" },
    ];
    const out: Outcome = { ...base, verdict: verdictOf(checks), result: checks.map((c) => `${c.name}: ${c.detail}`).join("; "), checks, metrics: {} };
    keep = out.verdict === "FAIL";
    if (keep) out.notes.push(`Logs kept in ${s.root}.`);
    return out;
  } catch (e) {
    keep = true;
    throw new Error(`${e instanceof Error ? e.message : String(e)} (logs kept in ${s.root})`);
  } finally {
    if (storageDown) sh(up);
    await s.stop();
    if (!keep) s.cleanup();
  }
}
