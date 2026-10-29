// replica-lag: the tenant's Litestream sidecar is frozen (SIGSTOP) while
// the tenant keeps writing, then thawed. docs/23 "Replica lagging /
// Litestream behind": the tenant sees nothing, the lag the node reports
// passes the FO6 threshold (10 s) and the control plane's metric shows it
// (RenoxReplicationLag), and the lag falls back once the sidecar runs.

import { spawnSync } from "node:child_process";

import { type Check, type Outcome, verdictOf } from "../lib/result.ts";
import { Probe, sample, until, withStack } from "../lib/stack.ts";

const FREEZE_MS = 15_000;

function sidecarPids(nodeDir: string, database: string): number[] {
  const out = spawnSync("pgrep", ["-f", `litestream replicate -config .*${database}\\.yml`], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .map(Number)
    .filter((pid) => pid > 0)
    .filter((pid) => {
      const cmd = spawnSync("cat", [`/proc/${pid}/cmdline`], { encoding: "utf8" }).stdout ?? "";
      return cmd.replaceAll("\0", " ").includes(nodeDir);
    });
}

export async function run(worker: string): Promise<Outcome> {
  return withStack(worker, {}, async (s) => {
    const { victim, victimNode } = await s.place(2);
    for (let i = 0; i < 3; i++) await s.hit(victimNode, victim, "POST");
    await until("the sidecar replicating with a sync", 30_000, async () => {
      const b = await s.backups(victim);
      return b.state === "replicating" && typeof b.last_sync_at === "number" ? true : null;
    });
    const pids = await until("the sidecar's pid", 10_000, async () => {
      const p = sidecarPids(victimNode.dir, victim.id);
      return p.length > 0 ? p : null;
    });
    const writes = new Probe(s, victimNode, victim, "POST", 100);
    for (const pid of pids) process.kill(pid, "SIGSTOP");
    let maxLag = 0;
    let metricLag = 0;
    const frozen = performance.now();
    while (performance.now() - frozen < FREEZE_MS) {
      await Bun.sleep(1000);
      const b = await s.backups(victim);
      if (typeof b.lag_seconds === "number") maxLag = Math.max(maxLag, b.lag_seconds);
      metricLag = Math.max(metricLag, sample(await s.metrics(), "renox_cp_replication_lag_max_seconds") ?? 0);
    }
    for (const pid of pids) process.kill(pid, "SIGCONT");
    const thawed = performance.now();
    const recovered = await until("the lag back under 5 s", 60_000, async () => {
      await s.hit(victimNode, victim, "POST");
      const b = await s.backups(victim);
      return typeof b.lag_seconds === "number" && b.lag_seconds < 5 ? (performance.now() - thawed) / 1000 : null;
    }).catch(() => null);
    await writes.stop();
    const checks: Check[] = [
      { name: "the tenant sees nothing", ok: writes.failures === 0, detail: `writes during and after the freeze: ${writes.summary()}` },
      { name: "the lag passes the FO6 threshold", ok: maxLag > 10, detail: `getBackups lag_seconds up to ${maxLag.toFixed(1)} s` },
      { name: "the control plane's metric shows it", ok: metricLag > 10, detail: `renox_cp_replication_lag_max_seconds up to ${metricLag.toFixed(1)} (RenoxReplicationLag fires above 10)` },
      { name: "the lag recovers", ok: recovered !== null, detail: recovered === null ? "still lagging 60 s after SIGCONT" : `under 5 s ${recovered.toFixed(1)} s after SIGCONT` },
    ];
    return {
      scenario: "replica-lag",
      title: "Replica lagging",
      failureModes: ["Replica lagging / Litestream behind"],
      description: `the tenant's Litestream sidecar stopped with SIGSTOP for ${FREEZE_MS / 1000} s during 10 writes per second, then SIGCONT`,
      verdict: verdictOf(checks),
      result: `max lag ${maxLag.toFixed(1)} s (metric ${metricLag.toFixed(1)}), recovered ${recovered?.toFixed(1) ?? "—"} s after SIGCONT, writes ${writes.summary()}`,
      target: "no tenant error; lag reported above 10 s while frozen; under 5 s again within 60 s",
      alerts: [{ rule: "RenoxReplicationLag", observed: metricLag > 10 ? `condition true (${metricLag.toFixed(1)} s)` : "condition not reached" }],
      checks,
      metrics: { freeze_s: FREEZE_MS / 1000, max_lag_s: maxLag, metric_lag_s: metricLag, recovered_after_s: recovered ?? -1 },
      notes: ["The control plane's lag metric is the nodes' last report, refreshed here by getBackups; the worker's own gauge comes with #295."],
    };
  });
}
