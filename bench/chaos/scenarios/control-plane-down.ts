// control-plane-down: control/api stops for 15 s, then starts again on the
// same database. docs/23 "Control plane unreachable from the worker": warm
// tenants keep serving (reads and writes) from the local route table, the
// worker reports `control_plane` degraded on /healthz, and once the API is
// back the nodes heartbeat again and stay healthy (no failover is started by
// an outage shorter than the unhealthy threshold).

import { type Check, type Outcome, verdictOf } from "../lib/result.ts";
import { Probe, sample, until, withStack } from "../lib/stack.ts";

/** Shorter than the control plane's unhealthy threshold (30 s, deploy-api.md section 7). */
const OUTAGE_MS = 15_000;

export async function run(worker: string): Promise<Outcome> {
  return withStack(worker, {}, async (s) => {
    const { victim, victimNode, bystander, bystanderNode } = await s.place();
    for (const [n, t] of [
      [victimNode, victim],
      [bystanderNode, bystander],
    ] as const) {
      const warm = await s.hit(n, t, "POST");
      if (warm.status !== 200) throw new Error(`warming ${t.id}: ${warm.status} ${warm.text}`);
    }
    const reads = new Probe(s, victimNode, victim, "GET", 200);
    const writes = new Probe(s, bystanderNode, bystander, "POST", 200);
    await s.stopApi();
    const stopped = performance.now();
    const metricsDown = (await s.metrics()) === null;
    const degraded = await until("control_plane degraded on /healthz", OUTAGE_MS + 20_000, async () => {
      const h = await s.health(victimNode);
      return h?.reasons?.some((r) => r.startsWith("control_plane")) ? (performance.now() - stopped) / 1000 : null;
    }).catch(() => null);
    const left = OUTAGE_MS - (performance.now() - stopped);
    if (left > 0) await Bun.sleep(left);
    await reads.stop();
    await writes.stop();
    const duringReads = reads.summary();
    const duringWrites = writes.summary();
    const outageOk = reads.failures === 0 && writes.failures === 0;

    await s.startApi();
    const restarted = performance.now();
    const recovered = await until("both nodes heartbeating again", 60_000, async () => {
      const m = await s.metrics();
      const healthy = s.nodes.every((n) => sample(m, `renox_cp_node_healthy{node_id="${n.node}"`) === 1);
      const fresh = s.nodes.every((n) => (sample(m, `renox_cp_node_heartbeat_age_seconds{node_id="${n.node}"`) ?? 1e9) < (performance.now() - restarted) / 1000 + 1);
      const h = await s.health(victimNode);
      return healthy && fresh && h?.status === "ok" ? (performance.now() - restarted) / 1000 : null;
    }).catch(() => null);
    // Heartbeats, not just the re-registration on reconnect, keep the nodes
    // fresh: one interval (10 s) later every heartbeat age is still small.
    await Bun.sleep(15_000);
    const m = await s.metrics();
    const ages = s.nodes.map((n) => sample(m, `renox_cp_node_heartbeat_age_seconds{node_id="${n.node}"`) ?? Number.POSITIVE_INFINITY);
    const heartbeating = ages.every((a) => a < 12);
    // Still served by the same nodes: no failover moved them.
    const after = await s.hit(victimNode, victim, "POST");
    const owner = await s.ownerOf(victim);
    const checks: Check[] = [
      { name: "warm tenants keep serving", ok: outageOk, detail: `reads on ${victimNode.node}: ${duringReads}; writes on ${bystanderNode.node}: ${duringWrites}` },
      { name: "the worker reports the outage", ok: degraded !== null, detail: degraded === null ? "no control_plane reason on /healthz" : `control_plane degraded after ${degraded.toFixed(1)} s` },
      { name: "the control plane's metrics stop answering", ok: metricsDown, detail: metricsDown ? "GET /v1/ops/metrics: no answer (RenoxControlPlaneDown)" : "the metrics endpoint still answered" },
      { name: "recovery after restart", ok: recovered !== null, detail: recovered === null ? "nodes not healthy and heartbeating within 60 s" : `both nodes healthy and heartbeating, /healthz ok, ${recovered.toFixed(1)} s after the restart` },
      { name: "heartbeats accepted after the restart", ok: heartbeating, detail: `heartbeat age 15 s later: ${s.nodes.map((n, i) => `${n.node} ${(ages[i] as number).toFixed(1)} s`).join(", ")} (interval 10 s)` },
      { name: "no failover from a short outage", ok: after.status === 200 && owner === victimNode, detail: `after the restart ${victim.id} answers ${after.status} on ${victimNode.node}; route entry on ${owner.node}` },
    ];
    return {
      scenario: "control-plane-down",
      title: "Control plane down",
      failureModes: ["Control plane unreachable from the worker"],
      description: `control/api (PGlite in a directory) stopped for ${OUTAGE_MS / 1000} s while a warm tenant takes reads and another writes, then started again on the same database`,
      verdict: verdictOf(checks),
      result: `reads ${duringReads}, writes ${duringWrites}; degraded after ${degraded?.toFixed(1) ?? "—"} s; recovered ${recovered?.toFixed(1) ?? "—"} s after the restart`,
      target: "no error for warm tenants during the outage; /healthz degraded; nodes healthy again after the restart without a failover",
      alerts: [{ rule: "RenoxControlPlaneDown", observed: metricsDown ? "metrics endpoint down during the outage" : "not observed" }],
      checks,
      metrics: { outage_s: OUTAGE_MS / 1000, read_failures: reads.failures, write_failures: writes.failures, degraded_after_s: degraded ?? -1, recovered_after_s: recovered ?? -1 },
      notes: [
        "Artifacts live in the API's memory in this stack (no S3), so a cold start of an uncached deployment during or after the outage is not exercised here; storage-down covers it with S3.",
        "An outage longer than the 30 s threshold makes the first sweep after the restart see stale heartbeats and start failovers; that case is the node-kill scenario's.",
      ],
    };
  });
}
