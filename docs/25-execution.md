# 25 — Execution: batches

One session takes one **batch** of issues and works through them in the order listed, on one branch, ending in one PR that closes all of them. "After X" means: start the batch only after the PR of batch X is merged. Batches with the same "after" can run at the same time in separate sessions; they never touch the same crate or package.

Open Claude Code in the repository root and paste the batch's prompt. Merge with `gh pr merge <PR> --squash --delete-branch`, then `git worktree remove ../renox-<batch>`.

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

## F1 (7 sessions + gate)

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

D, E, F, G run at the same time: four sessions, four crates or directories, no overlap.

### Batch H — after D, E, F, G — wiring, CLI, shop, benchmarks (7 issues)

```
Work on batch H of arif-rachim/renox.rs: issues #28, #89, #29, #30, #32, #34, #35 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

### Batch I — after H — the two checklists

```
Work on batch I of arif-rachim/renox.rs: issues #92, #110 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions.
```

### Gate F1 — after I

```
Run the gate review issue #37 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

The report proposes the F2 task split. Create those issues, then regenerate this file for F2 with the same method: group issues by crate or directory, order by "Blocked by", one batch per group.

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
5. Create one worktree and one branch for the batch, next to the repository, and work only there:
   `git worktree add ../renox-<batch> -b batch/<batch-letter>-<phase> main` (for example `batch/a-f0`). Every command from now on runs inside that worktree.

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
