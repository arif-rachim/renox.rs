# 25 — Execution: the step list

One step = one Claude Code session = one issue. Open Claude Code in the repository root and paste the step's prompt. "After N" means: start this step only after the PR of step N is merged. Steps with the same "after" list can run at the same time in separate sessions. Merge every PR with `gh pr merge <PR> --squash --delete-branch`, then `git worktree remove ../renox-<key>`.

Issue #87 (UAE entity and bank account) is yours, not a session; do it any time during F1.

The sessions read the "Rules for the agent" section at the end of this file; you never need to.


## F0
### 1. Start here — #1 Repository scaffolding, toolchain pins, and CI
```
Work on issue #1 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 2. After 1 — #2 Benchmark harness skeleton: bench/run.sh, result template, hardware capture
```
Work on issue #2 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 3. After 1 — #4 Example app `examples/hello`: one function returning JSON
```
Work on issue #4 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 4. After 1 — #5 Example app `examples/npm-compat`: import and exercise each package from the B17 list
```
Work on issue #5 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 5. After 1 — #9 Prototype: attribute-template → minijinja transpiler (string in, string out)
```
Work on issue #9 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 6. After 1 — #12 Contract sketch: runtime op signatures and the `ctx` type surface (docs/contracts/ops.md)
```
Work on issue #12 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 7. After 1, 3 — #3 Spike: run Supabase Edge Runtime locally and serve the hello function
```
Work on issue #3 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 8. After 2 — #13 Baselines: Bun + Hono and Node + Hono hello app on the same hardware
```
Work on issue #13 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 9. After 2, 4, 7 — #6 Benchmark B1: memory per warm isolate under Supabase Edge Runtime
```
Work on issue #6 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 10. After 2, 3, 7 — #7 Benchmark B4: cold start from snapshot to first response
```
Work on issue #7 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 11. After 2, 4, 7 — #8 Benchmark B17: npm compatibility inside the isolate
```
Work on issue #8 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 12. After 2, 5, 7 — #10 Benchmark B9: V8 → minijinja::Value marshaling cost
```
Work on issue #10 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 13. After 2, 5, 12 — #11 Benchmark B6 (first cut): render the shop medium page with the minijinja prototype
```
Work on issue #11 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 14. After 8, 9, 10, 11, 12, 13 — #14 F0 gate review: record results, apply kill criteria, decide go / no-go for F1
```
Work on issue #14 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```

## F1
### 15. After 14 — #15 Contract: artifact format v0 and route table (docs/contracts/artifact.md)
```
Work on issue #15 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 16. After 14 — #16 Contract: meter record schema v0 (docs/contracts/meter.md)
```
Work on issue #16 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 17. After 6, 14 — #17 Contract: ops v0 finalised from the F0 sketch, including limits and error codes
```
Work on issue #17 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 18. After 14, 17 — #18 renox-data: open a tenant file with the required pragmas, writer + reader pool, query/execute/transaction API
```
Work on issue #18 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 19. After 14, 15 — #22 renox-gateway: HTTP listener, hostname → tenant → deployment routing, static files, per-IP rate limit
```
Work on issue #22 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 20. After 14, 16 — #24 renox-meter: per-invocation record, batching, file and stdout sinks
```
Work on issue #24 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 21. After 14, 15, 17 — #25 renox-runtime: embed Supabase Edge Runtime / deno_runtime, create an isolate from the snapshot, load an artifact, dispatch a Request to a handler
```
Work on issue #25 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 22. After 14, 17 — #31 SDK v0: the `renox` package with `ctx` types (db, fetch, secrets, log, deadline), handler types, error class
```
Work on issue #31 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 23. After 17 — #91 docs/contracts/errors.md: tenant-facing error catalogue (code, HTTP status, cause, what the tenant does, what is logged)
```
Work on issue #91 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 24. After 18 — #19 renox-data: SQLite authorizer per module prefix
```
Work on issue #19 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 25. After 18 — #20 renox-data: statement time limit, deadline propagation, and WAL checkpoint scheduling
```
Work on issue #20 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 26. After 19 — #23 renox-gateway: TLS with rustls from provided certificates, SNI per hostname, hot reload
```
Work on issue #23 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 27. After 21 — #26 renox-runtime: CPU watchdog, wall-clock deadline, heap limit, concurrency semaphore, isolate recycling
```
Work on issue #26 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 28. After 21 — #27 renox-runtime: `fetch` op with host allowlist, SSRF blocking after DNS resolution, egress byte limit
```
Work on issue #27 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 29. After 22 — #33 Example app `examples/evil`: infinite loop, unbounded allocation, SSRF attempts, slow handler
```
Work on issue #33 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 30. After 21 — #36 CI: sccache, cached target, release build of renox-worker only on crates/ changes, GitHub Release artifact, B20 measurement
```
Work on issue #36 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 31. After 19 — #88 renox-gateway: input limits — header size and count, body size per route kind, header read timeout, idle timeout, max connections per IP
```
Work on issue #88 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 32. After 24 — #21 renox-data: forward-only migration runner for the app's own migrations with checksums
```
Work on issue #21 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 33. After 18, 21, 24, 25 — #28 renox-runtime: `db`, `secrets`, `log`, `deadline` ops bridging to renox-data with error wrapping and secret redaction
```
Work on issue #28 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 34. After 28 — #108 renox-runtime: `fetch` DNS pinning (connect to the checked address), redirect re-validation, TLS verification without opt-out
```
Work on issue #108 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 35. After 30 — #109 Supply chain and CI security: cargo deny, bun audit, Dependabot, SHA-pinned actions, rusty_v8 checksum, signed releases verified by the CLI
```
Work on issue #109 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 36. After 19, 20, 25, 27, 28, 32, 33 — #29 renox-cell: wire gateway, runtime, data, meter into the `renox-worker` binary; cell lifecycle with idle eviction
```
Work on issue #29 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 37. After 27, 33 — #89 renox-runtime: roll back open DB transactions and release the writer when a request is terminated (CPU limit, OOM, deadline)
```
Work on issue #89 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 38. After 15, 36 — #30 renox-cell: artifact loader v0 from a local directory with sha256 verification and on-disk cache layout
```
Work on issue #30 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 39. After 15, 22, 36, 38 — #32 CLI v0: `renox new`, `renox dev` (embedded prebuilt worker, isolate restart on change), `renox check` (route conflicts, SQL interpolation lint), artifact builder
```
Work on issue #32 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 40. After 22, 32, 39 — #34 Example app `examples/shop` skeleton: functions only, SQLite products table, migrations, seed
```
Work on issue #34 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 41. After 29, 36, 39, 40 — #35 Benchmarks B5, B11, B2, B3 (first run) and B12 noisy neighbour on the real worker
```
Work on issue #35 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 42. After 23, 31, 37, 41 — #92 Negative path checklist F1 (blocks the F1 gate review)
```
Work on issue #92 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 43. After 19, 21, 24, 27, 28, 33, 34, 35, 38, 41 — #110 Security checklist F1 (blocks the F1 gate review)
```
Work on issue #110 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```
### 44. After 30, 36, 38, 39, 41, 42, 43 — #37 F1 gate review: two tenants on one node, B12 noisy neighbour passes, meters recorded; split F2/F3 epics
```
Work on issue #37 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from Start to Finish. Do not ask me questions; if you are blocked, do what the rules say and stop.
```

## After F1

The F1 gate review (step 44) splits the F2 epics into tasks. Regenerate this list then: the step order is the topological order of the "Blocked by" lists, one issue per step.

## Optional: review a PR before you merge

```
Review PR #<N> of arif-rachim/renox.rs against the issue it closes. Check: every acceptance criterion has a test or result file in the PR; only paths in the issue's Files section (plus tests) changed; the Security section of the PR template is filled in; "Differences from the issue" is present; CI is green. Run the tests of the changed package yourself. Report MERGE or DO NOT MERGE with reasons as a list. Do not merge, do not push.
```

## Rules for the agent

This section is read by the session, not by the human. Follow it in order.

### Start

1. Read `AGENTS.md` and `CLAUDE.md`. Read the issue with `gh issue view <N> --comments`. Read the documents the issue cites, in the order `AGENTS.md` gives.
2. The issue's Scope, Acceptance criteria, and Files sections are the contract for this session. Nothing else is in scope.
3. Check that every issue in the "Blocked by" list is CLOSED (`gh issue view <n> --json state`). If one is open, comment "Blocked by #<n>, still open" on the issue and stop.
4. Check the issue does not carry the `in-progress` label. If it does, stop and say so. Otherwise add it: `gh issue edit <N> --add-label in-progress`.
5. Take the key from the title (`[Fx-nn]`) and the branch name from the issue's Branch section. Create a worktree next to the repository and work only there:
   `git worktree add ../renox-<key> -b <branch> main` (if the branch already exists, `git worktree add ../renox-<key> <branch>`). Every command from now on runs inside that worktree.

### While working

6. Change only the paths in the issue's Files section, plus tests for them. If a change outside them is needed, stop: comment on the issue with what is needed and why, remove the `in-progress` label, and end.
7. Never edit `docs/13-decisions.md`. Never edit `docs/contracts/**` unless the issue has the label `type:contract`.
8. Everything in English. Never build V8 from source. No secrets in code, tests, fixtures, or logs. The security rules in `CLAUDE.md` apply to every line.
9. The Files section is a proposed layout. If the code on `main` differs from what the issue assumes (a path, an API from an earlier issue, an error code), follow the code and record every difference for the PR description under "Differences from the issue". Do not change another crate or package to match the issue.
10. Commit in small steps on this branch only. Never commit to `main`. Never force-push. Never merge.
11. Every acceptance criterion needs a test or a result file that proves it. For a negative or security test, name the row of `docs/23-failure-modes.md` or `docs/24-threat-model.md` it proves in the test's doc comment.
12. In F0 (milestone "F0 Spike") no code goes under `crates/`; everything lives under `bench/` or `examples/`. Record measured numbers in `bench/results/<benchmark-id>.md` even when they miss the target.
13. If the same problem blocks you after two different attempts (tool failure, missing dependency, unclear spec, a failing test you cannot explain), comment it on the issue, remove the `in-progress` label, and stop. Do not work around it and do not widen the scope.

### Finish

14. All tests of the owned package pass: `cargo test -p <crate>` or `bun test` in the package. Then `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` for Rust, or the package's lint script for TypeScript.
15. Push the branch and open the PR: `gh pr create --base main --title "[<key>] <short title>"`. The body uses `.github/PULL_REQUEST_TEMPLATE.md`: starts with `Closes #<N>`, lists the commands run and their output under Verification, fills in every line of the Security section, and has a "Differences from the issue" list (or "None").
16. Comment on the issue: what changed, what was verified, what is left open, and the PR link.
17. Stop. Do not merge, do not start another issue, do not delete the worktree (the human does that after merging: `git worktree remove ../renox-<key>`).

### Special cases

- `type:contract` issue: produce the document, the schema file, and at least one valid and one invalid example per message. No implementation code. List open questions at the end of the document under "Open".
- Checklist issue (title contains "checklist"): tick a box only with a link to the test name and the PR that added it. A row that cannot be done now is moved to the next phase's checklist with a one-line reason, by editing both issues.
- `type:review` issue (gate): collect the result files, check each done and kill criterion from `docs/15-roadmap.md`, write the report as a comment, and propose the split of the next phase's epics as draft issue bodies in a comment. Do not create issues.
