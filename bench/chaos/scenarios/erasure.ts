// erasure (#308): the owner deletes the tenant while its owning node is
// down. docs/23 "Tenant erasure cannot finish (owning node down, object store unreachable)": the node_drop step fails and is
// retried (every 2 s in the harness, hourly in production); when the node
// comes back the erasure finishes, the tenant's replica generations are
// purged by that node (deploy-api.md 0.4.1, nodeDropTenant with
// purge_replica), its hostname is no longer served, and a tenant on the
// other node never sees an error.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { type Check, type Outcome, verdictOf } from "../lib/result.ts";
import { Probe, until, withStack } from "../lib/stack.ts";

export async function run(worker: string): Promise<Outcome> {
  return withStack(worker, {}, async (s) => {
    const { t, session } = await s.ownedTenant("t-chaos-erase");
    const owner = await s.ownerOf(t);
    const other = s.nodes.find((n) => n !== owner);
    if (other === undefined) throw new Error("one node only");
    const bystander = await s.tenant("t-chaos-keep");
    const bystanderNode = await s.ownerOf(bystander);
    for (let i = 0; i < 5; i++) await s.hit(owner, t, "POST");
    // The writes reach the replica before the node goes away.
    const replica = join(s.root, "replica", t.id);
    await until("the tenant's replica", 30_000, async () => (existsSync(replica) && readdirSync(replica).length > 0 ? true : null));
    const probe = new Probe(s, bystanderNode, bystander, "GET");

    s.killWorker(owner);
    const del = await fetch(`${s.apiUrl}/v1/tenants/${t.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: `__Host-renox_session=${session.cookie}`, "x-renox-csrf": session.csrf },
      body: JSON.stringify({ confirm: t.id }),
    });
    const requested = performance.now();
    const view = async () =>
      (await (await fetch(`${s.apiUrl}/v1/tenants/${t.id}`, { headers: { cookie: `__Host-renox_session=${session.cookie}` } })).json()) as { erasure?: { state: string; replica_purged_at?: number | null; completed_at: number | null } };
    // While the node is down, the erasure waits for it.
    await Bun.sleep(5_000);
    const waiting = (await view()).erasure?.state ?? "none";
    await s.startWorker(owner);
    const done = await until("the erasure done", 120_000, async () => {
      const e = (await view()).erasure;
      return e?.state === "done" ? e : null;
    }).catch(() => null);
    const tookS = (performance.now() - requested) / 1000;
    const served = await s.hit(owner, t).catch(() => ({ status: 0 }));
    await probe.stop();
    const checks: Check[] = [
      { name: "the owner's request is accepted", ok: del.status === 202, detail: `DELETE answered ${del.status}` },
      { name: "the erasure waits for the node", ok: waiting === "erasing" || waiting === "pending", detail: `state ${waiting} 5 s after the request with the node down` },
      { name: "it finishes once the node is back", ok: done !== null, detail: done === null ? "not done within 120 s of the restart" : `done ${tookS.toFixed(1)} s after the request` },
      { name: "the replica generations are purged", ok: done !== null && typeof done.replica_purged_at === "number" && !existsSync(replica), detail: `replica_purged_at ${String(done?.replica_purged_at ?? null)}, ${existsSync(replica) ? "the replica directory remains" : "no replica directory left"}` },
      { name: "the hostname is no longer served", ok: served.status !== 200, detail: `GET on ${owner.node} answered ${served.status}` },
      { name: "no cross-tenant impact", ok: probe.failures === 0, detail: `bystander ${bystander.id} on ${bystanderNode.node}: ${probe.summary()}` },
    ];
    return {
      scenario: "erasure",
      title: "Erasure with the owning node down",
      failureModes: ["Tenant erasure cannot finish (owning node down, object store unreachable)"],
      description: "two controlled renox-workers, file replica, control/api with a 2 s erasure retry; the owner deletes the tenant while its node is killed, then the node restarts",
      verdict: verdictOf(checks),
      result: done === null ? "not done" : `done in ${tookS.toFixed(1)} s, replica purged, bystander ${probe.summary()}`,
      target: "the erasure finishes once the node is reachable again, with the replica purged and no impact on other tenants",
      alerts: [],
      checks,
      metrics: { done_s: done === null ? -1 : tookS },
      notes: ["Both nodes run on one host (loopback). Production retries a failed step hourly and finishes within 24 hours while the node and the store answer."],
    };
  });
}
