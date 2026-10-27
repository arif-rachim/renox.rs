// B20 (issue #36): CI time and renox-worker binary size, read from GitHub.
//
// ci_min: wall time of a CI run (first job start to last job end), median of
// the last N successful runs on the branch whose `rust` job ran. rust_job_min
// is reported next to it. Runs where the rust job was skipped (docs or
// TypeScript only) are not CI time for B20.
// binary_mb: size of the asset renox-worker-<version>-<target> of the newest
// `worker-v*` release; absent (and noted) while no release exists.
//
// usage: bun collect.ts <out.json> <runs>

import { summarize } from "../../lib/stats.ts";

export interface Job {
  name: string;
  conclusion: string;
  startedAt: string;
  completedAt: string;
}

export interface Asset {
  name: string;
  size: number;
}

export interface B20Result {
  id: "B20";
  scenario: string;
  notes: string;
  samples: Record<string, number[]>;
  summary: Record<string, number>;
}

const MS_PER_MIN = 60_000;

/** Wall time of one run and of its rust job, or null if the rust job did not succeed. */
export function runTimes(jobs: readonly Job[]): { ci_min: number; rust_job_min: number } | null {
  const rust = jobs.find((j) => j.name === "rust");
  if (!rust || rust.conclusion !== "success") return null;
  const ran = jobs.filter((j) => j.conclusion !== "skipped");
  const start = Math.min(...ran.map((j) => Date.parse(j.startedAt)));
  const end = Math.max(...ran.map((j) => Date.parse(j.completedAt)));
  return {
    ci_min: round((end - start) / MS_PER_MIN),
    rust_job_min: round((Date.parse(rust.completedAt) - Date.parse(rust.startedAt)) / MS_PER_MIN),
  };
}

/** The worker asset for `target`, ignoring the .sha256 files. */
export function workerAsset(assets: readonly Asset[], target: string): Asset | undefined {
  return assets.find((a) => a.name.startsWith("renox-worker-") && a.name.endsWith(`-${target}`));
}

export function build(
  times: { ci_min: number; rust_job_min: number; run: string }[],
  release: { tag: string; asset: Asset } | undefined,
): B20Result {
  if (times.length === 0) throw new Error("no successful CI run with the rust job found");
  const samples: Record<string, number[]> = {
    ci_min: times.map((t) => t.ci_min),
    rust_job_min: times.map((t) => t.rust_job_min),
  };
  const summary: Record<string, number> = {
    ci_min: summarize(samples.ci_min as number[]).p50,
    rust_job_min: summarize(samples.rust_job_min as number[]).p50,
  };
  const notes = [`CI runs: ${times.map((t) => t.run).join(", ")}`];
  if (release) {
    summary.binary_mb = round(release.asset.size / 1_048_576);
    samples.binary_mb = [summary.binary_mb];
    notes.push(`binary: ${release.asset.name} from ${release.tag}`);
  } else {
    notes.push("binary: no worker-v* release yet, binary_mb not measured");
  }
  return {
    id: "B20",
    scenario: "renox-worker release asset size; CI wall time of runs with the rust job, median of the last runs",
    notes: notes.join("; "),
    samples,
    summary,
  };
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}

interface ApiJob {
  name: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
}

/** REST only (`gh api`), so it also works where GitHub GraphQL is unavailable. */
function api(path: string): unknown {
  const p = Bun.spawnSync(["gh", "api", path], { stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`gh api ${path} failed (${p.exitCode})`);
  return JSON.parse(p.stdout.toString());
}

if (import.meta.main) {
  const [out, runsArg] = process.argv.slice(2);
  const wanted = Number(runsArg);
  if (!out || !Number.isInteger(wanted) || wanted < 1) {
    console.error("usage: bun collect.ts <out.json> <runs>");
    process.exit(2);
  }
  // `{owner}/{repo}` is filled in by gh from the current repository's remote.
  const repo = `repos/${process.env.B20_REPO ?? "{owner}/{repo}"}`;
  const branch = encodeURIComponent(process.env.B20_BRANCH ?? "main");
  const target = process.env.B20_TARGET ?? "x86_64-unknown-linux-gnu";

  const { workflow_runs: runs } = api(
    `${repo}/actions/workflows/ci.yml/runs?branch=${branch}&status=success&per_page=50`,
  ) as { workflow_runs: { id: number }[] };
  const times: { ci_min: number; rust_job_min: number; run: string }[] = [];
  for (const r of runs) {
    if (times.length >= wanted) break;
    const { jobs } = api(`${repo}/actions/runs/${r.id}/jobs`) as { jobs: ApiJob[] };
    const t = runTimes(
      jobs.map((j) => ({
        name: j.name,
        conclusion: j.conclusion ?? "",
        startedAt: j.started_at,
        completedAt: j.completed_at ?? j.started_at,
      })),
    );
    if (t) times.push({ ...t, run: String(r.id) });
  }

  // Newest first, as the API returns them.
  const releases = api(`${repo}/releases?per_page=50`) as { tag_name: string; draft: boolean; assets: Asset[] }[];
  let release: { tag: string; asset: Asset } | undefined;
  for (const r of releases) {
    if (r.draft || !r.tag_name.startsWith("worker-v")) continue;
    const asset = workerAsset(r.assets, target);
    if (asset) {
      release = { tag: r.tag_name, asset };
      break;
    }
  }

  await Bun.write(out, `${JSON.stringify(build(times, release), null, 2)}\n`);
}
