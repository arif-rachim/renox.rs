# 25 — Execution: batches

One session takes one **batch** of issues and works through them in the order listed, on one branch, ending in one PR that closes all of them. "After X" means: start the batch only after the PR of batch X is merged. Batches with the same "after" can run at the same time in separate sessions; they never touch the same crate or package.

Open Claude Code in the repository root and paste the batch's prompt. Merge with `gh pr merge <PR> --squash --delete-branch`, then remove the batch worktree if the session created one (`git worktree remove ../renox-<batch>`).

Issue #87 (UAE entity and bank account) is yours, not a session; any time during F1.

## F0 (2 sessions + gate)

### Batch A — start here (7 issues, no runtime yet)

```
Work on batch A of arif-rachim/renox.rs: issues #1, #2, #4, #5, #12, #9, #13 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch B — after A (6 issues, everything that needs the Edge Runtime)

```
Work on batch B of arif-rachim/renox.rs: issues #3, #6, #7, #8, #10, #11 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Gate F0 — after B

```
Run the gate review issue #14 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

Read the report. Kill criteria from `docs/15-roadmap.md` decide whether F1 starts.

## F1 (9 sessions + gate)

### Batch C — after gate F0 (4 contracts)

```
Work on batch C of arif-rachim/renox.rs: issues #15, #16, #17, #91 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Review this PR yourself before merging; everything in F1 is written against these files.

### Batch D — after C — renox-data (4 issues)

```
Work on batch D of arif-rachim/renox.rs: issues #18, #19, #20, #21 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch E — after C — renox-gateway (3 issues)

```
Work on batch E of arif-rachim/renox.rs: issues #22, #23, #88 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch F — after C — renox-runtime (4 issues)

```
Work on batch F of arif-rachim/renox.rs: issues #25, #26, #27, #108 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch G — after C — meter, SDK, examples, CI (5 issues)

```
Work on batch G of arif-rachim/renox.rs: issues #24, #31, #33, #36, #109 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

D, E, F, G run at the same time: four sessions, four crates or directories, no overlap. Batch G skipped #36 and #109 (blocked by #25, which was in batch F); they ran afterwards as batch G2.

### Batch H — after D, E, F, G — wiring, CLI, shop, benchmarks (7 issues)

```
Work on batch H of arif-rachim/renox.rs: issues #28, #89, #29, #30, #32, #34, #35 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch G2 — after F — CI release build and supply chain (2 issues)

```
Work on batch G2 of arif-rachim/renox.rs: issues #36, #109 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch H2 — after H — follow-ups from the F1 benchmarks, before the gate (5 issues)

```
Work on batch H2 of arif-rachim/renox.rs: issues #143, #147, #144, #145, #146 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

H2 and I run at the same time. H2 owns `cli/**`, `crates/renox-cell/**`, `crates/renox-runtime/**`, `crates/renox-data/**`; I touches only the two checklist issues.

### Batch I — after H — the two checklists

```
Work on batch I of arif-rachim/renox.rs: issues #92, #110 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions.
```

### Gate F1 — after H2 and I

```
Run the gate review issue #37 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

Ran on 2026-10-28: GO to F2 and F3 with conditions (report on #37). The conditions are applied: issues #152 to #164 created, blockers of the F2/F3 issues edited, #36, #92, #110 and #146 closed, docs and status updated.

The F1 gate ran on 2026-10-28 (#37): GO to F2 and F3 with conditions. Its issue edits, the new issues #152 to #164, and the batch changes below are applied; #36, #92, #110 and #146 are closed.

## F2 (11 sessions + gate)

Start after the F1 gate (#37) is closed. The gate report split the F1 follow-ups into #152 to #161 and moved every F2 contract edit into #152 and #153, so two contract-only batches go first. F3 runs at the same time as F2 (see below).

### Batch J0 — after gate F1 — the F2 contracts (3 issues)

```
Work on batch J0 of arif-rachim/renox.rs: issues #152, #153, #125 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Contract issues only (special case `type:contract`): artifact v1, ops 1.1.0, client events. #125 moved here from batch K. Nothing else in F2 edits `docs/contracts/**`.

### Batch H3 — after gate F1, alongside J0 — F1 carry-over and the worker release (3 issues)

```
Work on batch H3 of arif-rachim/renox.rs: issues #160, #154, #139 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

`crates/renox-cell` tests and the packaging of `renox-worker`. #36 is closed; its release criterion lives in #154. H3 shares no files with J0.

### Batch J — after J0 — renox-template and the render op (3 issues)

```
Work on batch J of arif-rachim/renox.rs: issues #38, #39, #40 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch K — after J0 — gateway protocol hardening, compression, web-layer protections (3 issues)

```
Work on batch K of arif-rachim/renox.rs: issues #107, #159, #47 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch L — after J0 — SDK page types, platform MCP, CLI negative paths (3 issues)

```
Work on batch L of arif-rachim/renox.rs: issues #44, #48, #90 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

J, K, L run at the same time: `crates/renox-template` + `crates/renox-runtime`, `crates/renox-gateway`, `sdk` + `cli`. #47 waits for #40 (the `csp_nonce` field), so if J is slower than K, K's agent skips #47 and it goes into M instead.

### Batch Y — after J and H3 — CPU accounting, isolate pool, cold-start levers (3 issues)

```
Work on batch Y of arif-rachim/renox.rs: issues #155, #156, #157 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

All three touch `crates/renox-runtime/src/isolate.rs`, `src/limits/**` and `crates/renox-cell/src/manager.rs`. Merge Y before M; if M is already open and #41 conflicts, run Y after M instead.

### Batch M — after J, K, L — pages: routing, loaders, actions, CLI transpile, shop pages (3 issues)

```
Work on batch M of arif-rachim/renox.rs: issues #41, #43, #45 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch N — after M — client errors, error pages, CSRF hardening (4 issues)

```
Work on batch N of arif-rachim/renox.rs: issues #126, #93, #127, #111 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch O — after M and Y — benchmark environment, render path B, B8, the F2 benchmarks (3 issues)

```
Work on batch O of arif-rachim/renox.rs: issues #158, #42, #46 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

N and O run at the same time. #158 first: the `node-small` host with a separate load generator is what every later number is measured on. #42 writes one ADR in `docs/13-decisions.md` (the D7 default): that is the one allowed edit of that file in F2, and only by batch O.

### Batch Z — after N and Y — streaming responses (1 issue)

```
Work on batch Z of arif-rachim/renox.rs: issues #161 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Not an F2 gate blocker; F5 SSE (#70) needs it. Run it whenever `isolate.rs` and `manager.rs` are quiet.

### Batch P — after N, O, and H3 — the two checklists (2 issues)

```
Work on batch P of arif-rachim/renox.rs: issues #94, #112 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions.
```

### Gate F2 — after P and Y

```
Run the gate review issue #49 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

## F3 (8 sessions + gate), in parallel with F2

F3 depends on F1's contracts (artifact format, route table, meter), not on F2, so batch Q starts at the same time as J0. Most of F3 lives under `control/**`, `packages/**`, and `crates/renox-cell/src/control/**`. The overlaps with F2, and the merge order for each:

| F3 issue | Shares | With (F2) | Order |
| --- | --- | --- | --- |
| #58, #113 | `cli/src/commands/**` | #90 (batch L) | merge L first; U rebases |
| #55 | `crates/renox-meter` (log sink), `crates/renox-cell/src/worker.rs` | #160, #154 (batch H3) | merge H3 first; T rebases |
| #59, #97, #162 | `crates/renox-gateway` (route table, TLS) | #107, #159, #47 (batch K) | merge K first; T and R2 rebase |
| #115, #128 | `cli/src/lib/lint.ts`, `cli/src/lib/build.ts` | #44, #90 (batch L), #43 (batch M) | merge L and M first; S and V rebase |

### Batch Q — after gate F1 — control plane core: deploy API contract, skeleton, deployments, route table, secrets (5 issues)

```
Work on batch Q of arif-rachim/renox.rs: issues #50, #51, #52, #53, #54 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

One directory (`control/api`), so one session. The contract #50 comes first and absorbs every F3 contract edit (route `version`, tiers, secret rules, sourcemap upload, node-token auth, certificate push, activation and domain states, error rows); the rest is written against it.

### Batch R — after Q — control-plane accounts (1 issue)

```
Work on batch R of arif-rachim/renox.rs: issues #113 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch S — after Q — billing ingestion, upload hardening, bundle hygiene (3 issues)

```
Work on batch S of arif-rachim/renox.rs: issues #56, #95, #115 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch T — after Q, S, and H3 — worker side: TLS, control-plane client, degraded mode, activation and route-table consistency (5 issues)

```
Work on batch T of arif-rachim/renox.rs: issues #162, #55, #98, #96, #97 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

R, S, T run at the same time once S has merged #95 (#55 uses its extraction caps). They share `control/api` but own different subdirectories; #96 and #97 touch `control/api/src/deployments/activate.ts` and `control/api/src/routes/versioning.ts` only. If the router or migration index conflicts at merge time, merge T last and rebase it.

### Batch R2 — after R and T — custom domains and domain ownership (2 issues)

```
Work on batch R2 of arif-rachim/renox.rs: issues #59, #114 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch U — after R2, S, T, H3, and batch L of F2 — deploy CLI, B15, CLI release, signed releases, remote MCP (5 issues)

```
Work on batch U of arif-rachim/renox.rs: issues #58, #60, #163, #129, #62 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

#62 needs the local MCP from #48 (batch L), #163 needs the worker release from #154 (H3), hence the two conditions.

### Batch V — after U and gate F2 — internal control-API access and the dashboard as a Renox app (3 issues)

```
Work on batch V of arif-rachim/renox.rs: issues #164, #57, #128 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

The dashboard is a Renox app with pages, so it needs F2's page model and client events (#49 closed, batch N merged). #164 decides by ADR how the dashboard tenant reaches the control API without weakening tenant SSRF rules; that ADR is the one allowed edit of `docs/13-decisions.md` in F3.

### Batch W — after V and batch P of F2 — the two checklists (2 issues)

```
Work on batch W of arif-rachim/renox.rs: issues #99, #116 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions.
```

### Gate F3 — after W

```
Run the gate review issue #61 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

## F4 to F7: what can run in parallel

These phases are still epics (one issue per block). The gate review before each phase proposes the task split; then this file gets that phase's batches with the same method. The dependencies already recorded on the epics give the shape:

| Phase | Starts after | Parallel sessions inside the phase | Why not more |
| --- | --- | --- | --- |
| F4 modules | gates F2 **and** F3 (#63 needs both) | 1 → 2 → 1: broker #63 first; then migrations #64 and module SDK #65 side by side; then `auth` #66, then `org` #67 and auth negative tests #100 | every module depends on the broker, and `org` depends on `auth` |
| F5 authz and realtime | gate F4 (#68) | 2 → 3: `renox-authz` #69 and `renox-realtime` #70 side by side; then `2fa`/`audit` #71, App MCP #73, hardening #118 side by side; `notifications`/`whatsapp` #72 after both crates | two new crates, no overlap |
| F6 reliability | gate F5 (#74) as recorded; the roadmap allows F6 alongside F4–F5 | 3: sandbox #75, replication #76, observability #77 side by side; then integrity #103, keys #120, security process #121, `jobs` #78; chaos harness #104 last | mostly ops work on nodes; the only code dependency is `jobs` on the broker |
| F7 external customers | gate F6 (#79) | 4: `billing` #80, `storage` #81, registry #84, go-to-market #85 side by side; then `email`/`reports`/`booking` #82 and `admin` #83 | modules are independent apps; `admin` needs `billing` and `storage` |

Two observations for the F2 gate to settle:

- F6's three epics only need F1 and F3 infrastructure. If the F5 gate turns out to be the bottleneck, change their "Blocked by" from #74 to #61 and start them with F4.
- F4 is the narrowest phase: one broker that everything waits for. The F3 gate report should split #63 so that the service-call part lands first and the outbox and hooks parts can follow in parallel.

## Optional: review a PR before you merge

```
Review PR #<N> of arif-rachim/renox.rs against the issues it closes. For each issue: every acceptance criterion has a test or result file in the PR; only paths in its Files section (plus tests) changed; the PR's Security section is filled in; "Differences from the issues" is present; CI is green. Run the tests of the changed packages yourself. Report MERGE or DO NOT MERGE with reasons as a list. Do not merge, do not push.
```

## Rules for the agent

This section is read by the session, not by the human. Follow it in order.

### Start

1. Read `AGENTS.md` and `CLAUDE.md`. Read every issue of the batch with `gh issue view <n> --comments`, and the documents they cite, in the order `AGENTS.md` gives.
2. For each issue, the Scope, Acceptance criteria, and Files sections are the contract. Nothing outside the batch's issues is in scope.
3. Check that every issue in each "Blocked by" list is CLOSED or is itself earlier in this batch (`gh issue view <n> --json state`). An issue whose blocker is open and not in the batch is skipped: comment "Blocked by #<n>, still open" on it and leave it out.
4. Check no issue of the batch carries the `in-progress` label. If one does, stop and say which. Otherwise add it to all of them: `gh issue edit <n> --add-label in-progress`.
5. Work on one branch for the whole batch. If your harness assigned you a branch and a checkout, use them and note it under "Differences from the issues" in the PR. Otherwise create one worktree and one branch next to the repository and work only there:
   `git worktree add ../renox-<batch> -b batch/<batch-letter>-<phase> main` (for example `batch/a-f0`).

### Per issue, in the order given

6. Implement the issue. Change only the paths in its Files section, plus tests for them. If a change outside them is needed and no issue in the batch owns that path, comment on the issue with what is needed and why, skip it, and continue with the next issue.
7. Never edit `docs/13-decisions.md`. Never edit `docs/contracts/**` unless the issue has the label `type:contract`.
8. Everything in English. Never build V8 from source. No secrets in code, tests, fixtures, or logs. The security rules in `CLAUDE.md` apply to every line.
9. The Files section is a proposed layout. If the code differs from what the issue assumes (a path, an API from an earlier issue, an error code), follow the code and record the difference for the PR description under "Differences from the issues". Do not rewrite an earlier issue's code to match a later issue's text; adapt the later one.
10. Every acceptance criterion needs a test or a result file that proves it. For a negative or security test, name the row of `docs/23-failure-modes.md` or `docs/24-threat-model.md` it proves in the test's doc comment.
11. In F0 (milestone "F0 Spike") no code goes under `crates/`; everything lives under `bench/` or `examples/`. Record measured numbers in `bench/results/<benchmark-id>.md` even when they miss the target; a missed target is a result.
12. When the issue's tests pass, commit on the batch branch with the message `[<key>] <issue title>` and a body listing what was verified. Then comment on the issue: what changed, what was verified, what is left open. Then move to the next issue.
13. If the same problem blocks you after two different attempts (tool failure, missing dependency, unclear spec, a failing test you cannot explain), comment it on the issue, remove its `in-progress` label, skip it, and continue with the next issue that does not depend on it. Never work around it and never widen the scope.
14. Never commit to `main`. Never force-push. Never merge.

### Finish

15. All tests of every changed package pass: `cargo test -p <crate>` per crate or `bun test` per package. Then `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` for Rust, or each package's lint script for TypeScript.
16. Push the branch and open one PR: `gh pr create --base main --title "Batch <letter>: <issue keys>"`. The body uses `.github/PULL_REQUEST_TEMPLATE.md`: one `Closes #<n>` line per completed issue, the commands run and their output under Verification, every line of the Security section filled in, a "Differences from the issues" list (or "None"), and a "Skipped" list naming any issue left out and why.
17. Stop. Do not merge, do not start another batch, do not delete the worktree (the human does that after merging: `git worktree remove ../renox-<batch>`).

### Special cases

- `type:contract` issue: produce the document, the schema file, and at least one valid and one invalid example per message. No implementation code. List open questions at the end of the document under "Open".
- Checklist issue (title contains "checklist"): tick a box only with a link to the test name and the commit or PR that added it. Never tick without a link. A row that cannot be done now is moved to the next phase's checklist with a one-line reason, by editing both issues. A checklist batch produces no code and no PR; it ends when both issues are updated.
- `type:review` issue (gate): collect the result files, check each done and kill criterion from `docs/15-roadmap.md`, write the report as a comment, and propose the split of the next phase's epics as draft issue bodies in a comment. Do not create issues.
