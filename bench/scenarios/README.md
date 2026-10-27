# Adding a scenario

One directory per benchmark ID: `bench/scenarios/<ID>/run.sh` (executable). `bench/run.sh <ID>` finds it by that path; any other ID is rejected with the list of available ones.

## Environment `bench/run.sh` gives the scenario

| Variable | Meaning |
| --- | --- |
| `BENCH_ID` | The ID, for example `B4` |
| `BENCH_PROFILE` | `node-small` or `dev-laptop` (`docs/14-benchmarks.md`, "Reference hardware") |
| `BENCH_RUNS` | Number of runs (default 3); the scenario repeats its measurement this many times |
| `BENCH_OUT` | Path the scenario must write, `bench/results/raw/<date>-<ID>.json`, relative to the repo root (the working directory) |

## What the scenario must write to `$BENCH_OUT`

```json
{
  "id": "B4",
  "scenario": "optional one-line description; defaults to the one in targets.json",
  "notes": "optional",
  "samples": { "cold_start_ms": [12.1, 13.4] },
  "summary": { "p50_ms": 12.7, "p99_ms": 31.0 }
}
```

- `samples`: raw measurements, one array per series (ms, µs, bytes, ...).
- `summary`: the numbers judged against `bench/targets.json`. Keys must match the metric names under that ID (`p50_ms`, `rss_delta_mb`, ...); extra keys are printed but not judged.
- Compute percentiles with `bench/lib/stats.ts` (`summarize()` from TypeScript, or `bun bench/lib/stats.ts samples.json` from shell) so every scenario uses the same nearest-rank method.

## Rules

- `set -euo pipefail`, shellcheck-clean, exit non-zero on any failure.
- Follow the methodology in `docs/14-benchmarks.md` (warm-up, 60 s measurement, median of runs).
- Load generators (`oha`, `wrk`) are installed by hand; check for them and fail with an install hint.
- `bench/run.sh` prints the result template; paste it into `bench/results/YYYY-MM-DD-<ID>-<short-desc>.md`, even when the target is missed.
- `B0` is the harness self-test and the smallest working example.
