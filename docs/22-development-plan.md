# 22 — Development plan: milestones, issues, and parallel agent sessions

This document turns `15-roadmap.md` (phases) and `18-build-plan.md` (components, tracks) into executable work: GitHub milestones, labelled issues, and a protocol for running several agent sessions on separate branches at the same time without stepping on each other.

Read it before picking up an issue. The rules in `AGENTS.md` still apply; this document only adds the workflow.

## 1. How the work is organised on GitHub

| GitHub object | Maps to | Rule |
| --- | --- | --- |
| Milestone | One phase (`F0 Spike` … `F7 External customers`) | A milestone closes only when its done criteria in `15-roadmap.md` are met and the review issue is closed |
| Issue | One unit of work that fits in one PR and one agent session | Title format `[Fx-nn][Pn] Short description`; `Fx-nn` is the stable key used in cross-references, `Pn`/`Mn` is the component from `18-build-plan.md` |
| Label `phase:Fx` | The phase | Every issue has exactly one |
| Label `track:R / T / M / O` | Rust data plane / TypeScript / modules and examples / ops and bench | Every issue has exactly one. Issues on different tracks touch disjoint directories and can run at the same time |
| Label `type:*` | `contract`, `task`, `bench`, `epic`, `review` | `contract` issues must be merged before the tasks that consume them; `epic` issues are split into tasks when their phase starts; `review` issues are the phase gate |
| Label `parallel-safe` | The issue has no unmerged dependency once its "Blocked by" list is closed | Any agent may start it as soon as the blockers are closed |

Issue bodies always have the same sections: **Context**, **Goal**, **Scope** (in / out), **Steps**, **Acceptance criteria** (checkboxes), **Dependencies** (blocked by / blocks), **Files** (owned / must not touch), **Branch**. A small model should be able to complete the issue from the body plus the documents it links.

## 2. Dependency rules that make parallel work safe

These come from `18-build-plan.md` and `12-developer-experience.md`; they are restated here because they are what allows several sessions to run at once.

1. **Contracts first.** A track may consume another track's output only through a document under `docs/contracts/` that has been merged first: op signatures (runtime ↔ SDK), artifact format and route table (cell / CLI ↔ control plane), meter record schema (meter ↔ billing), manifest schema (broker ↔ CLI ↔ modules). A contract change is its own small PR, reviewed by both consumers.
2. **Leaf crates never depend on each other.** `renox-data`, `renox-gateway`, `renox-meter`, `renox-template`, `renox-authz`, `renox-realtime` depend only on external crates. Integration happens only in `renox-cell` (and `renox-runtime` for ops). Two agents can therefore build two leaf crates at the same time with zero merge conflicts.
3. **Shared files are owned by one issue at a time.** Workspace `Cargo.toml`, root `package.json`, `.github/workflows/*`, `AGENTS.md`, `CLAUDE.md`. If your issue needs a change there (for example adding a workspace member), make it the first, tiny commit of your PR and keep it append-only, so rebases are trivial.
4. **One issue, one branch, one PR, one session.** Never work on two issues in one branch. Never let two sessions work on the same issue.
5. **Tests prove the contract.** A PR that closes an issue includes the tests listed in the acceptance criteria. Hand-offs between tracks happen through merged, tested code, never through a chat message.

## 3. Directory ownership (who may touch what)

| Track | Owns | Must not touch |
| --- | --- | --- |
| R (Rust data plane) | `crates/**`, `bench/spike/**` (Rust spikes) | `control/**`, `cli/**`, `sdk/**`, `modules/**` |
| T (TypeScript) | `sdk/**`, `cli/**`, `control/**` | `crates/**` beyond reading contracts |
| M (modules, examples) | `modules/**`, `examples/**` | Platform crates; an SDK change needed by a module lands first as a track T issue |
| O (ops, bench) | `bench/**`, `ops/**`, `.github/**`, root tool configs | Product code except test fixtures |
| Contracts | `docs/contracts/**` | Changed only by `type:contract` issues |

Within a track, two issues that touch the same crate or package must not run at the same time unless the issue bodies say they are independent (for example `renox-data` authorizer and `renox-data` migration runner touch different files and are marked parallel-safe together).

## 4. Running several agent sessions at once

### Branch and worktree convention

```
git fetch origin
git worktree add ../renox-<key> -b <track>/<key>-<slug> origin/main
# example: git worktree add ../renox-f1-05 -b r/f1-05-sqlite-authorizer origin/main
```

- Branch name: `<track letter lowercase>/<issue key lowercase>-<slug>`, for example `r/f1-05-sqlite-authorizer`, `t/f1-17-sdk-v0`, `o/f0-02-bench-harness`.
- One worktree per session so sessions do not share a working directory.
- Rebase on `origin/main` at the start of every session and before opening the PR. Small, frequent PRs beat big ones; merge order is dependency order, not creation order.

### Session protocol (what every agent does)

Start of session:

1. `git fetch origin && git rebase origin/main` on the issue branch (or create it as above).
2. Read `AGENTS.md`, then this document, then the issue body, then every document section the issue links.
3. Confirm all issues in the "Blocked by" list are closed. If one is open, stop and pick another `parallel-safe` issue.
4. Comment on the issue: "Started on branch `<name>`" so no other session takes it.

During the session:

5. Stay inside the issue's **Files: owned** list. If you need something outside it, open a new issue instead of widening scope.
6. Run the crate or package tests often: `cargo test -p <crate>` for a leaf crate (no V8), `bun test` for TypeScript.
7. Record benchmark results under `bench/results/` in the format of `14-benchmarks.md`.

End of session:

8. `cargo fmt && cargo clippy -D warnings` (Rust) or `bun run check` (TypeScript) pass locally.
9. Open a PR: title = issue title, body = `Closes #<n>` + the ADR or docs section it implements + what was measured. Use the PR template.
10. Tick the acceptance criteria in the issue that are met; comment on anything left out and why.
11. If the work revealed a contract gap or a wrong assumption in `docs/`, open an issue (type `contract` or a docs issue); do not patch the docs silently inside a feature PR unless the issue says so.

### How many sessions at once

The number of sessions that can run without conflicts is the number of `parallel-safe` issues whose blockers are closed, capped by the tracks. Practical guidance:

| Phase | Wave | Sessions that can run at the same time |
| --- | --- | --- |
| F0 | 0 | 1: repository scaffolding (everything else needs the workspace and CI) |
| F0 | 1 | 4: Edge Runtime spike (R), bench harness (O), `hello` + `npm-compat` examples (M), op/ctx contract sketch (T) |
| F0 | 2 | 4: B1 + B4 measurements (R/O), B17 npm run (M/O), transpiler prototype (R), baselines Bun/Node (O) |
| F0 | 3 | 2: B9 marshaling bench (R), first B6 render bench (R) |
| F0 | gate | 1: review, go / no-go |
| F1 | 1 | 3: artifact + route-table contract (T), meter schema contract (T/R), op contract v0 (T) |
| F1 | 2 | 6: `renox-data` (R), `renox-gateway` (R), `renox-meter` (R), `renox-runtime` embedding (R), SDK v0 (T), `evil` example (M) |
| F1 | 3 | 4: runtime limits, `fetch` SSRF, `db`/`secret`/`log` ops (R, after embedding), CLI `new`/`dev` (T), `shop` skeleton (M), CI release build (O) |
| F1 | 4 | 2: `renox-cell` integration (R), bench scripts B5/B11/B12 (O) |
| F1 | gate | 1: review |
| F2 + F3 | parallel | Track R works on templates (F2) while track T builds the control plane (F3): the two phases share only the artifact contract from F1 |
| F4 onward | per wave | Modules follow the waves W1–W6 in `18-build-plan.md` |

Rule of thumb: at any moment run one session per track at most on the same crate or package, and never more than one session per `type:contract` or `type:review` issue.

### Merge order inside a wave

Merge contracts first, then leaf crates, then integration (`renox-cell`, CLI `dev`), then benchmarks that depend on the integration. If two PRs are ready at the same time and touch a shared file, merge the smaller one first and rebase the other.

## 5. Phase gates

Each milestone ends with a `type:review` issue. The review issue:

- Lists the done criteria from `15-roadmap.md` and the benchmark IDs from `14-benchmarks.md` that must have a `PASS` result file under `bench/results/`.
- Checks the kill criteria. If a kill criterion is hit, the review issue is where the decision (continue, change direction, stop) is recorded, together with a new ADR in `13-decisions.md` if the direction changes.
- Splits the next phase's `type:epic` issues into tasks, using what the finished phase taught us. Detailed task issues are written only one phase ahead on purpose; writing F4 tasks before F1 exists produces fiction.

## 6. What F0 does and does not allow

During F0 the repository may only contain code needed to prove the F0 assumptions (`14-benchmarks.md`, "What F0 must prove"): the benchmark harness, example apps used by the benchmarks, the Edge Runtime spike, and the template transpiler prototype. Spike code lives under `bench/spike/` and `examples/`, not under `crates/`. After the F0 gate passes, prototypes are promoted into their crates by F1 issues; a prototype that failed its target is deleted, not kept.

## 7. Non-engineering items tracked alongside

Some roadmap items are not code and are tracked as issues with no track label so they stay visible: UAE free-zone incorporation and bank account (start in F1), regulatory verification items from `21-uae-gcc-strategy.md` (F6–F7), pricing decision with meter data (F7).

## 8. Issue index

Issue numbers on GitHub for each key (milestones: F0 = 1 … F7 = 8). Search by key in the issue title if this table drifts.

| Key | Issue |
| --- | --- |
| F0-01 | #1 |
| F0-02 | #2 |
| F0-03 | #3 |
| F0-04 | #4 |
| F0-05 | #5 |
| F0-06 | #6 |
| F0-07 | #7 |
| F0-08 | #8 |
| F0-09 | #9 |
| F0-10 | #10 |
| F0-11 | #11 |
| F0-12 | #12 |
| F0-13 | #13 |
| F0-14 | #14 |
| F1-01 | #15 |
| F1-02 | #16 |
| F1-03 | #17 |
| F1-04 | #18 |
| F1-05 | #19 |
| F1-06 | #20 |
| F1-07 | #21 |
| F1-08 | #22 |
| F1-09 | #23 |
| F1-10 | #24 |
| F1-11 | #25 |
| F1-12 | #26 |
| F1-13 | #27 |
| F1-14 | #28 |
| F1-15 | #29 |
| F1-16 | #30 |
| F1-17 | #31 |
| F1-18 | #32 |
| F1-19 | #33 |
| F1-20 | #34 |
| F1-21 | #35 |
| F1-22 | #36 |
| F1-23 | #37 |
| F2-01 | #38 |
| F2-02 | #39 |
| F2-03 | #40 |
| F2-04 | #41 |
| F2-05 | #42 |
| F2-06 | #43 |
| F2-07 | #44 |
| F2-08 | #45 |
| F2-09 | #46 |
| F2-10 | #47 |
| F2-11 | #48 |
| F2-12 | #49 |
| F3-01 | #50 |
| F3-02 | #51 |
| F3-03 | #52 |
| F3-04 | #53 |
| F3-05 | #54 |
| F3-06 | #55 |
| F3-07 | #56 |
| F3-08 | #57 |
| F3-09 | #58 |
| F3-10 | #59 |
| F3-11 | #60 |
| F3-12 | #61 |
| F3-13 | #62 |
| F4-01 | #63 |
| F4-02 | #64 |
| F4-03 | #65 |
| F4-04 | #66 |
| F4-05 | #67 |
| F4-06 | #68 |
| F5-01 | #69 |
| F5-02 | #70 |
| F5-03 | #71 |
| F5-04 | #72 |
| F5-05 | #73 |
| F5-06 | #74 |
| F6-01 | #75 |
| F6-02 | #76 |
| F6-03 | #77 |
| F6-04 | #78 |
| F6-05 | #79 |
| F7-01 | #80 |
| F7-02 | #81 |
| F7-03 | #82 |
| F7-04 | #83 |
| F7-05 | #84 |
| F7-06 | #85 |
| F7-07 | #86 |
| NE-01 | #87 |
