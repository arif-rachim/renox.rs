// pubsub-drop: realtime fan-out loses its pub/sub link while clients are
// connected. The realtime route kinds (`ws`, `sse`) and renox-realtime come
// with F5 (#278, #281; docs/contracts/ops.md section 18); until the crate
// exists there is nothing to break, so the scenario is skipped with that
// reason. Once crates/renox-realtime exists it fails until this file drives
// it: connect clients to a `ws` route, cut the pub/sub link, assert the
// clients get the close code of ops.md section 18 and reconnect, and that
// other tenants' connections stay up.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Outcome } from "../lib/result.ts";
import { REPO } from "../lib/stack.ts";

export async function run(_worker: string): Promise<Outcome> {
  const base = {
    scenario: "pubsub-drop",
    title: "Realtime pub/sub link dropped",
    failureModes: ["WebSocket message flood / oversized frame"],
    description: "realtime clients connected while the pub/sub link drops (F5)",
    target: "clients closed with the ops.md section 18 code and reconnect; other tenants unaffected",
    alerts: [],
    checks: [],
    metrics: {},
    notes: ["docs/23 has no row for a lost pub/sub link yet; the realtime row named is the nearest, and F5 adds the row with the crate."],
  };
  if (!existsSync(join(REPO, "crates/renox-realtime"))) {
    return { ...base, verdict: "SKIPPED", skipped: "renox-realtime does not exist yet (F5: #278, #281)", result: "" };
  }
  return {
    ...base,
    verdict: "FAIL",
    result: "crates/renox-realtime exists but this scenario does not drive it yet",
    checks: [{ name: "scenario written", ok: false, detail: "bench/chaos/scenarios/pubsub-drop.ts still has no steps for renox-realtime" }],
  };
}
