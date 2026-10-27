// B17 (issue #8): npm compatibility inside the isolate.
//
// Starts the Edge Runtime spike, sends GET /api/check to examples/npm-compat
// on a fresh pinned worker per run (so the first request also measures the
// cold import of every package), and turns the JSON into the scenario
// result: failed_packages (judged, 0 passes), per-package ms, cold total ms.
// Prints the per-package markdown table to stdout for the result file; a
// failure gets a classification and a one-line mitigation.
//
// usage: bun report.ts <out.json>
// env: BENCH_RUNS (3), EDGE_RUNTIME_MODE (source|docker)

import { summarize } from "../../lib/stats.ts";
import { callApp, round, startRuntime, stopRuntime, type Runtime } from "../../edge-runtime/lib.ts";

export interface CheckResult {
  package: string;
  version: string;
  ok: boolean;
  error?: string;
  ms: number;
}

/** Rough classification of an error text, with the mitigation to try first. */
export function classify(error: string): { kind: string; mitigation: string } {
  const e = error.toLowerCase();
  if (/native|\.node\b|addon|gyp/.test(e)) return { kind: "native addon", mitigation: "replace with a pure-JS package or a platform API (docs/16-risks.md)" };
  if (/node:[a-z_]+|cannot find module ['"]node:|not supported|unsupported.*node/.test(e))
    return { kind: "node: built-in not polyfilled", mitigation: "polyfill the built-in in the runtime or pick a package that uses web APIs" };
  if (/top-level await|top level await/.test(e)) return { kind: "top-level await", mitigation: "lazy-initialise inside the handler" };
  if (/process\.env|is not defined.*process/.test(e)) return { kind: "process.env access", mitigation: "inject configuration through ctx.secrets / ctx.config" };
  if (/could not resolve|cannot resolve|module not found|did you forget to run/.test(e))
    return { kind: "npm resolution", mitigation: "install node_modules for the app before staging (run.sh --stage does this)" };
  if (/fetch|network|dns|econn|getaddrinfo/.test(e)) return { kind: "network", mitigation: "the check must not need network; declare the host in the allowlist" };
  if (/timeout|timed out/.test(e)) return { kind: "timeout", mitigation: "the check exceeded the 2 s budget; profile the import" };
  return { kind: "other", mitigation: "open a follow-up issue with the error text (label phase:F0, track:M)" };
}

export function table(results: CheckResult[], msByPackage: Record<string, number[]>): string {
  const lines = ["| Package | Version | In the isolate | ms (median of runs) | Error |", "| --- | --- | --- | --- | --- |"];
  for (const r of results) {
    const ms = msByPackage[r.package];
    const med = ms && ms.length ? round(summarize(ms).p50) : round(r.ms);
    let err = "";
    if (!r.ok) {
      const c = classify(r.error ?? "");
      err = `${(r.error ?? "").slice(0, 160)} — ${c.kind}; ${c.mitigation}`;
    }
    lines.push(`| ${r.package} | ${r.version} | ${r.ok ? "ok" : "**fail**"} | ${med} | ${err} |`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: bun report.ts <out.json>");
    process.exit(2);
  }
  const runs = Number(process.env.BENCH_RUNS ?? 3);
  const msByPackage: Record<string, number[]> = {};
  const coldTotalMs: number[] = [];
  const warmTotalMs: number[] = [];
  let last: CheckResult[] = [];
  let runtime: Runtime | null = null;
  try {
    for (let run = 1; run <= runs; run++) {
      runtime = await startRuntime({ policy: "per_worker" });
      const worker = `b17-${run}`;
      const cold = await callApp(runtime, "npm-compat", "/api/check", worker);
      if (cold.status !== 200) throw new Error(`GET /api/check: HTTP ${cold.status} ${cold.body.slice(0, 300)}`);
      coldTotalMs.push(cold.ms);
      const warm = await callApp(runtime, "npm-compat", "/api/check", worker);
      warmTotalMs.push(warm.ms);
      last = (JSON.parse(cold.body) as { results: CheckResult[] }).results;
      for (const r of last) (msByPackage[r.package] ??= []).push(r.ms);
      console.error(`B17: run ${run}: ${last.filter((r) => r.ok).length}/${last.length} ok, cold request ${round(cold.ms)} ms, warm ${round(warm.ms)} ms (${runtime.mode})`);
      await stopRuntime();
      runtime = null;
    }
  } finally {
    if (runtime) await stopRuntime();
  }
  const failed = last.filter((r) => !r.ok);
  const summary: Record<string, number> = {
    failed_packages: failed.length,
    packages: last.length,
    cold_request_ms: round(summarize(coldTotalMs).p50),
    warm_request_ms: round(summarize(warmTotalMs).p50),
  };
  for (const [pkg, ms] of Object.entries(msByPackage)) summary[`${pkg.replace(/[^a-z0-9]+/gi, "_")}_ms`] = round(summarize(ms).p50);
  const samples: Record<string, number[]> = { cold_request_ms: coldTotalMs.map((x) => round(x)), warm_request_ms: warmTotalMs.map((x) => round(x)) };
  for (const [pkg, ms] of Object.entries(msByPackage)) samples[`${pkg.replace(/[^a-z0-9]+/gi, "_")}_ms`] = ms.map((x) => round(x));
  await Bun.write(
    out,
    `${JSON.stringify(
      {
        id: "B17",
        scenario: `examples/npm-compat GET /api/check inside a fresh Edge Runtime user worker per run (${runs} runs); cold_request_ms = first request including every package import`,
        notes: failed.length ? `failed: ${failed.map((r) => r.package).join(", ")}` : "all packages ran inside the isolate",
        samples,
        summary,
      },
      null,
      2,
    )}\n`,
  );
  console.log(table(last, msByPackage));
}
