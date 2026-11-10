# bench

Benchmark scenarios and results for `docs/14-benchmarks.md`.

## Linker setup

`.cargo/config.toml` links through `.cargo/linker.sh`, which uses `mold` when it is on `PATH` and otherwise lld (rustc ships `rust-lld` on x86_64 Linux, so nothing needs installing for the fallback).

Install mold for faster links:

- Debian/Ubuntu: `sudo apt-get install mold`
- Fedora: `sudo dnf install mold`
- Arch: `sudo pacman -S mold`
- From source or other systems: <https://github.com/rui314/mold#how-to-build>

On macOS the default Apple linker is used; nothing to configure.

## Running a benchmark

```
bench/run.sh <ID> [--profile node-small|dev-laptop] [--runs 3]
```

It captures hardware and tool versions (`lib/hwinfo.sh`), runs `scenarios/<ID>/run.sh`, writes raw JSON under `results/raw/`, and prints the result template with PASS/FAIL computed from `targets.json`. Add a scenario: [`scenarios/README.md`](scenarios/README.md).

`bench/run.sh B0` is a self-test that needs only Bun.

## Lighthouse (home-services)

```
RENOX_WORKER_PATH=<renox-worker> make lighthouse
RENOX_WORKER_PATH=<renox-worker> bun bench/lighthouse/run.ts [--assert] [--runs 3] [--out bench/results]
```

Starts `examples/home-services` under `renox dev` with the demo seed, signs in through the login form as the Dubai dispatcher and as the technician Ali (Playwright's Chromium, `PLAYWRIGHT_PATH` if the package is not on the module path), and runs Lighthouse (Node API, run by `node`; the phone profile with Lighthouse's default mobile emulation and throttling; categories accessibility and performance) on `/dispatch` and the technician's first scheduled visit `/me/visits/<job id>`, each in English and with `?lang=ar`. Writes `results/<date>-lighthouse-home-services.md` (median of the runs: scores, LCP, TBT, CLS, total bytes) and the raw reports under `results/raw/lighthouse/<date>/`.

`make lighthouse` passes `--assert`: exit 1 when a median accessibility is under 90 or a performance under 80, naming the target and the category. The nightly [`lighthouse.yml`](../.github/workflows/lighthouse.yml) runs it and uploads the files; it is not part of `make test` or the PR checks. Note that the page is measured as `renox dev` serves it (the dev client script included), on the machine that runs it: compare results from the same place.

## Provisioning `node-small` (#158)

The reference node of `docs/14-benchmarks.md` ("Reference hardware"): 4 vCPU, 8 GB, SSD, Linux 6.x. What the first `node-small` (an Ubuntu 24.04 KVM VPS, 2026-10-30) needed before `bench/run.sh` and `bench/chaos/run.sh` ran:

```sh
sudo apt-get install -y build-essential pkg-config clang lld cmake protobuf-compiler unzip curl ca-certificates docker.io docker-compose-v2
curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal   # rust-toolchain.toml picks 1.99.1
curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4
export RUSTY_V8_ARCHIVE=$(ops/v8-archive.sh fetch x86_64-unknown-linux-gnu ~/bench-tools/rusty_v8)   # prebuilt V8, verified; never built from source
PATH=$(dirname "$(ops/scripts/fetch-litestream.sh x86_64-unknown-linux-gnu ~/bench-tools/bin)"):$PATH
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker
export RENOX_WORKER_PATH=$PWD/target/release/renox-worker
```

The release build takes about 34 minutes and 2.4 GB of memory at `-j 3` on 8 GB; run one build at a time. Before each run check free disk (stop below 20 % free) and memory, and run one benchmark at a time. Run long benchmarks detached from the terminal session (`setsid nohup …`): a run that is a child of an interactive session ends with it, and leaves an orphaned `renox-worker` behind.

Scenarios that drive load (B4, B11, B12, B6, B7, B14, B18) need the second host, the load generator with `oha`, reachable over SSH without a prompt (`BENCH_LOADGEN_SSH`); a number measured with the load on `node-small` itself is not recorded. B1 and the chaos harness run on `node-small` alone.
