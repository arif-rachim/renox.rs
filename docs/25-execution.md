# 25 — Execution: running parallel agent sessions

`22-development-plan.md` defines the objects (issues, labels, tracks, branches). This document is the operating manual: when a wave of sessions may start, what to put in each session's prompt, the computed waves for F0 and F1, the merge routine, and what never runs in parallel.

The unit of work is one issue = one branch = one worktree = one agent session = one PR. The unit of scheduling is a **wave**: the set of issues whose blockers are all closed and that do not touch the same files.

## 1. Preconditions for starting a wave

Start sessions only when every line below is true. If one is false, fix it first; a wave started on a red `main` or on stale issue bodies produces PRs that cannot be merged.

| # | Condition | How to check |
| --- | --- | --- |
| 1 | `main` is green and your local `main` is up to date | `gh run list --branch main --limit 1`, `git pull` |
| 2 | Every issue in the wave has all numbers in its "Blocked by" list **closed** (merged PR and closed issue, not just an open PR) | `gh issue view <n>` for each blocker, or the wave script in section 3 |
| 3 | No two issues in the wave own the same crate or package. Same crate is allowed only when both issue bodies say they are independent and name different files | Compare the `Files` sections |
| 4 | No issue in the wave is `type:contract` or `type:review`, unless it is the only issue in the wave | Labels |
| 5 | Each session has its own git worktree and branch; no two sessions share a checkout | `git worktree list` |
| 6 | Issue bodies are current: paths, APIs, and error codes changed by the previous wave have been written into the issues that depend on them | Previous wave's PR descriptions list "differences from the issue"; apply them before starting |
| 7 | No issue in the wave carries the `in-progress` label from an earlier session | `gh issue list --label in-progress` |
| 8 | You can review and merge every PR the wave will produce within the same day or the next. Parallelism is capped by your merge throughput, not by the graph | Table in section 5 |

Shortcut for conditions 2 and 7:

```sh
# Issues of a milestone that are parallel-safe, not in progress, and whose blockers are all closed
gh issue list --repo arif-rachim/renox.rs --milestone "F1 Minimal data plane" --label parallel-safe --state open \
  --json number,title,body,labels --jq '
  .[] | select((.labels|map(.name)|index("in-progress"))==null)
      | {n:.number, t:.title, b:((.body|capture("Blocked by:(?<x>[^\n]*)").x // "")|[scan("#[0-9]+")])}' \
| while read -r line; do
    n=$(jq -r .n <<<"$line"); ok=1
    for d in $(jq -r '.b[]' <<<"$line"); do
      [ "$(gh issue view "${d#\#}" --repo arif-rachim/renox.rs --json state -q .state)" = CLOSED ] || ok=0
    done
    [ $ok = 1 ] && echo "ready: #$n $(jq -r .t <<<"$line")"
  done
```

## 2. The session prompt

Give every session the same prompt with four values filled in: the issue number, the key, the branch, and the worktree path. Do not paste the issue body; the session reads it with `gh`. Do not add your own summary of the task; the issue is the task.

```
You are working on GitHub issue #<N> (key <KEY>) of arif-rachim/renox.rs.
Worktree: <PATH>   Branch: <track>/<key>-<slug>   Base: main

First, read AGENTS.md and the documents the issue cites, in the reading order AGENTS.md gives.
Then read the issue with `gh issue view <N>` and its comments. The issue's Scope, Acceptance
criteria, and Files sections are the contract for this session. Add the label `in-progress`
to the issue when you start (`gh issue edit <N> --add-label in-progress`).

Rules
1. Change only the paths in the issue's Files section, plus tests for them. If you need a
   change outside them, stop: comment on the issue with what you need and why, and end.
2. Never edit docs/13-decisions.md. Never edit docs/contracts/** unless the issue is
   type:contract. Never edit another issue's files "while you are there".
3. Everything in English. Never build V8 from source. No secrets in code, tests, fixtures,
   or logs. Security rules in CLAUDE.md apply to every line you write.
4. The Files section is a proposed layout. If the code on main differs from what the issue
   assumes (a path, an API from an earlier issue, an error code), follow the code and record
   the difference in the PR description under "Differences from the issue". Do not change
   the other crate or package to match the issue.
5. Commit in small steps on this branch only. Never commit to main. Never force-push.
   Never merge.
6. Every acceptance criterion needs a test or a result file that proves it. Name the row of
   docs/23-failure-modes.md or docs/24-threat-model.md each negative or security test proves.
7. If the same problem blocks you after two different attempts (tool failure, missing
   dependency, unclear spec, failing test you cannot explain), write it as a comment on the
   issue and stop. Do not work around it and do not widen the scope.

Done means, in this order:
  a. Every acceptance criterion has a passing test (`cargo test -p <crate>` or `bun test`
     in the owned package) or a result file under bench/results/; the commands and their
     output are in the PR description.
  b. `cargo fmt --check`, `cargo clippy -D warnings` (Rust) or `bun run lint` (TypeScript)
     pass for the owned package.
  c. Open a PR with `gh pr create --base main` using the repository template. Title
     `[<KEY>] <short title>`. Body starts with `Closes #<N>`, fills in the Security section,
     and lists "Differences from the issue" (or "None").
  d. Comment on the issue: what changed, what was verified, what is left open.
  e. Stop. Do not merge, do not start another issue.
```

Variants for the four kinds of issue (add one paragraph to the prompt above):

| Issue kind | Add to the prompt |
| --- | --- |
| F0 spike or `type:bench` | "This is F0: no code under `crates/`. Put everything under `bench/` or `examples/` as the issue says. Record the measured numbers in `bench/results/<id>.md` even when they miss the target; a missed target is a result, not a failure. Do not tune past what the issue asks." |
| `type:contract` | "Produce the document, the schema file, and at least one valid and one invalid example per message. No implementation code. The PR is reviewed by a human before anything consumes it; list open questions at the end of the document under 'Open'." |
| Negative path or security checklist | "Tick a box only with a link to the test name and the PR that added it. Never tick without a link. A row that cannot be done now is moved to the next phase's checklist with a one-line reason, by editing both issues." |
| `type:review` (gate) | Runs alone, with you in the loop. "Collect the result files, check each done criterion and kill criterion from `docs/15-roadmap.md`, write the report as a comment, propose the split of the next phase's epics as draft issue bodies in a comment. Do not create issues; I will." |

Two sessions that are useful between waves and are not issues:

- **Docs sync** after a wave merges: "Run the `docs-gap-report` skill against the merged code and post the result; do not change files." Then apply what matters by hand or as a small PR.
- **Conflict fix** when a PR falls behind `main`: the `fix-conflicts` skill, one PR per session.

## 3. Waves for F0 and F1

Computed from the "Blocked by" lists on 2026-10-27; recompute with the snippet in section 1 when issues change. A wave starts when the previous one is **merged**, not when its PRs are open. Issues in braces `{a → b}` share a crate and run in one session, one after the other.

### F0 (milestone 1)

| Wave | Sessions | Issues |
| --- | --- | --- |
| 1 | 1 | #1 scaffolding, toolchain pins, CI |
| 2 | 5 | #2 bench harness (O) · #4 `examples/hello` (M) · #5 `examples/npm-compat` (M) · #9 template transpiler prototype (R) · #12 ops contract sketch (T) |
| 3 | 2 | #3 Edge Runtime spike (R) · #13 Bun/Node baselines (O) |
| 4 | 4 | #6 B1 memory · #7 B4 cold start · #8 B17 npm compat · #10 B9 marshaling |
| 5 | 1 | #11 B6 first cut |
| 6 | you + 1 | #14 gate review: results, kill criteria, split F1 if anything changed |

F0 is small on purpose. Waves 2 and 4 are where parallelism pays; the rest is serial.

### F1 (milestone 2)

| Wave | Sessions | Issues |
| --- | --- | --- |
| 1 | 3 (+ you on #87) | #15 artifact contract · #16 meter contract · #17 ops contract. Three different files under `docs/contracts/`; review and merge all three before wave 2 |
| 2 | 6 | #18 renox-data open/pool (R) · #22 gateway listener/routing (R) · #24 renox-meter (R) · #25 runtime embed (R) · #31 SDK v0 (T) · #91 errors catalogue contract (T) |
| 3 | 5 | {#19 authorizer → #20 statement limits} (renox-data) · {#23 TLS → #88 input limits} (renox-gateway) · {#26 limits → #27 fetch} (renox-runtime) · #33 `examples/evil` (M) · #36 CI caching (O) |
| 4 | 3 | #21 migrations (renox-data) · {#28 db/secrets/log ops → #108 fetch DNS pinning} (renox-runtime) · #109 supply chain and CI (O) |
| 5 | 2 | #29 renox-cell wiring · #89 transaction rollback on termination (runtime) |
| 6 | 1 | #30 artifact loader |
| 7 | 1 | #32 CLI v0 |
| 8 | 1 | #34 `examples/shop` skeleton |
| 9 | 1 | #35 benchmarks B5/B11/B2/B3/B12 |
| 10 | 2 | #92 negative path checklist · #110 security checklist |
| 11 | you + 1 | #37 gate review |

Waves 5 to 9 are the critical path and are serial by nature (cell → loader → CLI → example → benchmark). Do not try to parallelise them by starting #32 before #30 is merged; the CLI embeds the worker and will be written against a binary that does not exist yet. Use that time for the docs sync, for reviewing, and for the non-engineering issue #87.

Four crates are created in wave 2 at the same time. To avoid four conflicting edits to the root `Cargo.toml`, #1 must set `members = ["crates/*", "bench/spike/*"]` in the workspace and the Bun workspace to `["sdk", "cli", "control/*", "modules/*", "packages/*"]`, so adding a crate or package never touches a shared file. `Cargo.lock` conflicts are resolved by taking `main`'s lockfile and rebuilding, never by hand-merging.

## 4. Starting, watching, and merging a wave

Start, per issue:

```sh
KEY=f1-04; N=18; BR=r/$KEY-data-open-pool
git -C ~/workspace/renox.rs worktree add ~/workspace/renox-$KEY -b $BR main
# open a session in ~/workspace/renox-$KEY with the prompt from section 2
```

Watch, a few times a day:

```sh
gh pr list --repo arif-rachim/renox.rs --json number,title,statusCheckRollup,isDraft
gh issue list --repo arif-rachim/renox.rs --label in-progress --json number,title,comments --jq '.[] | "\(.number) \(.title) comments=\(.comments|length)"'
```

A session that stopped with a blocker comment is not restarted with "try harder". Read the blocker, fix the cause (usually a stale issue body or a missing contract detail), update the issue, and start a fresh session.

Merge, in the order the wave table lists the issues (lower layer first):

1. Read the PR's "Differences from the issue" and its Security section before the diff.
2. CI green, acceptance criteria each linked to a test. If a criterion has no test, request it; do not merge "to unblock".
3. Squash merge. `Closes #N` closes the issue; remove `in-progress` if it is still there.
4. Delete the branch and the worktree: `git worktree remove ~/workspace/renox-$KEY`.
5. If other PRs of the wave now conflict, run the conflict-fix session on each.
6. When the last PR of the wave is merged: pull `main`, run the docs sync session, write any path or API differences into the next wave's issue bodies, then start the next wave.

## 5. How many sessions at once

The graph allows up to six sessions in F1 wave 2. The limiting factor is review. Rules of thumb for one reviewer:

| Your available review time per day | Sessions at once |
| --- | --- |
| Under 1 hour | 2 |
| 1 to 3 hours | 3 or 4 |
| A full day | 5 or 6 |

A PR that waits more than two days for review falls behind `main` and costs a conflict session; it is cheaper to start fewer sessions.

## 6. What never runs in parallel

- Two sessions in one crate or package, unless both issue bodies say they are independent and name different files.
- A `type:contract` issue with anything that consumes that contract.
- A gate review with anything else in its phase.
- Two sessions that both edit a shared root file (`Cargo.toml` workspace, root `package.json`, `.github/workflows/*`, `AGENTS.md`). Assign such edits to one issue per wave.
- Anything on a red `main`.

## 7. When to stop a wave

- A kill criterion from `15-roadmap.md` is hit at a gate: stop, decide, record an ADR.
- Two sessions interpret a contract differently: stop both, fix the contract in a `type:contract` PR, restart.
- `main` turns red: no new sessions until it is green.
- A session widened its scope (files outside its issue): close the PR, split what is useful into the right issues, restart.
