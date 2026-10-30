// The fault-injection harness (#104, docs/23-failure-modes.md section 6):
// runs one scenario or all of them against a fresh two-node stack each, and
// writes one result file per scenario in the benchmark format.
//
//   bun bench/chaos/chaos.ts <scenario|all> <renox-worker> <out dir>
//
// Exit 1 when a scenario fails (a skipped scenario does not fail the run).

import { writeResult, type Outcome } from "./lib/result.ts";
import { run as controlPlaneDown } from "./scenarios/control-plane-down.ts";
import { run as corruptFile } from "./scenarios/corrupt-file.ts";
import { run as diskFull } from "./scenarios/disk-full.ts";
import { run as nodeKill } from "./scenarios/node-kill.ts";
import { run as pubsubDrop } from "./scenarios/pubsub-drop.ts";
import { run as replicaLag } from "./scenarios/replica-lag.ts";
import { run as storageDown } from "./scenarios/storage-down.ts";

export const SCENARIOS: Record<string, (worker: string) => Promise<Outcome>> = {
  "node-kill": nodeKill,
  "storage-down": storageDown,
  "control-plane-down": controlPlaneDown,
  "disk-full": diskFull,
  "corrupt-file": corruptFile,
  "replica-lag": replicaLag,
  "pubsub-drop": pubsubDrop,
};

if (import.meta.main) {
  const [which, worker, out] = process.argv.slice(2);
  if (which === undefined || worker === undefined || out === undefined || (which !== "all" && !(which in SCENARIOS))) {
    console.error(`usage: bun bench/chaos/chaos.ts <${Object.keys(SCENARIOS).join("|")}|all> <renox-worker> <out dir>`);
    process.exit(2);
  }
  const names = which === "all" ? Object.keys(SCENARIOS) : [which];
  let failed = 0;
  for (const name of names) {
    const started = performance.now();
    let outcome: Outcome;
    try {
      outcome = await (SCENARIOS[name] as (w: string) => Promise<Outcome>)(worker);
    } catch (e) {
      // The harness itself broke (a timeout setting up the stack, a crash): a failure with the reason.
      outcome = {
        scenario: name,
        title: "harness error",
        failureModes: [],
        description: "the scenario did not complete",
        verdict: "FAIL",
        result: e instanceof Error ? e.message : String(e),
        target: "the scenario runs to its checks",
        alerts: [],
        checks: [{ name: "scenario completed", ok: false, detail: e instanceof Error ? (e.stack ?? e.message) : String(e) }],
        metrics: {},
        notes: [],
      };
    }
    const file = writeResult(out, outcome);
    const secs = ((performance.now() - started) / 1000).toFixed(0);
    console.error(`${outcome.verdict.padEnd(7)} ${name} (${secs} s) -> ${file}${outcome.verdict === "SKIPPED" ? `: ${outcome.skipped}` : ""}`);
    for (const c of outcome.checks.filter((c) => !c.ok)) console.error(`        ✗ ${c.name}: ${c.detail}`);
    if (outcome.verdict === "FAIL") failed++;
  }
  process.exit(failed > 0 ? 1 : 0);
}
