# CLAUDE.md

Read `AGENTS.md` first. All rules, the documentation reading order, and the repository layout are there.

The summary you will need most often:

- Project: multi-tenant hosting platform for TypeScript applications. Rust data plane (V8 isolates on Supabase Edge Runtime, SQLite per tenant), Bun control plane.
- Status (2026-11-05, `main` at `d37a751`; the goal since 2026-11-06, D31: the platform live on `node-small` for hand-onboarded users on the free tier, without payments, entity or products): the code of F0 to F7 is on `main`; the CLI is released (`cli-v0.1.3`), the SDK is on npm (`@renoxium/sdk`), the platform runs on one host behind Cloudflare (D25, D26). Gates F0 and F1 passed, gates F2 to F7 are open on owner steps and measurements (the booking product repository, the single-host install, the first external user on the free tier; the load-generator host, PSP sandbox accounts, the entity and the products are deferred by D31), not on code. The crates `renox-gateway`, `renox-runtime`, `renox-template`, `renox-data`, `renox-authz`, `renox-realtime`, `renox-meter` and `renox-cell` (binary `renox-worker`) exist, as do `control/api`, `control/dashboard`, `control/billing`, the `renox` CLI and SDK, sixteen modules under `modules/`, `www/` and `ops/`. The open work and the prompt for each batch: `docs/25-execution.md`, "Where we are"; the per-phase table: `README.md`, "Status".
- Naming: **Renoxium** is the product and the hosting (site, dashboard, mails, invoices, the MCP resource); **`renox`** is what a developer types (CLI, crates, `renox.toml`, `RENOX_*` codes) and is not renamed; the one exception is the SDK on npm, **`@renoxium/sdk`**, because npm refuses the name `renox` (D28). Tenant apps live on `renoxium.app`, the platform's services on `renoxium.com`; `renox.rs` is only this repository's name (`README.md`, "Naming"; `docs/contracts/README.md`, "Domains").
- Architecture decisions are binding: `docs/13-decisions.md`. Change them through a new ADR, never a silent edit.
- Security: per-tenant limits are enforced in Rust; tenant `fetch` blocks private addresses; module SQL goes through the SQLite authorizer; secrets never reach logs. Threats, controls, and the per-phase security checklist: `docs/24-threat-model.md`. Every PR fills in the security section of the template.
- Workflow: pick a GitHub issue (`[Fx-nn]` key), check its "Blocked by" list is closed, work on your own branch; a session usually takes a batch of issues from `docs/25-execution.md` on one branch and one PR. Protocol and directory ownership: `docs/22-development-plan.md`. Step list and session rules: `docs/25-execution.md`.
- Language: everything in English.

## Releases

Release commits go straight to `main` with their tag: no branch, no PR (this exception is for release bumps only). Run from a clean `main` that equals `origin/main`; each command shows the diff and asks y/N before it commits, tags and pushes. `--dry-run` shows the change and reverts it; `--yes` skips the prompt; `--skip-tests` skips the local tests (typecheck still runs). On Windows the local tests are skipped (a CRLF checkout fails the cli tests on `main` too), and CI runs them after the push.

1. `bun run bump-worker <patch|minor|major|x.y.z>`: `crates/renox-cell` version (Cargo.toml and Cargo.lock), then the tag `worker-v<v>`, which runs `release-worker.yml`.
2. When that run is green: `bun run pin-worker [x.y.z]`. It writes the release's sha256 (`SHA256SUMS`, plus `SHA256SUMS.unpacked` for the pdf variant) into `PINNED_WORKER` (`cli/src/worker/verify.ts`), moves `WORKER_VERSION` and the docs, and adds a CHANGELOG line. It pushes to `main` with no tag.
3. Write the notes under `## <v> (unreleased)` in `CHANGELOG.md`, push them, then run `bun run bump-cli <patch|minor|major|x.y.z>`. It moves the CLI, create-renox and `@renoxium/sdk` together (they share the tag `cli-v<v>`, which runs `release-cli.yml` and `release-sdk.yml`), updates the install lines, `bun.lock` and `llms-full.txt`, and dates the CHANGELOG entry. `bun run bump-cli --tag-only [x.y.z]` only tags a release commit that is already on `main`.

The scripts live in `scripts/release/`, with tests in `bun test scripts/release`.
