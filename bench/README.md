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
