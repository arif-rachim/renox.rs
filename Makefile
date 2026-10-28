# One entry point per task; dispatches to Cargo and Bun.
# Cargo refuses a virtual workspace with no members, so the Rust steps are
# skipped until the first crate exists under bench/spike/ (or crates/ later).

RUST_MEMBERS := $(wildcard bench/spike/*/Cargo.toml crates/*/Cargo.toml)
TS_PACKAGES := $(wildcard sdk/package.json cli/package.json control/*/package.json packages/*/package.json modules/*/package.json examples/*/package.json bench/package.json)

.PHONY: check test fmt bench rust-check rust-test ts-check ts-test docs-check

check: rust-check ts-check docs-check

test: rust-test ts-test

fmt:
ifneq ($(RUST_MEMBERS),)
	cargo fmt --all
else
	@echo "rust: no workspace members yet, nothing to format"
endif

rust-check:
ifneq ($(RUST_MEMBERS),)
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
else
	@echo "rust: no workspace members yet, skipping fmt/clippy"
endif

# CRATES="renox-cell renox-template" tests only those packages (CI on a pull
# request, #189); empty tests the whole workspace.
rust-test:
ifneq ($(RUST_MEMBERS),)
	cargo test $(if $(strip $(CRATES)),$(addprefix -p ,$(CRATES)),--workspace)
else
	@echo "rust: no workspace members yet, skipping tests"
endif

ts-check:
	bun install --frozen-lockfile
ifneq ($(TS_PACKAGES),)
	bun run check
else
	@echo "ts: no workspace packages yet, skipping check"
endif

docs-check:
	bun install --frozen-lockfile
	bun .github/scripts/check-links.ts
	bun x tsc --noEmit -p docs/contracts
	bun run docs/contracts/validate.ts

# Tests that need renox-worker (template transpile, the shop build, renox dev
# end to end) skip without RENOX_WORKER_PATH; in CI that is an error (#186).
ts-test:
ifeq ($(RENOX_WORKER_PATH),)
ifneq ($(CI),)
	@echo "ts-test: CI is set and RENOX_WORKER_PATH is not; the tests that need renox-worker must run in CI (#186)" >&2
	@exit 1
else
	@echo "ts-test: RENOX_WORKER_PATH is not set, so the tests that need renox-worker (templates, shop build, renox dev end to end) are SKIPPED."
	@echo "ts-test: to run them: cargo build -p renox-cell --bin renox-worker && export RENOX_WORKER_PATH=\$$PWD/target/debug/renox-worker"
endif
endif
	bun run test

bench:
ifndef ID
	$(error usage: make bench ID=<id> [ARGS="--runs 3"])
endif
	bench/run.sh $(ID) $(ARGS)
