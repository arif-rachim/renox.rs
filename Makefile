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

rust-test:
ifneq ($(RUST_MEMBERS),)
	cargo test --workspace
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

ts-test:
	bun run test

bench:
ifndef ID
	$(error usage: make bench ID=<id> [ARGS="--runs 3"])
endif
	bench/run.sh $(ID) $(ARGS)
