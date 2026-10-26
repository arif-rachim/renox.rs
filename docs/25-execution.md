# 25 — Execution: copy-paste prompts for agent sessions

Three prompts. You only ever change the issue or PR number. Open each session with Claude Code in the repository root; the session creates its own worktree, so several sessions can run at the same time from the same checkout.

## Prompt 1 — which issues can I start now?

Paste in any session:

```
Read docs/25-execution.md section "Rules for the agent". Then list the issues of arif-rachim/renox.rs that I can start right now: open, label parallel-safe, no label in-progress, and every issue in their "Blocked by" list is CLOSED. Group them so that issues owning the same crate or package are in one group (read the Files section of each). Print one line per group: the issue numbers, the track, and a one-line summary. Tell me how many sessions that is. Do not start any of them.
```

## Prompt 2 — work on one issue

Paste in a new session, change only the number:

```
Work on issue #18 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent" exactly, from "Start" to "Finish". Do not ask me questions; if you are blocked, do what the rules say and stop.
```

For a group with two issues in the same crate (for example `{#26 → #27}`), paste the same prompt with the first number; when its PR is merged, paste it again with the second.

## Prompt 3 — review a PR before merging

Paste in any session, change only the number:

```
Review PR #<N> of arif-rachim/renox.rs against the issue it closes. Check: every acceptance criterion of the issue has a test or result file in the PR; only paths in the issue's Files section (plus their tests) changed; the PR template's Security section is filled in; "Differences from the issue" is present; CI is green. Then run the tests of the changed package yourself. Report MERGE or DO NOT MERGE with the reasons as a list. Do not merge, do not push.
```

You merge with squash (`gh pr merge <N> --squash --delete-branch`). `Closes #<N>` in the PR body closes the issue. After the last PR of a group is merged, run Prompt 1 again.

Keep at most as many sessions open as PRs you can review the same day. If you cannot review that day, start fewer sessions.

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
