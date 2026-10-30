// node-kill (B18): the node that owns a tenant dies with SIGKILL after 10 s
// of writes. docs/23 "Node dies": the tenant is restored on the other node
// from Litestream before its routes move (FO1-FO4); RTO ≤ 60 s and RPO ≤ 10 s
// (docs/14 B18); a tenant on the surviving node never sees an error.

import { type Check, type Outcome, verdictOf } from "../lib/result.ts";
import { Probe, sample, until, withStack } from "../lib/stack.ts";

export async function run(worker: string): Promise<Outcome> {
  return withStack(worker, {}, async (s) => {
    const { victim, victimNode, bystander, bystanderNode } = await s.place();
    const survivor = s.nodes.find((n) => n !== victimNode);
    if (survivor === undefined || bystanderNode === victimNode) throw new Error("every tenant landed on one node; rerun");
    const probe = new Probe(s, bystanderNode, bystander, "POST");
    let lastAck = 0;
    let lastAckAt = 0;
    const end = performance.now() + 10_000;
    while (performance.now() < end) {
      const r = await s.hit(victimNode, victim, "POST");
      if (r.status === 200 && typeof r.body?.id === "number") {
        lastAck = r.body.id;
        lastAckAt = Date.now();
      }
    }
    s.killWorker(victimNode);
    const killed = performance.now();
    const unhealthyAfter = await until("RenoxNodeUnhealthy's condition", 120_000, async () =>
      sample(await s.metrics(), `renox_cp_node_healthy{node_id="${victimNode.node}"`) === 0 ? (performance.now() - killed) / 1000 : null,
    );
    const restored = await until("the tenant on the surviving node", 180_000, async () => {
      const r = await s.hit(survivor, victim);
      return r.status === 200 ? r.body : null;
    }).catch(() => null);
    const rto = restored === null ? Number.POSITIVE_INFINITY : (performance.now() - killed) / 1000;
    // Failover needs a healthy candidate: the survivor's heartbeats must be accepted.
    const metrics = await s.metrics();
    const survivorHealthy = sample(metrics, `renox_cp_node_healthy{node_id="${survivor.node}"`);
    const survivorAge = sample(metrics, `renox_cp_node_heartbeat_age_seconds{node_id="${survivor.node}"`);
    const restoredId = Number(restored?.id ?? 0);
    const rpo = restored === null ? Number.POSITIVE_INFINITY : Math.max(0, (lastAckAt - Number(restored.at ?? 0)) / 1000);
    await probe.stop();
    const checks: Check[] = [
      { name: "RTO ≤ 60 s", ok: rto <= 60, detail: restored === null ? `no 200 on ${survivor.node} within 180 s of SIGKILL` : `${rto.toFixed(1)} s from SIGKILL to the first 200 on ${survivor.node}` },
      { name: "the surviving node stays healthy", ok: survivorHealthy === 1, detail: `renox_cp_node_healthy ${String(survivorHealthy)}, heartbeat age ${survivorAge?.toFixed(1) ?? "—"} s` },
      { name: "RPO ≤ 10 s", ok: rpo <= 10, detail: restored === null ? `nothing restored (${lastAck} rows acknowledged)` : `${rpo.toFixed(2)} s (${Math.max(0, lastAck - restoredId)} of ${lastAck} acknowledged rows not restored)` },
      { name: "no cross-tenant impact", ok: probe.failures === 0, detail: `bystander ${bystander.id} on ${bystanderNode.node}: ${probe.summary()}` },
      { name: "detected by the control plane", ok: unhealthyAfter <= 60, detail: `renox_cp_node_healthy = 0 after ${unhealthyAfter.toFixed(1)} s` },
    ];
    return {
      scenario: "node-kill",
      title: "Node killed",
      failureModes: ["Node dies"],
      description: "two controlled renox-workers, control/api sweeping every 5 s (unhealthy after 30 s), file replica; the owner of a tenant killed with SIGKILL after 10 s of writes (B18)",
      verdict: verdictOf(checks),
      result: `RTO ${restored === null ? "> 180" : rto.toFixed(1)} s, RPO ${restored === null ? "—" : rpo.toFixed(2)} s, ${Math.max(0, lastAck - restoredId)} rows lost, bystander ${probe.summary()}`,
      target: "RTO ≤ 60 s, RPO ≤ 10 s (B18), no error for a tenant on the surviving node",
      alerts: [{ rule: "RenoxNodeUnhealthy", observed: `condition true after ${unhealthyAfter.toFixed(1)} s` }],
      checks,
      metrics: { rto_s: restored === null ? -1 : rto, rpo_s: restored === null ? -1 : rpo, rows_lost: Math.max(0, lastAck - restoredId), rows_acknowledged: lastAck, detection_s: unhealthyAfter },
      notes: ["Both nodes run on one host (loopback); the two-host B18 run is O3 (#158)."],
    };
  });
}
