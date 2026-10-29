// corrupt-file: an idle tenant's SQLite file is overwritten on disk.
// docs/23 "SQLite file corrupted, WAL unreadable" (#103): the next request
// answers 503 RENOX_DB_UNAVAILABLE, the file is moved aside and restored
// from the replica on its own, the following request answers 200 with the
// replicated rows, and a tenant on the same node is not affected.

import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type Check, type Outcome, verdictOf } from "../lib/result.ts";
import { Probe, until, withStack } from "../lib/stack.ts";

export async function run(worker: string): Promise<Outcome> {
  return withStack(worker, { idleTimeoutSecs: 2 }, async (s) => {
    const { victim, victimNode, byNode } = await s.place(4);
    const neighbour = (byNode.get(victimNode.node) ?? []).find((t) => t !== victim) ?? null;
    const rows = 5;
    for (let i = 0; i < rows; i++) {
      const r = await s.hit(victimNode, victim, "POST");
      if (r.status !== 200) throw new Error(`write: ${r.status} ${r.text}`);
    }
    // Replicated, then evicted (idle 2 s) and the sidecar stopped (grace 3 s).
    await until("the rows replicated", 30_000, async () => {
      const b = await s.backups(victim);
      return typeof b.lag_seconds === "number" && b.lag_seconds < 2 && typeof b.last_sync_at === "number" ? true : null;
    });
    await until("the sidecar stopped after eviction", 60_000, async () => ((await s.backups(victim)).state === "stopped" ? true : null));

    const file = s.fileOf(victimNode, victim);
    for (const suffix of ["-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
    writeFileSync(file, Buffer.alloc(8192, 0xab));
    const probe = neighbour === null ? null : new Probe(s, victimNode, neighbour, "POST", 200);

    const first = await s.hit(victimNode, victim);
    const started = performance.now();
    const restored = await until("the restored tenant", 90_000, async () => {
      const r = await s.hit(victimNode, victim);
      return r.status === 200 ? r : null;
    }).catch(() => null);
    const restoreS = (performance.now() - started) / 1000;
    await probe?.stop();
    const quarantined = existsSync(dirname(file)) ? readdirSync(dirname(file)).filter((f) => f.startsWith("app.db.corrupt-")) : [];
    const checks: Check[] = [
      { name: "503 RENOX_DB_UNAVAILABLE first", ok: first.status === 503 && first.text.includes("RENOX_DB_UNAVAILABLE"), detail: `${first.status} ${first.text.slice(0, 120)}` },
      { name: "restored automatically with its rows", ok: restored !== null && Number(restored.body?.n) === rows, detail: restored === null ? "no 200 within 90 s" : `200 with n = ${String(restored.body?.n)} after ${restoreS.toFixed(1)} s` },
      { name: "the damaged file is kept", ok: quarantined.length === 1, detail: quarantined.join(", ") || "no app.db.corrupt-* file" },
      { name: "no impact on a neighbour", ok: probe === null || probe.failures === 0, detail: probe === null ? "no other tenant on the node" : `${neighbour?.id} on the same node: ${probe.summary()}` },
    ];
    return {
      scenario: "corrupt-file",
      title: "Tenant file corrupted",
      failureModes: ["SQLite file corrupted, WAL unreadable"],
      description: `${rows} rows written and replicated, the cell evicted (idle 2 s) and its sidecar stopped, then the tenant's app.db overwritten with 8 KiB of 0xAB (WAL and SHM removed)`,
      verdict: verdictOf(checks),
      result: `first answer ${first.status}, restored in ${restoreS.toFixed(1)} s with ${String(restored?.body?.n ?? "—")} of ${rows} rows, ${quarantined.length} quarantine file(s)`,
      target: "503 RENOX_DB_UNAVAILABLE, automatic restore, 200 with every replicated row, quarantine kept, neighbours unaffected",
      alerts: [{ rule: "RenoxTenantFileRestoring", observed: "reads renox_worker_db_unavailable (pending #295)" }],
      checks,
      metrics: { restore_s: restoreS, rows_written: rows, rows_restored: Number(restored?.body?.n ?? 0) },
      notes: [],
    };
  });
}
