# One entry point per task; dispatches to Cargo and Bun.
# Cargo refuses a virtual workspace with no members, so the Rust steps are
# skipped until the first crate exists under bench/spike/ (or crates/ later).

RUST_MEMBERS := $(wildcard bench/spike/*/Cargo.toml crates/*/Cargo.toml)
TS_PACKAGES := $(wildcard sdk/package.json cli/package.json control/*/package.json packages/*/package.json modules/*/package.json examples/*/package.json bench/package.json)

.PHONY: check test fmt bench lighthouse journey rust-check rust-test ts-check ts-test docs-check

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

# Lighthouse of the home-services dispatch board, visit page and /book step 1 (bench/lighthouse, #725, #779);
# with the busy-day seed (200 jobs today, #728); needs RENOX_WORKER_PATH and Playwright's Chromium;
# not part of `make test`.
lighthouse:
	bun bench/lighthouse/run.ts --assert --busy

# The real-browser tests and the developer journey in Chromium (#586, #587):
# what journey.yml runs on main and nightly. RENOX_JOURNEY=1 makes a browser
# test fail instead of skip; not part of `make test`.
JOURNEY_TESTS := control/dashboard/tests/account.browser.test.ts cli/tests/browser/client-events.test.ts
# An example app's own browser tests: the root bunfig.toml ignores examples/home-services/**, so they run from the app's folder (#807, #808, #809).
JOURNEY_APP_TESTS := tests/browser/offline-read.test.ts tests/browser/offline-queue.test.ts tests/browser/offline-photos.test.ts
journey:
ifeq ($(RENOX_WORKER_PATH),)
	@echo "journey: RENOX_WORKER_PATH is not set (cargo build -p renox-cell --bin renox-worker, or bun cli/scripts/fetch-worker.ts)" >&2; exit 1
endif
ifeq ($(PLAYWRIGHT_PATH),)
	@echo "journey: PLAYWRIGHT_PATH is not set (docs/12-developer-experience.md, \"Browser tests\")" >&2; exit 1
endif
	RENOX_JOURNEY=1 bun test $(JOURNEY_TESTS)
	cd examples/home-services && RENOX_JOURNEY=1 bun test $(JOURNEY_APP_TESTS)
	# Its own process: the dashboards and workers it starts never meet another file's ports.
	RENOX_JOURNEY=1 bun test cli/tests/journey.e2e.test.ts
