# 25 — Execution: batches

One session takes one **batch** of issues and works through them in the order listed, on one branch, ending in one PR that closes all of them. "After X" means: start the batch only after the PR of batch X is merged. Batches with the same "after" can run at the same time in separate sessions; they never touch the same crate or package.

Open Claude Code in the repository root and paste the batch's prompt. Merge with `gh pr merge <PR> --squash --delete-branch`, then remove the batch worktree if the session created one (`git worktree remove ../renox-<batch>`).

Issue #87 (UAE entity and bank account) is yours, not a session; it is needed before the first external tenant (F3 done criteria).

Prompts of finished batches are kept as the record of what ran; the status line under each heading says what happened.

## Where we are (2026-11-05, after SINGLE-HOST-2 and F7-63; `main` at `d37a751`)

Every session that ran on 2026-11-05 before these four batches was cancelled and its branch lost; the tracker was cleaned the same day, and #455 to #464 are the issues filed then. The four batches marked "Started 2026-11-05" below run now, side by side. PR #463 (#462, the CLI on macOS) and PR #467 (the 0.1.3 release commit) merged while they ran.

| Phase | Done (PR) | Running | Next |
| --- | --- | --- | --- |
| F0 | A #130, B #131 #132, gate #133 (GO) | — | — |
| F1 | C #134, D #136, E #137, F #138, G #135, G2 #140, H #148, H2 #151, I (checklists), gate #165 (GO) | — | — |
| F2 | J0 #172, H3 #171, H4 #190, J #178, K #176, L #177, M #185, N #191, O #197 (#42 only), O2 #195, Y #198, Y2 #204 (#201, #157, #111), Y3 #210 (#207, #139 Linux arm64), Y4 #211, Y5 #246, P (checklists #94 full, #112 19 of 23), X #250 (#166), O3-HOST #345 (#158: B1 on `node-small`), O5 #360 (#46: B9, B13; B2), the macOS CPU clock #357 #369 #371 #374 #375 (#212 and #361 closed), O4-HOST #378 (#342 all but one criterion; #343 measured, closed on 2026-11-05 with its bisect moved to #457); #158 and #46 closed on 2026-11-05, their load-generator runs moved to #456 | — | On `node-small`: #342's last criterion (B1 three runs in a row) and the `shop` RSS bisect #457; B4, B6, B7, B11, B12 on the load-generator host (#456, the successor of #158 and #46); gate #49 after them and the four open rows of #112 |
| F3 | Q #169, R #183, S #181, T #196 (#162 only), U0 #194, R2 #203, T2 #205, U #209 (#58, #60, #62), U2 #215, V #216 (#164 only), V2 #220 (#57 except its logs screen), T3 #221, V3 #245 (#128 except two criteria), W (checklists #99 13 of 17, #116 17 of 27), X #250 (#128 rest), #261 in F6-ALL #270, #267 in F4-X #271, U3 in F7-44 #436 (#219: the CLI pins the signed `worker-v0.3.0`), HOST-CONTROL #408 (#396, #398, #402) | GREEN-CI (#382, the rollback e2e test) | Gate #61 after #49's bench runs (#57's two open criteria and the #99/#116 moves are operator steps for that gate) |
| F4 | F4-0 #247 (#225, #227), F4-ALL #262 (the 19 tasks; epics #63–#67 closed), F4-X #271 (#263–#268), P4 (checklists #101 9 of 10, #117 8 of 14), the two P4 leftovers #274 (F6-B #300) and #275 (F5-ALL #301) | — | Gate #68 (needs the booking product repo) |
| F5 | C5 #299 (#272, #273), F5-ALL #301 (the 22 issues; epics #69, #71, #72, #73 closed), F56-ALL #314 (#305), F67-ALL #340 (#307) | — | Gate #74 after the B14 run (#456) |
| F6 | F6-ALL #270, C5 #299, F6-B #300, F56-ALL #314, F67-ALL #340, F67-B #344 (epics #75, #77, #78 closed), O3-HOST #345 (#312, #256; epic #76 closed), JOBS-CLOCK #365 (#362), #367 (#359), #373 | GREEN-CI (#389, the weekly chaos run; #464, the bootstrap `--upgrade` flake) | Gate #79 after #74, the B18 two-host run (#456), the `ops/` code-owner reviews and one green weekly chaos run |
| F7 | F67-ALL #340, F67-B #344, C7 #347 (#346), F67-C #348 (#325, #332), F67-D #349 (#123, #336), F7-STRIPE #352 (#350, #351), GREEN-MAIN #358 (#356), DOMAINS #368 #370 (#363, #364), SDK-DOCS #379 (#376, #377), BINARY-SIZE #380 #383 (#372), SINGLE-HOST #386 (#385, #366 partly; #366 closed on 2026-11-05 after HOST-OPS, HOST-WORKER, HOST-CONTROL and SINGLE-HOST-2, its owner steps moved to #458), #388 (#387), #390, renox-ui #384 (D24), HOST-CONTROL #408, HOST-OPS #409 (#393, #394, #395, #397, #399, #405), HOST-WORKER #412 (#391, #392, #401, #404), F7-38 CF-EDGE #422 #423 #425 (#414, #416–#420, #424; epic #421 closed; D25, D26), F7-39 DOTMATRIX #432 #439 (#426–#428; epic #429 closed; D27), F7-44 #433–#438 (#431, #219; D28; `cli-v0.1.0`, `cli-v0.1.1`), ONBOARD-1 #452 (#443–#450), SINGLE-HOST-2 #453 (#400, #403, #406, #407), F7-63 #463 #467 (#462: `renox test` on macOS); `cli-v0.1.2` and `cli-v0.1.3` released 2026-11-05 | DOCS-SYNC (#461), HEARTBEAT-KEYS (#454, #460, #451), TUTORIAL (#430) | Not in a batch yet: #381 (`ctx.pdf` on the released worker), #440 (the CLI on npm), #441 (native Windows CLI), #442 (epic: the worker on Windows); gate #86 needs the products launched and the first paying tenant |

**Waits on the owner** (no session can do these; each issue says what is needed):

| Issue | What the owner does |
| --- | --- |
| #455 | `cli-v0.1.2` and `cli-v0.1.3` are out (the Mac run of the quickstart found #462, fixed in 0.1.3); what is left is the quickstart transcript from a clean machine with the released installer |
| #456 | The load-generator host (SSH address in the issue); then a session runs B4, B6, B7, B11, B12, B14, B18 and the Hono baseline |
| #457 | A `node-small` session for the bisect of the `shop` isolate RSS |
| #458 | The install on `node-small` from `ops/single-host.md` and the Cloudflare cut-over (tunnel, DNS, R2, Resend) |
| #459 | The ADR on data residency for tenant replicas in R2 |
| #330, #337 | The PSP sandbox accounts (Checkout.com, Telr, PayTabs, N-Genius, Tabby, Tamara); #337 follows #330 |
| #49, #61, #68, #74, #79, #86 | The gate reviews, in the order below; #68 needs the booking product repository, #86 the first paying tenant |
| #94, #112, #99, #116, #101, #117, #102, #119, #105, #122, #106, #124 | The checklists: the owner confirms the ticked and moved rows at each phase's gate |
| #87 | The UAE entity and bank account |

Issues created since 2026-11-01, outside the batches that filed them: #381 and #382 (from BINARY-SIZE), #385 (the Resend mailer, in SINGLE-HOST), #387 (F7-42, PR #388), #389 (the weekly chaos run that failed on 2026-11-02), #391–#407 (the findings of the first install on `node-small`, run in HOST-WORKER, HOST-OPS, HOST-CONTROL and SINGLE-HOST-2), #414–#421 and #424 (the Cloudflare edge), #426–#429 (the dot-matrix design), #430 (the tutorial), #431 (the first CLI release), #440–#442 (npm and Windows), #443–#450 (ONBOARD-1), #451 (from ONBOARD-1), and #454–#464 (filed on 2026-11-05 after the cancelled sessions). Not from an issue: #384 (renox-ui and the landing page), #390 (`--ssh-port` for the firewall script), #410, #411 and #413 (dependency bumps), #423 (the `/v1` rule for breaking changes).


Earlier records of issues created outside the batches:

Issues created outside the batches since the F1 gate: #182 (timing-dependent tests), #184 (deploy API 0.1 contract), #186 and #189 (CI), #199 (control/api node endpoints), #201 (ops 1.1.1 after the isolate pool), #206 (ops 1.2.0 streamed body, the contract #161 needs), #207 (tenant `Set-Cookie` domain rule at the gateway, found by #114), #212 (macOS CPU clock accuracy, split from #139), #213 (docs after Y3 and Y4), #218 (D23 follow-ups: node-facing endpoints off the public edge), #219 (pin the CLI to a signed worker release), #222 and #223 (the contract and the `streamLogs` endpoint that #128 and the dashboard's Logs screen need), all placed in the batches below; and on 2026-10-30, from the "Skipped" and "Differences" sections of PR #301 and PR #300: #303 (deploy API 0.4: the account and MFA endpoints, tenant erasure, break-glass, `disk` on the heartbeat, `UsageHour` fields, `ops:read` tokens), #304 (the validator crash on pathless `tool` and `job` routes that makes the deploy e2e tests fail, plus `authz` as a reserved name), #305 (the change feed #281 could not build without `renox-data`), #306 (the two streaming tests red on `main` after F5-ALL), #307 (the dashboard parts of #293), #308 and #309 (the split of #120), #310 (the break-glass part of #121, `security.txt` on `api.renox.app`, `ops:read` tokens, the `acct_` operator id), #311 (two gaps of #103: `disk` on the heartbeat, `SQLITE_CORRUPT` mid-request), #312 (the `pubsub-drop` chaos steps #104 could not write before `renox-realtime` existed); and #315 (ops 1.6.0 with the `jobs` module's read path, deploy API 0.4.1 with `purge_replica` on `nodeDropTenant`), filed after F56-ALL skipped #297 for it; and #318–#337, the F7 split of 2026-10-30 (two contracts, three Rust tasks, five control-plane tasks, nine modules and the products), placed in F67-ALL below. And #346 (the F7-31 contract: the route table's `suspended` status, billing with the owner's token and the invoice PDF path, back-office access to app tables, the ops gaps), filed after F67-B, placed in C7 below. The owner prerequisites of that time are done or moved: `node-small` exists (O3-HOST, O5, O4-HOST ran on it), the load-generator host is #456 now, the `worker-v0.2.0` tag was pushed on 2026-11-02 (and `worker-v0.3.0`, which the CLI pins, on 2026-11-03), and the Mac for #212 was not needed (#212 and #361 closed). Today's owner steps are the table "Waits on the owner" above.

Since 2026-10-30: #342 and #343 (the two findings of the B1 run on `node-small`: a cold first request charged 3–5× its CPU, and 2.7 MB of per-isolate RSS outside the V8 heap; O4-HOST below), #350 and #351 (F7-STRIPE: a Stripe Customer per tenant, invoice collection, disputes; PR #352), #356 (GREEN-MAIN: the tests failing on `main` and the `ts` job that hid them; PR #358), #359 (an artifact fetch from unresponsive object storage; PR #367), #361 (the `macos` job's bound; MACOS-ACCOUNTING below), #362 (jobs due on a minute boundary; JOBS-CLOCK, PR #365), #363 and #364 (DOMAINS: `renoxium.app` for tenant apps, `renoxium.com` for the platform; PRs #368 and #370), #366 (SINGLE-HOST below), #372 (BINARY-SIZE below), #376 and #377 (SDK-DOCS below). Not from an issue: #341 (this file after F67-B), #353, #354, #355 and #217 (dependency bumps), #369, #371, #374 and #375 (the macOS CPU clock after #357), #373 (the two `worker-v0.2.0` release blockers).

**Gate order** (each gate review is a `type:review` issue run under its special case): #49 (F2) after #342's last criterion, #457, the load-generator runs of #456 and the four open rows of #112; #61 (F3) after #49's bench runs; #68 (F4) when the owner's booking product repository exists; #74 (F5) after the B14 run (#456); #79 (F6) after #74, the B18 run (#456), the `ops/` reviews and one green weekly chaos run (#389, GREEN-CI); #86 (F7) after the single-host install (#458), the products launched and the first paying tenant.

## F0 (done: 2 sessions + gate)

| Batch | Issues | PR |
| --- | --- | --- |
| A | #1, #2, #4, #5, #12, #9, #13 | #130 |
| B | #3, #6, #7, #8, #10, #11 | #131, #132 (second half) |
| Gate F0 | #14 | #133: GO to F1 |


## F1 (done: 9 sessions + gate)

| Batch | Issues | PR |
| --- | --- | --- |
| C (contracts) | #15, #16, #17, #91 | #134 |
| D renox-data | #18, #19, #20, #21 | #136 |
| E renox-gateway | #22, #23, #88 | #137 |
| F renox-runtime | #25, #26, #27, #108 | #138 (upgraded to `deno_runtime` 0.268) |
| G meter, SDK, examples | #24, #31, #33 | #135 (#36, #109 skipped: blocked by #25) |
| G2 | #36, #109 | #140 |
| H wiring, CLI, shop, benchmarks | #28, #89, #29, #30, #32, #34, #35 | #148 |
| H2 benchmark follow-ups | #143, #147, #144, #145, #146 | #151 |
| I checklists | #92, #110 | no PR (checklist batch) |
| Gate F1 | #37 | #165: GO to F2 and F3 with conditions; issues #152 to #164 created, #36, #92, #110, #146 closed |


## F2 (17 sessions + gate)

The F1 gate split its follow-ups into #152 to #161 and moved every F2 contract edit into #152 and #153. F3 runs at the same time as F2 (see below).

### Batch J0 — after gate F1 — the F2 contracts (3 issues)

```
Work on batch J0 of arif-rachim/renox.rs: issues #152, #153, #125 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #172. Contract issues only: artifact v1, ops 1.1.0, client events. Two follow-ups were needed because a contract batch writes no code and the CI path filter skipped the `ts` and `rust` jobs on it: #173 (SDK error codes) and #174 (meter example test); #175 fixed the filter.

### Batch H3 — after gate F1, alongside J0 — F1 carry-over and the worker release (3 issues)

```
Work on batch H3 of arif-rachim/renox.rs: issues #160, #154, #139 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #171 (#160, #154 partly). #139 was skipped: its macOS rows need `limits/cpu.rs` ported, which is in batch Y2 now.

### Batch H4 — after H3 — the worker release (1 issue)

```
Work on issue #154 of arif-rachim/renox.rs alone, as batch H4. The packaging landed in PR #171; what is left is the B20 binary size (121.6 MB against the 100 MB limit, see the release-worker.yml run on PR #171) and the worker-v0.1.0 tag. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if the issue blocks you, do what the rules say and stop.
```

Done: PR #190 (size profile in `release-worker.yml`); the owner pushed `worker-v0.1.0` on 2026-10-28, which publishes the release that #163 and #55 download.

### Batch J — after J0 — renox-template and the render op (3 issues)

```
Work on batch J of arif-rachim/renox.rs: issues #38, #39, #40 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #178.

### Batch K — after J0 — gateway protocol hardening, compression, web-layer protections (3 issues)

```
Work on batch K of arif-rachim/renox.rs: issues #107, #159, #47 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #176, #107 only (see below).

### Batch L — after J0 — SDK page types, platform MCP, CLI negative paths (3 issues)

```
Work on batch L of arif-rachim/renox.rs: issues #44, #48, #90 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #177.

J, K, L ran at the same time (PRs #178, #176, #177, merged 2026-10-28). K landed #107 only: #159 was skipped by rule 6 (it needs `crates/renox-cell/src/manager.rs`, now in its Files, and goes into batch Y) and #47 by rule 3 (blocked by #40, now in batch M).

### Batch Y — after M — CPU accounting, isolate pool, cold-start levers, compression (4 issues)

```
Work on batch Y of arif-rachim/renox.rs: issues #155, #156, #157, #159 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #198 (#155, #156, #159; #157 skipped, Y2 takes it). Two documents it could not edit are #201: the §10 collateral rule is now per pool member, and the runtime README still describes F1 CPU accounting. All four touch `crates/renox-runtime/src/isolate.rs`, `src/limits/**` and `crates/renox-cell/src/manager.rs`; M (merged first) changed the same files for page dispatch, so expect conflicts in `manager.rs`, `cell.rs` and `isolate.rs` when the PR opens and rebase Y on `main`. #159 moved here from K: it compresses in `manager.rs` before the meter record.

### Batch M — after J, K, L — pages: routing, loaders, actions, CLI transpile, shop pages, web-layer protections (4 issues)

```
Work on batch M of arif-rachim/renox.rs: issues #41, #43, #45, #47 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #185. Two findings went to issues: the CLI template and shop build tests skip in CI without a worker binary (#186, batch O2), and fragment rendering evaluates the whole page (noted on #42 and #46).

### Batch N — after M — client errors, error pages, CSRF hardening (4 issues)

```
Work on batch N of arif-rachim/renox.rs: issues #126, #93, #127, #111 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #191 without #111, which waits for #159 (batch Y) and is picked up by Y2.

### Batch O — after M — benchmark environment, render path B, B8 (2 issues)

```
Work on batch O of arif-rachim/renox.rs: issues #158, #42 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #197, #42 only. #158 was skipped by rule 13: a session cannot provision the `node-small` host and the load-generator host. The owner provides both (SSH addresses in the issue), then O3 runs #158 and #46.

### Batch Y2 — after Y — ops 1.1.1, cold-start levers, macOS builds, CSRF hardening, streaming (5 issues)

```
Work on batch Y2 of arif-rachim/renox.rs: issues #201, #157, #139, #111, #161 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

#201 first (special case `type:contract`; it is the only contract edit in this batch). Then everything Y and N could not take: #157 and #139 were blocked by #154 when Y started (H4 closed it, PR #190); #111 was blocked by #159 when N ran; #161 touches `isolate.rs` and `manager.rs` like Y. #161 is not an F2 gate blocker; skip it if the batch runs long.

Done: PR #204 (#201, #111, and #157 except the `node-small` re-run, which closes it in O3 with #158). #139 and #161 were skipped by rule 6 for the second time: their Files lists did not name the files they need (`limits/cpu.rs` for the macOS CPU clock; the bootstrap, a chunk op, `compress.rs` and `render.rs` for streaming). Both lists are complete now; #139 is batch Y3, #161 is batch Y4 behind its contract issue #206. #201 could not bump the version in `docs/contracts/README.md` and the header comments (outside its Files); #206 does it.

### Batch Y3 — after Y2 — worker builds for macOS and arm64, tenant cookie domain rule (2 issues)

```
Work on batch Y3 of arif-rachim/renox.rs: issues #139, #207 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Runs now, alongside Y4 and U: no file overlap with either. #139 owns `limits/cpu.rs`, `release-worker.yml`, `v8-checksums.txt` and a macOS CI job; if the macOS clock needs more than `cpu.rs`, it ships the `aarch64-unknown-linux-gnu` row and leaves the macOS rows with a comment. #207 is gateway only (`src/security/cookies.rs`, the response path in `src/lib.rs`): a tenant `Set-Cookie: Domain=renox.app` reaches every other tenant's host today.

Done: PR #210. #207 in full. #139 shipped the Linux arm64 row and the macOS clock backend, but on `macos-14` the CPU limit lands 3–11 ms past the ± 5 ms bound (rule 13 after two attempts); the macOS rows and the clock fix are #212, which needs a Mac and blocks no gate, and #139 is closed. Docs that fell behind (`ops/README.md`, `ops/psl/README.md`) are #213.

### Batch Y4 — after T2 (in) — streamed responses end to end (2 issues)

```
Work on batch Y4 of arif-rachim/renox.rs: issues #206, #161 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

#206 first (special case `type:contract`: `ops.md` 1.2.0 defines the head-first body, the chunk op, per-chunk egress accounting and the meter at end of stream; it also fixes the version in `docs/contracts/README.md` and the header comments). #161 implements it; it edits `manager.rs` and `isolate.rs`, which T2 changed, so it branches from `main` after PR #205 (in). Not an F2 gate blocker.

Done: PR #211, both issues. Error pages for a loader that fails after the shell was flushed now arrive inside the stream with status 200, as 1.2.0 says; `crates/renox-cell/tests/errors.rs` was adapted. The `renox-cell` README still describes buffered responses: #213.

### Batch Y5 — after Y4 — fetch blocked ranges of ops 1.1.0, timing-dependent tests (2 issues)

```
Work on batch Y5 of arif-rachim/renox.rs: issues #170, #182 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Both were created after the F1 gate and had no batch. #170 (blocked ranges of `ops.md` section 2: SIIT, `3fff::/20`, `5f00::/16` and the rest) blocks #112, so it is on the gate F2 path; it owns `net_policy.rs`, which V (D23 normalisation fix) already merged. #182 owns the two flaky tests and at most a test hook in `manager.rs`; Y and Y4 are in, so nothing else edits that file now. No overlap with V2 or T3.

### Batch O3 — after Y and the owner's bench hosts — benchmark environment and the F2 benchmarks (2 issues)

```
Work on batch O3 of arif-rachim/renox.rs: issues #158, #46 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Needs `BENCH_NODE_SSH` and `BENCH_LOADGEN_SSH` in the session's environment (#158). #158 re-runs B1, B4, B11, B12 on the worker that Y produced; #46 measures B6, B7, B9, B13 on the same hosts.

Status (2026-10-30, 2026-11-01): ran in two parts on the owner's `node-small` (4 vCPU AMD EPYC KVM VPS, 8 GB, Ubuntu 24.04) without the load generator. **O3-HOST**, PR #345 (`b2c7560`): B1 on `node-small` (#158 partly; B4, B11 and B12 need the load-generator host), the `pubsub-drop` chaos run (#312 closed) and the replica spike with a verdict (#256 closed). The B1 run found #342 (a cold first request charged 3–5× its usual CPU and answered `RENOX_CPU_LIMIT`) and #343 (`shop` at 10.07 MB per isolate, 2.7 MB outside the V8 heap): O4-HOST below. **O5**, PR #360 (`99b1600`): B13 (PASS), B9 (645 µs on the generic path: FAIL on target, inside the limit), B2 (PASS), the chaos harness with `storage-down` fixed (finding #359, fixed by #367); #46 stays open for B6 and B7. Result files: `bench/results/2026-10-30-B1-node-small-*.md`, `bench/results/2026-11-01-B13-*.md`, `-B9-*.md`, `-B2-*.md`, `-CHAOS-*.md`.

### Batch O4-HOST — after O3-HOST, on `node-small` — the two findings of the B1 run (2 issues)

```
Work on batch O4-HOST of arif-rachim/renox.rs: issues #342, #343 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Runs on `node-small` (`BENCH_NODE_SSH`), with a release worker built there (34 minutes, `bench/README.md`). #342 first: it owns `crates/renox-runtime/src/limits/cpu.rs` and the slice loop of `isolate.rs`, must keep `tests/limits.rs` unchanged and green, and records the root cause in a result file; #343 is blocked by it (B1 must complete without a spurious `RENOX_CPU_LIMIT`) and owns the allocator settings of `renox-cell` and the B1 row of `docs/14-benchmarks.md`. #342 overlaps #361 in `cpu.rs`: read the five macOS PRs (#357, #369, #371, #374, #375) and their issue comments on #212 first; the watchdog's estimator and the post-fire clamp are macOS-only, the Linux path is the raw clock. Gate #49 waits for this batch.

Status (2026-11-01): merged as PR #378 (`10e802e`), closing neither issue. #342: the first run of the platform's request path now happens once at isolate creation (`warm_request_path`), so a cold first request is charged 3.7–4.5 ms instead of 8.7–9.2 ms, and an infinite loop on a cold lazy route still stops at the limit; the criterion "B1 completes three times in a row" failed twice on host vCPU stalls the guest cannot tell from tenant CPU, so #342 stays open for it. #343: the gap is between commits, not hosts (`dddd743` measures 7.32 MB on both; `main` 11.89 MB); the bisect is #457. Result files: `bench/results/2026-11-01-cold-request-cpu-node-small.md`, `bench/results/2026-11-01-B1-node-small-rss-343.md`.

### Batch MACOS-ACCOUNTING — now — the `macos` CI job's bound (1 issue)

```
Work on batch MACOS-ACCOUNTING of arif-rachim/renox.rs: issue #361. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Needs a Mac. State on 2026-11-01: after #374 (the watchdog estimates CPU from the last value the kernel published plus the wall time since, the ledger reads the raw clock, the killed request is billed between its limit and the limit plus 5 ms) and #375 (the fair-share test re-measures its baseline after the rounds), the `macos` job is green on PR #374, PR #375 and `main` run 41295393154, each with the three-run step. The issue's first criterion is therefore met on `main`; the session confirms it against the live runs, records the measured unwind the PRs reported (5–7 ms of CPU after `TerminateExecution` on macOS ARM) and closes the issue, or reopens the question with new numbers. Nothing in this batch touches the Linux path.

Status (2026-11-01): not run as a session; #361 was closed on 2026-11-01 on the green `macos` runs of `main`.

### Batch O2 — after H4 — CI hygiene (2 issues)

```
Work on batch O2 of arif-rachim/renox.rs: issues #186, #189 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #195. Both edit `.github/workflows/ci.yml`. #186 makes the CLI template and shop build tests run with a worker binary in CI (today they skip); #189 folds the small jobs and takes `release-worker.yml` off pull requests.

### Batch P — after N and Y2 — the two checklists (2 issues)

```
Work on batch P of arif-rachim/renox.rs: issues #94, #112 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions.
```

Runs now. Every issue in the Blocked-by lists of #94 and #112 is closed; the plan had put P behind O3 for ordering, not for a dependency. The checklists verify controls, not benchmark numbers, so they do not wait for #158. One item of #112 (the blocked ranges of `ops.md` section 2) is #170 in Y5: if Y5 is not in when P runs, the checklist records that item as open and #170 closes it.

### Gate F2 — after P and O3

```
Run the gate review issue #49 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

## F3 (15 sessions + gate), in parallel with F2

F3 depends on F1's contracts (artifact format, route table, meter), not on F2, so batch Q started at the same time as J0. Most of F3 lives under `control/**`, `packages/**`, and `crates/renox-cell/src/control/**`. The F2 batches that F3 files overlapped with (K, L, M, H3) are all merged, so the remaining F3 batches rebase on `main` as usual; the one live overlap is #159 (batch Y) with #162 in `crates/renox-gateway`, which T resolves by rebasing after Y.

### Batch Q — after gate F1 — control plane core: deploy API contract, skeleton, deployments, route table, secrets (5 issues)

```
Work on batch Q of arif-rachim/renox.rs: issues #50, #51, #52, #53, #54 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #169. The contract #50 absorbed every F3 contract edit; the rest was written against it.

### Batch R — after Q — control-plane accounts (1 issue)

```
Work on batch R of arif-rachim/renox.rs: issues #113 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #183. The roles and scopes matrix (a contract edit) moved to #184 (batch U0).

### Batch S — after Q — billing ingestion, upload hardening, bundle hygiene (3 issues)

```
Work on batch S of arif-rachim/renox.rs: issues #56, #95, #115 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #181. Three contract gaps it reported (usage endpoint, rule ids H1/H2, `code/` secret scan at upload) are #184 (batch U0).

### Batch T — after Q, S, and H4 — worker side: TLS, control-plane client, degraded mode, activation and route-table consistency (5 issues)

```
Work on batch T of arif-rachim/renox.rs: issues #162, #55, #98, #96, #97 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #196, #162 only. #55 was skipped by rule 6: its `SecretsSource` hook and per-route tier need `crates/renox-cell/src/manager.rs` and `cell.rs`, which batch Y held; #98, #96 and #97 depend on it. T also found three control-plane endpoints the worker calls that nothing implements, now #199. All of it is batch T2.

### Batch T2 — after Y — node endpoints, control-plane client, degraded mode, activation and route-table consistency (5 issues)

```
Work on batch T2 of arif-rachim/renox.rs: issues #199, #55, #98, #96, #97 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

#199 first (control/api, the endpoints the worker calls), then #55 with its extended Files, then the three that build on it. #96 and #97 touch `control/api/src/deployments/activate.ts` and `control/api/src/routes/versioning.ts` only.

Done: PR #205, all five issues, after resolving two conflicts with `main` (the `app.ts` registration list after R2; `manager.rs` after Y2 moved `run_migrations` into `prepare_db`). Left open on the issues, not blockers: secret rotation does not recycle a live cell (#55); `worker.example.toml` and the `renox-cell` README do not describe controlled mode yet; a deployment that declares secrets cannot cold-start while the control plane is down (503 by design, #98).

### Batch R2 — after R and T — custom domains and domain ownership (2 issues)

```
Work on batch R2 of arif-rachim/renox.rs: issues #59, #114 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #203. For the owner: the Public Suffix List pull request for `renox.app` (`ops/psl/README.md` has the steps and the PR text; needs DNS control for `_psl.renox.app` and a registration term over two years). The tenant `Set-Cookie: Domain=` rule it found is #207 (batch Y3). Wildcard hostnames need a contract issue first and are not scheduled.

### Batch U0 — after H4, alongside T — deploy API 0.1 contract and the CLI release (2 issues)

```
Work on batch U0 of arif-rachim/renox.rs: issues #184, #163 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Done: PR #194. #184 carries the contract edits that batches S and R could not make (usage endpoint, bundle rule ids, the roles and scopes matrix). #163 downloads the `worker-v0.1.0` release (tagged 2026-10-28); no file overlap with T.

### Batch U — after R2 and T2 — deploy CLI, B15, signed releases, remote MCP (4 issues)

```
Work on batch U of arif-rachim/renox.rs: issues #58, #60, #129, #62 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

#58 needs #55 (T2); #60 and #129 need the CLI release from #163 (U0, done); #62 needs the local MCP from #48 (L, done).

Done: PR #209 (#58, #60, #62). #129 was skipped by rule 3 because it listed #139 as a blocker; that was unnecessary (the signing step signs whatever targets the matrix has), so #129 no longer lists it and runs in U2. B15 was measured on PGlite (no Docker in the session); the compose stack and a remote TLS run are still owed before gate F3 (noted on #61). `renox logs` is tested against a fake server until #57 (V) serves the endpoint.

### Batch U2 — after U — signed releases, docs after Y3 and Y4 (2 issues)

```
Work on batch U2 of arif-rachim/renox.rs: issues #129, #213 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Runs now, alongside V: #129 owns `release.yml`, `cli/src/worker/verify.ts` and one row of `docs/contracts/errors.md` (listed in its Files; the row is the issue's own error code); #213 owns three READMEs. No overlap with V.

Done: PR #215, both issues. Signing went into `release-worker.yml` and `release-cli.yml` (there is no `release.yml`), with one sigstore bundle per asset and SLSA provenance from `actions/attest-build-provenance`. `worker-v0.1.0` predates signing and has no aarch64 Linux build, so `release-cli.yml` warns until the owner tags `worker-v0.2.0` and #219 (U3) pins it. `RENOX_WORKER_PATH` stays an unverified override for source builds.

### Batch V — after U — internal control-API access and the dashboard as a Renox app (3 issues)

```
Work on batch V of arif-rachim/renox.rs: issues #164, #57, #128 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

#164 decides by ADR how the dashboard tenant reaches the control API without weakening tenant SSRF rules; that ADR is the one allowed edit of `docs/13-decisions.md` in F3.

Done: PR #216, #164 only (ADR D23: internal tenants reach the control API over its public hostname with a scoped tenant token; no exemption, no `internal` flag, no `ctx.platform` op; plus an IPv4-in-IPv6 normalisation fix in `net_policy.rs`). #57 was skipped by rule 3 because it listed #49 (gate F2), and #128 because it lists #57; this plan's earlier claim that V had no blockers was wrong. The dashboard needs F2's page model and client events (M and N, merged), not the gate's verdict, so #49 was removed from #57 and both run in V2. D23's four follow-ups are #218 (T3); the `deploy-api.md` pointer is a contract edit left to the gate F3 docs step.

### Batch V2 — after V — the dashboard as a Renox app, browser errors in Logs (2 issues)

```
Work on batch V2 of arif-rachim/renox.rs: issues #57, #128 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Runs now, alongside T3. #57 owns `control/dashboard/**`; per D23 the browser signs in against the API directly and the dashboard tenant uses a scoped token from `ctx.secrets`. #128 owns `control/api/src/logs/**`, `src/sourcemaps/**`, one migration, `control/dashboard/src/logs/client/**` and two CLI files. #57 is #61's "dashboard deployed through the real pipeline".

Done: PR #220, #57 only. Every F3 wireframe has a page; the signed-in user's own token is forwarded per request (no shared service token, which would show one tenant's data to every visitor). #57 stays open for one thing: `GET /v1/apps/{app}/logs` (`streamLogs`) is in the contract but `control/api` never served it, so the Logs screen gets 404 against the real API; that endpoint is #223. #128 was skipped by rule 6 and rule 7: it needs `ingest/logs.ts`, `app.ts`, `roles.ts` and contract endpoints that do not exist. The split is V3.

### Batch V3 — after V2 and T3 — client error groups: contract, `streamLogs`, the dashboard screen (3 issues)

```
Work on batch V3 of arif-rachim/renox.rs: issues #222, #223, #128 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Runs now. #222 first (special case `type:contract`: the client-errors endpoints, the symbolicated frame shape, the quota field, and Open item 5 pointing at D23). #223 serves `streamLogs` from the store `ingest/logs.ts` already fills and takes client lines out of the per-minute cap; it closes #57's last item. #128 then owns `ingest/logs.ts`, `app.ts` and `roles.ts` as well (same batch, in order). No overlap with Y5, P or U3.

### Batch T3 — after V — D23 follow-ups: node-facing endpoints off the public edge, worker start-up check (1 issue)

```
Work on batch T3 of arif-rachim/renox.rs: issues #218 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Runs now, alongside V2: #218 owns `control/api/src/{app,main}.ts`, `crates/renox-cell/src/{worker,config}.rs`, `control/fetch_connector.rs` (wording) and one threat-model row; no overlap with #57 or #128. It blocks #116 (security checklist F3).

Done: PR #221. Node-facing routes are on their own listener (`CONTROL_NODE_LISTEN_HOST`/`PORT`); a controlled worker refuses a `[control] url` that tenant `fetch` could reach; three test harnesses and the B15 script point the worker at the node listener.

### Batch U3 — after the owner tags `worker-v0.2.0` — pin the CLI to the signed worker (1 issue)

```
Work on batch U3 of arif-rachim/renox.rs: issues #219 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

The owner tags `worker-v0.2.0` from `main` (after #210 and #215: `release-worker.yml` builds both Linux targets and signs each asset). #219 then bumps `WORKER_VERSION` and `PINNED_WORKER` from the release's `.sha256` assets; `release-cli.yml` stops warning.

Status (2026-11-04): not run as its own session. The owner tagged `worker-v0.2.0` (2026-11-02) and `worker-v0.3.0` (2026-11-03); PR #436 of F7-44 (below, under "F7") pins `worker-v0.3.0` for all four targets and closes #219.

### Batch W — after P and V3 — the two checklists (2 issues)

```
Work on batch W of arif-rachim/renox.rs: issues #99, #116 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions.
```

#116 needs #112 (P); #99 needs #128 (V3). Neither needs the bench hosts, so W can run as soon as P and V3 are in, before gate F2.

Done: no PR (checklist special case), verified at `main` 3f60c8d. #99: 13 of 17 rows ticked with test names; the two #94 carry-overs (dev-time global-scope warning, template limit errors naming template and line) and the rest moved to #101 with reasons. #116: 17 of 27 rows ticked, including five added from the gate F1 notes, D23 and P; 7 moved to #117 (secret-scanning registration, PSL submission, parameterised-query lint, per-token deploy rate limits, a tampered-object test for the worker hash check, the `req.json()` lint, stale `TODO`s in `docs/24`). Both stay open: the owner confirms the moves at gate F3, and #117 carries the doc commit that also fixes the `TODO → #95/#96/#97/#98` cells in `docs/23-failure-modes.md`.

### Batch X — now, alongside F4-ALL — HTTP/2 flood budgets, the last two #128 criteria (2 issues)

```
Work on batch X of arif-rachim/renox.rs: issues #166, #128 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

The only code issues outside F4 whose blockers are closed and whose Files do not meet F4-ALL's. #166 (`[F2-41]`, from the adversarial review of #107) owns `crates/renox-gateway/{src/protocol.rs,src/limits.rs,src/lib.rs,tests/protocol.rs,README.md}`: sliding-window and per-IP reset budgets, server-provoked resets, control-frame floods, one raw `h2` test each. #128's remainder is the dashboard screenshot test (runs in CI's `ts` job, where the worker is) and symbolication of a committed `.js`/`.map` fixture pair; its criteria were rewritten on 2026-10-29 because the CLI builds no client bundles. Everything else open outside F4 waits for the owner (#46, #158 bench hosts; #219 tag; #212 Mac; #157's `node-small` re-run) or for a gate (#167, #118, F5 to F7).

Done: PR #250. #166: `H2FloodBudget` with a sliding window per connection, a per-IP budget across connections, provoked resets counted, control frames as a token bucket; `CONTINUATION` and empty `DATA` floods pinned to h2's own limits with a test each. #128: fixture symbolication and the screenshot test (Chromium through Playwright where available). Two follow-ups: #260 (the three new knobs are not in `worker.toml`) and #261 (server `RENOX_INTERNAL` stack symbolication, gate F1 note); both run in F6-ALL below.

### Gate F3 — after W, O3 and gate F2

```
Run the gate review issue #61 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

## F4 (F4-0, F4-ALL, P4, F4-X + gate)

F4-ALL ran as one session and took every task, so batches R1, R2, T1, T2, M1, M2, M3 below never ran; they stay as the record of the split.

The gate reviews of F2 and F3 are still open, but the split of the F4 epics is planning work and was done on 2026-10-29 so F4 can start the day the gates close, and so the contract batch, which is documentation only, runs now. Every F4 task issue carries the full Files list it needs (the lesson of #139 and #161). Batches are longer than in F2 and F3 on purpose: one session takes a whole crate's worth of work. Each epic (#63 to #67) stays open as the index of its tasks and closes with its last task.

Dependencies, from the issues: contracts first; the Rust and TypeScript tracks then run in parallel; the modules need both; `org` and `i18n` need `auth`; the checklists and the gate come last. Owner prerequisite for the gate (#68): the booking product repository, which is not a Renox issue.

### Batch F4-0 — now, alongside V3, P and Y5 — the F4 contracts (3 issues)

```
Work on batch F4-0 of arif-rachim/renox.rs: issues #225, #226, #227 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for `type:contract` issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Special case `type:contract` for all three; #227 builds on #225 in the same batch. Documentation and the shared validator only. The one file it shares with V3's #222 is `docs/contracts/README.md` (one row each): if the PR conflicts there, keep both rows. #226 also settles what `auth` needs from the platform (argon2id as an op, savepoints, the event envelope), so read `docs/10-modules.md` and the F4 rows of `docs/23-failure-modes.md` and `docs/24-threat-model.md` before writing.

Done: PR #247, #225 and #227. #226 was skipped by rule 6: the SDK pins its types to `ctx.d.ts` (`sdk/tests/contract.test-d.ts`), so the three new error codes and the new `ctx` members need type-only edits in `sdk/`, outside its Files. Its Files now include them and the `meter.md` minor bump; the full 1.3.0 draft is a comment on the issue. #225 decided that a module name has no hyphen, so the `gcc-data` module is `gcc` (#243, #244 updated).

### Batch F4-ALL — after F4-0 — every remaining F4 task in one session (19 issues)

```
Work on batch F4-ALL of arif-rachim/renox.rs: issues #226, #228, #233, #234, #236, #237, #230, #231, #229, #232, #235, #238, #239, #240, #241, #100, #243, #242, #244 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for `type:contract` issues for the first one. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

The owner's choice on 2026-10-29: one long session instead of the parallel batches R1 to M3 below, which stay as the fallback and as the file-ownership map. The order is topological over the issues' Blocked-by lists (checked against the live tracker); every blocker is closed or earlier in the batch. #226 first, since everything else depends on it. Rule 13 applies as usual: a skipped issue takes its dependants with it (rule 3), and the PR's "Skipped" list says where the chain stopped; the remaining issues then run as a second F4-ALL batch from `main`. Not in this batch: #101 and #117 (checklists run without code, batch P4) and #68 (gate, needs the booking product repository).

Done: PR #262, all 19 issues, 21 commits, merged 2026-10-29; epics #63–#67 closed. Every Rust and module suite green; two `cli`/`sdk` tests were already red on `main` (#267, #268). Findings carried out as issues: Arabic digits need a wider `locale` tag (#263 contract, #266 task); `ALTER TABLE … ADD COLUMN` on a STRICT table fails under the authorizer on migration connections (#264); B6 with `auth` costs 5–15 % more p50 on a debug worker and must be re-measured on a release build and `node-small` (O3, #158); the org membership fence is a service check until F5 `db.scoped` (#69); `auth` and `org` depend on `i18n`, so every app with `auth` installs `i18n`; the outbox gauge is not on the metrics endpoint yet (#77).

### Batch F4-X — after F4-ALL, alongside F6-ALL and P4 — ops 1.4.0, authorizer DDL fix, lazy route modules, Arabic digits, two red tests (6 issues)

```
Work on batch F4-X of arif-rachim/renox.rs: issues #263, #264, #265, #266, #267, #268 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for type:contract issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

#263 first (special case `type:contract`: ops 1.4.0 and artifact 1.2: the `locale` tag with `-u-nu-`/`-u-ca-` extensions, route modules evaluated on first use, `entries` export list and `eager` flag). Then #264 (renox-data: SQLite's own pragma reads during DDL on an allowed table), #265 (runtime, cell and CLI side of lazy routes; re-runs B1 `shop` and closes #157), #266 (`i18n` Arabic digits, #244's last criterion), #267 and #268 (the two tests red on `main`). No file overlap with F6-ALL (#251–#261): F4-X is in renox-runtime, renox-data, renox-template filters, `cli/src/{lib/build.ts,check,commands/dev.ts}`, `sdk/client`, `modules/i18n` and the contracts; F6-ALL is in renox-cell, `ops/`, `control/`, `cli/src/commands/db.ts`.

Done: PR #271, all six issues, merged 2026-10-29; CI on `main` green. Differences worth knowing: `ops.schema.json` stays at the top of `docs/contracts/`; `setLocale` keeps its `RangeError` (ops Open 9); `eager` defaults to `true`; an eszip artifact with lazy entries is refused at prepare (the CLI builds `esm-dir` only); an app cannot list extra eager entries yet (ops Open 11); `arabext` renders Latin digits and `ca` dates stay Gregorian. #157 closed with #265.

### Batch R1 — after F4-0, alongside R2 and T1 — i18n filters, slots and overrides, module pages (2 issues)

```
Work on batch R1 of arif-rachim/renox.rs: issues #233, #232 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

`renox-template` plus the page side of `renox-cell` (`pages/**`, `render.rs`, `loader.rs`). R2 owns `manager.rs`, `cell.rs` and the new `outbox.rs` in the same crate; do not touch those here. #232's slot fillers run with the page's `ctx` until R2's #230 is in (noted on both issues).

### Batch R2 — after F4-0, alongside R1 and T1 — outbox tables and migrations, module contexts and broker, events and password ops, outbox delivery (4 issues)

```
Work on batch R2 of arif-rachim/renox.rs: issues #228, #230, #231, #229 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

The long pole of F4: `renox-data` (#228), then `renox-runtime` (#230, #231), then the cell's delivery worker (#229). #231 needs #228 and #230, #229 needs #231; all four are in this batch in that order. The only shared file with T2 is `crates/renox-cell/src/bin/renox-worker.rs` (#235 adds a `migrate` subcommand), which T2 runs after R2.

### Batch T1 — after F4-0, alongside R1 and R2 — resolver and lock, `renox:modules` types, query-builder drivers (3 issues)

```
Work on batch T1 of arif-rachim/renox.rs: issues #234, #236, #237 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

`cli/src/lib/modules/**` and `cli/src/commands/{add,remove}.ts` (#234); `cli/src/lib/types/modules.ts` and `sdk/src/modules.ts` (#236); `sdk/src/{kysely,drizzle}.ts` (#237). No file overlap between the three or with R1 and R2. #237's cross-module refusal test can use today's single-module authorizer (any table outside the app's prefix); it does not wait for #230.

### Batch T2 — after R2 and T1 — build with modules, `renox check` contracts, `renox migrate`, `renox test` (2 issues)

```
Work on batch T2 of arif-rachim/renox.rs: issues #235, #238 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

#235 needs `migrate_all` (#228, R2) and the resolver (#234, T1); #238 needs #235. Both edit `cli/src/commands/**` and `cli/src/lib/**`; the shop tests move to the harness in #238.

### Batch M1 — after T2 — the `auth` module (4 issues)

```
Work on batch M1 of arif-rachim/renox.rs: issues #239, #240, #241, #100 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

One session, one module, in order: core, then passwordless and OAuth, then the shop integration with README and snapshots, then the negative tests. `modules/auth/**` and `examples/shop/**`. If the batch runs long, stop after #241 and give #100 its own batch M1b; it blocks #101 and #117, not M2 or M3.

### Batch M2 — after T2, alongside M1 — the `gcc-data` module (1 issue)

```
Work on batch M2 of arif-rachim/renox.rs: issues #243 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

`modules/gcc-data/**` only; needs the filters of #233 (R1) and the build of #235 (T2). No dependency on `auth`.

### Batch M3 — after M1 and M2 — the `org` module and `i18n` core (2 issues)

```
Work on batch M3 of arif-rachim/renox.rs: issues #242, #244 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

`org` needs `auth` and the slots of #232; `i18n` needs `auth` and `org` for its RTL snapshots, so it is second. #244 also adds catalogs under `modules/{auth,org,gcc-data}/i18n/` and `examples/shop/i18n/`, which no other batch edits at that point. Arabic review of the catalogs is an owner task (native speaker); machine-translated strings stay marked until then.

### Batch P4 — after M1 and M3 — the two checklists (2 issues)

```
Work on batch P4 of arif-rachim/renox.rs: issues #101, #117 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Checklist special case. #117 also carries whatever #116 (F3) moved here.

Runs now: F4-ALL is in (PR #262) and every blocker of #101 and #117 is closed; #116 was removed from #117's list on 2026-10-29 (its moved rows are already on #117; #116 waits only for the owner). Checklist special case: no code, no PR.

Done (2026-10-29, verified at `main` 55a9ae1, no PR): #101 ticked 9 of 10 (the two rows carried from #99 moved to #102 with reasons); #117 ticked 8 of 14 (eleven rows moved to #119 with reasons: open redirect through `redirect.safe()`, the argon2id measurement, an override reading undisclosed loader data, the module CSP merge, and the seven #116 items). Both stay open for the owner's confirmation at gate #68. Two leftovers became issues: #274 (one doc commit for the stale `TODO`s, which #117's last criterion needs) and #275 (the eight moved rows that need no design decision).

### Gate F4 — after P4 and #266

```
Run the gate review issue #68 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

Needs the booking product repository running on Renox with `auth` and `org` (owner) and the kill criterion evaluated and recorded. The F5 split the gate would have proposed was done on 2026-10-29 (section "F5" below), so the review only checks it against what the booking product taught.

## F6 (F6-ALL ran alongside F4-ALL, F6-B alongside F5-ALL; F56-ALL and F56-B after them)

`docs/15-roadmap.md` runs F6 alongside F4 and F5. Epics #75 (sandbox and tiers) and #76 (replication and backup) were split on 2026-10-29 into #251–#259 so one long session can run beside F4-ALL: they live in `ops/`, `crates/renox-cell/src/{sandbox,supervisor,replication}/`, `control/api/src/{workers,tenants,ops}/`, `cli/src/commands/db.ts` and the dashboard, none of which F4-ALL edits. Three files are shared with F4-ALL for small wiring (`crates/renox-cell/src/manager.rs` with #229, `crates/renox-cell/src/bin/renox-worker.rs` with #235, `cli/src/main.ts` with #234 and #235); the issues say to rebase on `main` before the PR. #77 (observability) stays after F4-ALL because its spans sit in the crates F4-ALL edits.

### Batch F6-ALL — now, alongside F4-ALL — contract, ops, sandbox, process tiers, Litestream, replica spike, failover, export and restore, operator actions, two follow-ups of X (11 issues)

```
Work on batch F6-ALL of arif-rachim/renox.rs: issues #251, #252, #253, #254, #255, #256, #257, #258, #259, #260, #261 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for type:contract issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Order: #251 first (special case `type:contract`: deploy API 0.3 with backups, export, restore, node restore order, operator actions, `tier` and `process` on route entries; nothing in `ops.md`, which #226 holds). Then #252 (`ops/` units, slices, bootstrap, pinned Litestream fetcher, CI install), #253 (seccomp and Landlock in the worker), #254 (supervisor and per-tenant child processes; blocked by #251, #252, #253 earlier in the batch), #255 (Litestream sidecar per tenant file; blocked by #251, #252), #256 (spike on the synchronous replica, independent), #257 (failover in the control plane; blocked by #251, #255), #258 (export, import, point-in-time restore, dashboard Database screen; blocked by #251, #255, #257), #259 (operator actions; blocked by #251, #254, #257), then #260 and #261 (small, independent). Every blocker is earlier in the same batch, so rule 3 never skips. Owner steps the session cannot do: the B18 two-host run and the B19 `node-small` run (O3, #158), the `ops/` code-owner review, and the ADR decision #256 proposes. If the session stops after two failed attempts on one issue (rule 13), the rest runs as a second F6-ALL from `main`.

Status (2026-10-29): PR #270 open, awaiting the owner's merge and the `ops/` code-owner review. Ten of the eleven issues are done in it: deploy API 0.3 (#251), `ops/` units and slices (#252), seccomp and Landlock (#253), the supervisor and per-tenant children (#254), the Litestream sidecar (#255), failover (#257), export, import and restore with the Database screen (#258), operator actions and the console (#259), the h2 knobs (#260), server stack symbolication (#261, code only: its contract sentence is #273's). #256 (replica spike) was skipped by rule 13: the container cannot run downloaded binaries, LiteFS needs FUSE and Consul, libSQL needs a dependency the repo does not have; it stays open for a capable host (`bench/spike/replica/run.sh --kills 10`). Not measured in the container: B12, B18, B19, the cgroup and fork-bomb test, `bootstrap-node.test.sh` (CI has Litestream, shellcheck and docker). Two contract gaps the PR could not edit (`TokenCreated.token` and `move_request.operator`) and the missing operator read endpoint are #273. After the merge: close epic #75 (every task closed); #76 stays open for #256.

### Batch F6-B — after #270 and C5, alongside F5-ALL — the stale `TODO`s, integrity and recovery, keys, security process, observability provisioning, chaos harness (6 issues)

```
Work on batch F6-B of arif-rachim/renox.rs: issues #274, #103, #120, #121, #296, #104 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Order: #274 (two documents, no code), #103 (quick_check on open, restore from the replica, disk watermarks, pruning; blocked by #255 and #257, closed with #270), #120 (keys, erasure through backups, encrypted exports; blocked by #255 and #258), #121 (security.txt, runbooks, operator access, pentest scope; #77 was dropped from its list), #296 (Prometheus, Grafana, alert rules, the 0.3.1 read endpoint, the console status panel and the Usage charts; blocked by #273 in C5), #104 (the chaos harness reads #296's alerts; #76 and #77 were replaced by their tasks in its list). No crate of F5-ALL is edited here except `crates/renox-data/src/integrity.rs` and `crates/renox-cell/src/{disk,pruning}.rs`, which are new files of #103; `ops/`, `.github/`, `SECURITY.md` and `deny.toml` need the code-owner review. Owner steps: Terraform apply and the KMS keys (#120), the pentest vendor (#121), the weekly chaos hosts (#104).

Status (2026-10-30): merged as PR #300 (`7071b5a`). Done: #274 (and the closed-issue `TODO`s of `docs/23`), #103 (watermarks and pruning in controlled mode only; the 95 % refusal is a dispatcher 503 and `SQLITE_CORRUPT` mid-request is not caught, because `manager.rs` was F5-ALL's; the heartbeat has no disk field: both are #311 after the contract #303), #296 (every `renox_worker_*` family is a proposal marked pending in its README until #295; the Usage page shows mean latency until `UsageHour` gains percentiles in #303; an `ops:read`-only token is #310), #104 (processes on one runner plus MinIO; `pubsub-drop` reports FAIL until #312 writes its steps). #121 closed with `SECURITY.md`, `security.txt` at the gateway, the three runbooks; break-glass and `security.txt` on `api.renox.app` are #310 after #303. #120 was skipped by rule 6 (erasure needs an operation the contract did not have; exports need `object-store.ts` and `config.ts`; Terraform needs OpenTofu) and is split into #303, #308 and #309. Owner steps unchanged, plus: the `security@` mailbox, the tabletop, the pentest vendor.

### Batch F56-ALL — now — deploy API 0.4, the F5 follow-ups, `jobs`, spans, keys, chaos, erasure, break-glass, the dashboard pages, the four checklists, in one session (16 issues)

```
Work on batch F56-ALL of arif-rachim/renox.rs: issues #303, #304, #305, #306, #297, #295, #309, #312, #308, #310, #307, #311, #102, #119, #105, #122 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special cases for type:contract issues and for checklist issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

One chain, as F4-ALL, F6-ALL and F5-ALL were: every blocker is closed or earlier in the batch (checked against the live tracker on 2026-10-30), so rule 3 never skips. Order: #303 first (special case `type:contract`: deploy API 0.4 with the account and MFA endpoints as #293 built them plus the rule that they accept a user token, `deleteTenant`, `impersonateTenant` with the `ops:impersonate` scope, `disk` on the heartbeat, the `UsageHour` percentiles and realtime fields, `createToken` with `ops:read` alone; the type-only sync of `control/api/src/tenancy/roles.ts` as #273 did). Then the F5 follow-ups of PR #301: #304 (`packages/artifact-validate` crashes on `tool` and `job` routes without a `path`; `authz` joins the reserved module names), #305 (the change feed: a changed-rows-after-commit hook in `renox-data` and the feed in the cell, the one part of #281 that needed `db.rs`), #306 (the two streaming tests of `renox-cell` failed on the `main` run of #301 at 723 ms and 864 ms against 400 and 500 ms bounds while the PR's own run and the next `main` run passed: measure the first request after the principal and `guard` prelude, fix what is avoidable, assert ordering rather than wall clock). Then the F6 crate work: #297 (`jobs`: the scheduler in the cell, `ctx.jobs.enqueue`, the module, `renox jobs`; the notes from C5 on its body: a job exports a named `run`, `docs/07` follows, `audit.prune` gets scheduled), #295 (spans and the metric families, which also replaces the pending `renox_worker_*` marks of #296's README), #309 (`ops/security/keys.md`, `ops/terraform/**`, the OpenTofu job and the bucket-policy test in CI). Then the control plane: #312 (the `pubsub-drop` chaos steps against the hub of #281), #308 (`deleteTenant`, the node drop, the Litestream generation and the exports deleted, SSE-KMS on `object-store.ts`, the erasure chaos scenario; blocked by #303, earlier here), #310 (break-glass with its audit rows and emails, `security.txt` on `api.renox.app`, `ops:read` tokens, the `acct_` operator id in the audit row; blocked by #303), #307 (the dashboard security page over the MFA endpoints with a user token, the live Logs page fed by a `jobs` follower; blocked by #303, #304, #297, all earlier), #311 (`disk` on the heartbeat stored by the control plane, `SQLITE_CORRUPT` mid-request through the integrity path; blocked by #303). Last, the four checklists under the checklist special case inside this batch: #102 and #119 (F5), then #105 and #122 (F6, whose rows are built by the issues above). For them the session ticks rows with links to the test names and the commits of this branch, moves what cannot be done with a one-line reason, writes no code for them and puts no `Closes` line for them in the PR; they close when the owner confirms them at the gates. Shared files inside the batch (`crates/renox-cell/src/{cell,manager}.rs`, `crates/renox-data/src/db.rs`, `control/api/src/auth/**`, `docs/23-failure-modes.md`, `docs/24-threat-model.md`) are sequential on one branch, so nothing conflicts. `ops/`, `.github/` and `deny.toml` need the code-owner review. Rule 13 applies: a skipped issue takes its dependants with it and the PR's "Skipped" list says where the chain stopped; the rest runs as a second F56-ALL from `main`. Owner steps the session cannot do: `terraform apply` and the KMS keys (#309), the rotation drills, the weekly chaos run (#312), the B14 and B18 runs (#158), the ADR of #256, the `ops/` and `.github/` reviews. Fallback split, if the owner prefers shorter sessions: C6 (#303) alone; F6-C (#304, #305, #306, #297, #295, #309) and P5 (#102, #119) beside it; F6-D (#312, #308, #310) after C6; F5-Y (#307, #311) after C6 and F6-C; P6 (#105, #122) last. The paths of those groups do not meet, which is why they could run side by side.

Status (2026-10-30): merged as PR #314 (`1e233be`); CI on `main` green on all four jobs, and the new `ops` workflow (terraform, bucket-policy) green too. Closed: #303 (deploy API 0.4; the disk levels follow `disk.rs`: `warn` 80 %, `critical` 90/95 %), #304 (V23–V27 in the validator, `authz` reserved), #305 (the change feed with rusqlite's `preupdate_hook`), #306 (no code fix: none of the three levers measured over 5 ms; the assertions now compare arrivals), #309 (`keys.md`, `ops/terraform`, the `ops.yml` workflow with OpenTofu and the MinIO bucket-policy test; MinIO's root bypasses policies, so the test proves the deny on anonymous puts). Partly done, open with an "Open" list in each comment: #295 (export, spans, `/metrics`, log trace ids; open: `module.service` spans, `job.run`, the tenant `op_log` trace id, five families, the tool-call span tree), #308 (`deleteTenant` with its sweep, SSE-KMS exports; open: the replica generations, which need a node-listener operation, the dashboard settings page, the chaos scenario), #310 (`impersonateTenant`, `security.txt`, `ops:read` tokens, `acct_` in the audit; open: the console pages), #311 (`disk` on the heartbeat end to end; open: `SQLITE_CORRUPT` mid-request and the 95 % refusal in `limits.rs`). Skipped: #297 by rule 6 (`ops.md` names no read path for the `jobs` module, the authorizer refuses `renox__*` tables to modules: #315 is that contract), #307 by rule 3 (its live Logs follower is a job), #312 by rule 13 (the container is at 92 % disk, so a controlled worker refuses cells, and Litestream cannot be executed: it needs a host), #105 and #122 by rules 3 and 13 (their builders were skipped or partial; both received the rows moved from #102 and #119). #102 and #119 are updated under the checklist special case and stay open for the owner's confirmation at gate #74.

### Batch F67-ALL — now — the F56-B nine, then the whole of F7 in the same session (32 issues)

```
Work on batch F67-ALL of arif-rachim/renox.rs: issues #315, #297, #307, #295, #308, #310, #311, #105, #122, #318, #319, #320, #321, #322, #323, #324, #325, #326, #327, #328, #329, #330, #331, #332, #333, #334, #335, #336, #337, #123, #106, #124 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special cases for type:contract issues and for checklist issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

The first nine are the F6 remainder (the former F56-B). #315 first (special case `type:contract`: `op_jobs_list`, `op_jobs_retry`, `op_jobs_cancel` callable only by module `jobs`, the coalescing key and the `deliver` path #297's comment found, `RENOX_JOB_*` error rows; `nodeDropTenant` with `purge_replica` and `replica_purged_at` on the erasure record; the type-only `ctx.jobs` sync in `sdk`). Then #297 (`jobs` in full: scheduler, `op_jobs_enqueue`, the module over the new ops, `renox jobs`; the ops are registered in `crates/renox-runtime/src/globals.rs`, rule 9) and #307 (the dashboard security page and the live Logs follower job). Then the four partly done issues, each finishing its "Open" list: #295 (`module.service` and `job.run` spans, the trace id on tenant `op_log` lines, the five pending families, the tool-call span tree), #308 (erasure step 3 sends `purge_replica`, the dashboard settings page; the chaos scenario is written but can only run where #312 runs), #310 (the console pages), #311 (`SQLITE_CORRUPT` mid-request through `integrity.rs`, the 95 % refusal in `limits.rs`). Last, the two F6 checklists under the checklist special case (no code, no `Closes` line): #105 (#312 removed from its list: the `pubsub-drop` row stays unticked with a note until it runs on a host) and #122 (#119 removed the way #117 was). Then F7, in the order of the "F7" section below. Every blocker of the 32 is closed or earlier in the batch (checked against the live tracker on 2026-10-30). Rule 13 applies as before; the rest runs as F67-B from `main`. Owner steps: #312 on a host with Docker and a disk under 80 % (`bench/chaos/run.sh pubsub-drop`; the session comment on #312 lists what the scenario needs), the B14 and B18 runs (#158), `terraform apply` and the KMS keys (#309), the `ops/` and `.github/` code-owner reviews of #309 and #314.

After the merge: close epic #70 (with #305, already closed: close #70 now), #77 (with #295), #78 (with #297) with a comment each; then gate #74, then gate #79.

Status (2026-10-30): merged as PR #340 (`1664c60`). Closed: #315, #297, #307, #308, #310, #311, #318, #319, #320, #321, #322, #323, #327; epics #70 and #78. Partly done, each with an issue comment listing what remains: #295 (the local collector run), #324, #325, #326, #328, #329, #331, #332, #333, #334, #123. Skipped: #330 (needs each PSP's sandbox), #335 (not started), #336 and #337 (wait for module pages). Checklists #105, #122, #106, #124 updated. Differences worth knowing before F67-B: module webhook secrets are `<MODULE>_WEBHOOK_<PROVIDER>_SECRET`; `renox webhook replay` is not built because the events table keeps no payload by contract; the PDF stack (typst) brought seven RUSTSEC advisories ignored with reasons in `deny.toml` (code-owner review); CI gained a step that reruns the v8 build script when rust-cache dropped `target/debug/gn_out`.

### Batch F67-B — after F67-ALL — the F7 remainder and #295's last item (17 issues)

```
Work on batch F67-B of arif-rachim/renox.rs: issues #295, #324, #325, #326, #328, #329, #330, #331, #332, #333, #334, #335, #336, #337, #123, #106, #124 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

The partly done issues finish the "Open" list of their F67-ALL comment; the rest start from their issue. The order is topological over the Blocked-by lists (checked against the live tracker on 2026-10-30): #326 after #325; #329 after #328; #330 and #331 after #329; #333 after #329 and #331; #334 after #328 and #329; #335 after #329 and #332; #336 after #331, #333, #334, #335; #337 after #330, #331, #333, #334, #336; #123 after #325, #326, #328, #329; then the checklists #106 and #124 under the checklist special case (no code, no `Closes` line). #330 can build and unit-test its adapters against recorded provider responses but its live verification needs the owner's sandbox accounts; if a session cannot verify it, rule 13 applies and #337 goes with it. Owner steps: the PSP sandbox and production accounts, Resend or SES, Safe Browsing and OSV keys, the PSL submission, the DPA's legal review, and the code-owner reviews of `deny.toml` and `.github/`.

After the merge: close epic #77 (with #295) and each F7 epic (#80 to #85) whose tasks are all closed, with a comment each.

Status (2026-10-30): merged as PR #344 (`ea3695e`).
- **Closed:** #295, #324, #326, #328, #329, #331, #333, #334, #335; epics #77 and #84.
- **Partly done**, each with an issue comment listing what remains:
  - #325: the gateway's suspension page, the dashboard billing page and the invoice PDF, all blocked by the contract.
  - #330: COD and bank transfer done; the card PSP and BNPL adapters need the providers' sandboxes.
  - #332: the shop's product images.
  - #336: the dashboard's Arabic catalog and the RTL snapshots of every page.
  - #123: the neutral page, Safe Browsing, CAPTCHA, ASN rates, and advisories on activation.
- **Skipped:** #337 (blocked by #330).
- **Checklists:** #106 and #124 updated.

**Fixes outside the issues' Files**, worth knowing before the next batch:
- `renox build` now builds a module's `functions/webhooks/` routes (before, no module webhook was ever routed).
- The worker's loader accepts `sbom.cdx.json` (artifact 1.4).
- `renox check` reports `i18n-missing-key`.
- The billing sweep runs hourly from `control/api/src/main.ts`.

**Contract gaps** the session met are collected in #346: the route table's `suspended` status, billing with the owner's token and the invoice PDF path, back-office access to app tables, and the `ctx.pdf` prefix, Svix/SNS and `ctx.render` gaps.

### Batch C7 — after F67-B — the contract the F7 remainder needs (1 issue)

```
Work on batch C7 of arif-rachim/renox.rs: issue #346. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for type:contract issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Documentation, schemas, examples and the type-only SDK sync only: artifact 1.5, ops 1.8.0, deploy API 0.5.1. Read the comments of #325, #123, #335 and #328 first; they say what each implementation found.

Status (2026-10-31): merged as PR #347 (`41e0cde`); #346 closed.

### Batch F67-C — after C7 — the F7 remainder that needs no PSP account (6 issues)

```
Work on batch F67-C of arif-rachim/renox.rs: issues #325, #332, #336, #123, #106, #124 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Each issue finishes the "Still open" list of its F67-B comment:
- **#325:** the gateway's neutral page on the new `suspended` status, the dashboard's Usage and billing page with the owner's token, and the invoice PDF on the path #346 chooses.
- **#332:** the shop's product images through the module, with B6 run before and after.
- **#336:** the dashboard's pages to `<r-t>` keys with an Arabic catalog, and RTL snapshots of every module page.
- **#123:** the neutral page end to end, and the OSV scan on activation with its dashboard warning. Safe Browsing, CAPTCHA and ASN rates need the owner's keys; without them they stay open with a note.
- **#106 and #124:** checklists, under the checklist special case.

The `admin` module's CRUD scaffolding (#335's comment) becomes a new task once #346 settles its form; it is not in this batch.

**Owner steps:**
- Sandbox accounts with Checkout.com, Telr, PayTabs, N-Genius, Tabby and Tamara. #330 and then #337 run once these exist.
- The Safe Browsing key.
- The DPA's legal review.
- `RENOX_SELLER_TRN`.

Status (2026-10-31): merged as PR #348 (`51e1d48`); #325 and #332 closed; #336, #123 and the two checklists continued in F67-D (below, under "F7").

### After F67 on `main` — JOBS-CLOCK, F6-31, the release blockers (3 PRs)

Three fixes found on `main` and on `node-small` after F67-B, each its own small PR from `main`: **JOBS-CLOCK**, PR #365 (`e04db57`): #362, jobs due exactly on a minute boundary. **F6-31**, PR #367 (`af49115`): #359, an artifact fetch from unresponsive object storage answers 503 within 5 s and `/healthz` reports `object_storage` (found by O5's `storage-down` run). **Release blockers**, PR #373 (`a7d55e0`, no issue): the replication sidecar's state turns `Stopped` only after Litestream has exited and the shared config is written atomically (`a_corrupt_file_answers_503_then_is_restored` was flaky on `main`), and the B20 size target is raised from 100 to 160 MB so `worker-v0.2.0` can ship (#372 brings it back down). Owner steps: tag `worker-v0.2.0` from `main`, then U3 (#219).

### Gate F6 — after F56-B, #312 on a host, gate F5 and the B18 two-host run

```
Run the gate review issue #79 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

Needs #74 (gate F5), the two F6 checklists updated by F56-ALL (#105, #122), the B18 run (O3, #158), the `ops/` code-owner reviews of #252, #296, #309 and the weekly chaos run green once (#104, #312), and the F7 epics (#80 to #86) split the way F5 and F6 were.

## F5 (C5, F5-ALL, P5 + gate)

The F4 code is on `main` (#262, #271) and gate #68 waits only for the owner's booking repository, so the F5 epics (#69 to #73) were split on 2026-10-29 the way F4 was split ahead of its gates: #272 (the contracts), #276 to #294 (the tasks), plus the two F4 leftovers #274 and #275 and the existing #118 and #167. Two design points the documents left open are settled by the contract issue: the principal reaches Rust through the `auth` module's `auth.principal` service (not by the cell reading `auth__sessions`), and `realtime.authorize` is the Cedar action `realtime.subscribe` on a `Topic` resource, fail closed, not a hook. The `schedule` export of the F6 `jobs` task (#297) is in the same contract issue so `ops.md` is edited once. Each epic stays open as the index of its tasks and closes with its last task.

### Batch C5 — after #270 merges — the F5 contracts and deploy API 0.3.1 (2 issues)

```
Work on batch C5 of arif-rachim/renox.rs: issues #272, #273 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for type:contract issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Documentation and the shared validator only. #272: ops 1.5.0 (principal and `guard`, `op_authz_*`, `db.scoped()`, role assignments and the authz audit table, `ws`/`sse` routes and `op_realtime_*`, topics as Cedar resources, App MCP tool routes and `/mcp`, the `schedule` export), artifact 1.3, manifest 1.1, meter 0.3, with the type-only sync of `sdk/src/{ctx,errors}.ts` as #226 did. #273: deploy API 0.3.1 (the `frames` sentence of #261, `renox_op_` tokens, the operator id form, `GET /v1/ops/tenants/{tenant}`, Open 5 closed with D23); it is blocked by #251 and #259, which close with #270, so this batch starts after that merge; its PR says `Closes #261`. Read `docs/11-authorization.md`, `docs/09-htmx-realtime.md`, `docs/20-ai-agents-mcp.md` section 2 and the F5 rows of `docs/23` and `docs/24` before writing.

### Batch F5-ALL — after C5 — every F5 task in one session (22 issues)

```
Work on batch F5-ALL of arif-rachim/renox.rs: issues #275, #276, #277, #278, #279, #280, #281, #167, #283, #284, #285, #286, #288, #289, #290, #291, #287, #292, #282, #293, #294, #118 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

The order is topological over the issues' Blocked-by lists (checked against the live tracker on 2026-10-29): every blocker is closed or earlier in the batch. #275 first (eight small security rows across `modules/auth`, `cli`, `control/api` and the cell's tests, before the auth and CLI work below edits the same files). Then the Rust layer: #276 `renox-authz` and #277 `db.scoped()` plus the two platform tables (both leaf-level), #278 `renox-realtime`, #279 the principal, `guard` and the authz ops in the cell, #280 `r-can`, #281 WebSocket and SSE end to end, #167 the gateway guard handover after a 101. Then the TypeScript layer: #283 (authz in `sdk` and `cli`: build, check rules, `authz explain`, policy tests), #284 (realtime, tools and jobs route kinds, `renox dev` upgrades, TOTP and WebAuthn primitives), #285 the `/mcp` endpoint in the cell. Then the modules in dependency order: #286 (`auth` OAuth server for agents, `org` tool), #288 (`audit`), #289 (`notifications`), #290 (`whatsapp`), #291 (`auth` phase 2: `auth.principal`, phone-first, passkeys, UAE PASS), #287 (`2fa`, which fills `auth.principal`), #292 (the shop: refund scenario, live orders, policy tests). Then #282 (`examples/chat` and B14), #293 (control-plane MFA and the dashboard's live Logs page), #294 (platform MCP and CLI additions), #118 (hardening tests last, when every surface exists). Rule 13 applies: a skipped issue takes its dependants with it (rule 3) and the PR's "Skipped" list says where the chain stopped; the rest runs as a second F5-ALL from `main`. Owner steps the session cannot do: the B14 run on `node-small` (O3, #158), the UAE PASS production onboarding (#291's README), a Meta WhatsApp account (#290's README), `deny.toml` rows for `cedar-policy` and the OpenTelemetry crates if new licences appear (code-owner review). File overlap with F6-B is limited to `crates/renox-cell/src/manager.rs` wiring, which #103 does not touch; #296 edits `control/api/src/ops/**` and the dashboard's `ops/` and `usage` pages, which no F5 issue edits.

Status (2026-10-30): merged as PR #301 (`f673ca8`), nothing skipped by rule 13. Twenty issues closed outright; #281 closed with everything but the change feed (the commit-time row capture needs `crates/renox-data/src/db.rs`, which no F5 issue owned: #305), #293 closed with the control API side (the dashboard signs in with a token, D23, so the MFA endpoints must accept one, #303; the live Logs page needs a `jobs` follower, #297: both in #307). Differences worth knowing before the next batches: resource-less checks use `Renox::Global`; the F4 module policies moved to the `Renox::` namespace; the realtime hub has its own WebSocket codec and per-connection queues; connect is an isolate phase before the 101; the OAuth metadata is a service, not a `.well-known` folder; `notifications__*` and `whatsapp__*` tables per MF4; `auth.principal_changed` also invalidates the principal cache. The PR left `packages/artifact-validate` crashing on `tool` and `job` routes without a `path` (no batch issue owned it), which the PR says makes the deploy e2e and the contract example tests fail (the `ts` job of CI is green, so those tests run only with the worker): #304, second in F56-ALL after the contract. The `main` CI run of the merge commit failed two timing assertions of `crates/renox-cell/tests/streaming.rs` (the PR's own run and the next `main` run, #300's merge, were green, so the margin is thin rather than gone): #306. Epics #69, #71, #72, #73 closed; #70 closes with #305.

### Batch P5 — the two F5 checklists, folded into F56-ALL (2 issues)

#102 and #119 are the thirteenth and fourteenth issues of F56-ALL (above), under the checklist special case: no code, no `Closes` line, rows ticked with links to the test names and the commits of that branch. On 2026-10-29 both lists had their epic blockers replaced by the tasks that build each row (#102: #279, #281, #285, #287, #282, #292; #119: #118, #275, #274, #279, #283, #287, #288, #293), and #117 was removed from #119's list the way #116 was removed from #117's: it stays open only for the owner's confirmation at gate #68. The rows that need the change feed (#305) or the dashboard security page (#307) are built earlier in the same batch. If they run on their own instead (the fallback split): `Work on batch P5 of arif-rachim/renox.rs: issues #102, #119 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.`

### Gate F5 — after F56-B (#307) and the B14 `node-small` run

```
Run the gate review issue #74 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

Needs the refund scenario demonstrable from the shop README (#292), the B14 result on `node-small` (O3), both dogfooding products on realtime or notifications (the shop's live orders #292, the dashboard's live logs #307; the booking product is the owner's), the four F5 follow-ups of PR #301 closed (#304, #305, #306, #307), and the F7 epics split the way this section split F5.

## F7 (split on 2026-10-30; ran in F67-ALL, F67-B, C7, F67-C and F67-D; the follow-ups and the open batches below)

The six F7 epics (#80 to #85) were split into #318–#337 on 2026-10-30, ahead of gate #79 the way F5 and F6 were split ahead of theirs, because the owner wants one long chain and the F6 remainder alone was nine issues. Each epic stays open as the index of its tasks (comments on the epics list them). The owner decisions `docs/15` leaves open (pricing model, marketplace revenue share, data-plane licence) are not tasks: #325 produces the unit-economics data for the first, #324 carries a `price` field without payouts for the second, the third is an ADR the owner writes.

Order inside F67-ALL, topological over the Blocked-by lists:

1. Contracts: #318 (`type:contract`: ops 1.7.0 with `op_storage_*`, the image pipeline, `op_webhook_verify`, `op_ai_chat`, `op_render_pdf`, the `isolate` semantics; artifact 1.4; manifest 1.2 with registry sources and signatures; meter 0.4), #319 (`type:contract`: deploy API 0.5 with the registry, platform billing in AED, onboarding, `POST /v1/abuse`, advisories, the AI gateway).
2. Rust: #320 (`isolate` mode), #321 (storage op, `/_img`, `<x-image>`), #322 (webhooks, `ctx.ai` op, PDF).
3. TypeScript platform: #323 (`sdk` and `cli`: types, fakes, `renox publish` and `approve`, registry sources, `renox webhook replay`), #324 (the registry in `control/api` and the dashboard Modules page), #325 (platform billing, tier states and suspension, anomaly rules, the Usage and billing page), #326 (onboarding, `www/` docs site, pricing page, DPA), #327 (the AI gateway).
4. Modules in dependency order: #328 (`email`), #329 (`billing` core with Stripe UAE), #330 (GCC adapters), #331 (`tax-gcc`), #332 (`storage`), #333 (`reports`), #334 (`booking`), #335 (`admin`), #336 (EN/AR complete across every module and the dashboard).
5. Products: #337 (`examples/booking`, `examples/restaurant-ordering`, `examples/invoice`, the shop with Tabby and Apple Pay, `renox new --template` for the four).
6. Security and checklists: #123 (abuse controls, attached to #319, #325, #326, #328, #329), then #106 and #124 under the checklist special case (no code, no `Closes` line).

What no session can do: provider accounts (Stripe UAE, Checkout.com, Telr, PayTabs, N-Genius, Tabby, Tamara, Resend or SES, Meta WhatsApp), the accredited e-invoicing provider (`docs/21` verify item), the `abuse@` and `security@` mailboxes, Safe Browsing and OSV API keys, `renox.app` on the Public Suffix List, the DPA's legal review, the launch of the two products with real users, and the first paying tenant that gate #86 records. Every task README lists its owner steps. `deny.toml`, `ops/` and `.github/` edits need the code-owner review.

### Batch F67-D — after F67-C — the F7 remainder's last items and the two checklists (4 issues)

```
Work on batch F67-D of arif-rachim/renox.rs: issues #336, #123, #106, #124 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Status (2026-10-31): merged as PR #349 (`0eac5d7`); #336 (EN/AR complete: Arabic catalogs for every module and the dashboard, RTL snapshots, Eastern Arabic digits and Hijri as options) and #123 (abuse controls: takedown and the abuse endpoint, Safe Browsing checks, card-testing limits, sending reputation, sign-up friction, SBOM and advisory warnings per artifact) closed; checklists #106 and #124 updated.

### Batch F7-STRIPE — after F67-D — a Stripe Customer per tenant, invoice collection, disputes (2 issues)

Status (2026-10-31): merged as PR #352 (`154b773`); #350 (`[F7-32]`) and #351 (`[F7-33]`) closed. The platform's own billing collects invoices through Stripe and records disputes; the GCC adapters of #330 are still the owner's sandbox step.

### Batch GREEN-MAIN — now — the tests failing on `main`, and CI's `ts` job that hid them (1 issue)

```
Work on batch GREEN-MAIN of arif-rachim/renox.rs: issue #356. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Status (2026-11-01): merged as PR #358 (`1511f88`); #356 closed. The `ts` job had been green while 77 tests failed: no `pipefail` on `make ts-test | tee`, and an unpackaged debug worker that panicked at start-up so no worker test ran. CI now builds a packaged worker in the `rust` job (the two steps of `release-worker.yml` in the debug profile) and the `ts` job runs root `bun run test` on it; the eight tests that failed on `main` were fixed. Root `bun run test` with that worker: 1311 pass, 0 fail.

### Batch DOMAINS — now — `renoxium.app` for tenant apps, `renoxium.com` for the platform (2 issues)

```
Work on batch DOMAINS of arif-rachim/renox.rs: issues #363, #364 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for type:contract issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Status (2026-11-01): merged as PRs #368 (`c753015`) and #370 (`054eb42`); #363 (the contracts: artifact 1.5.1 and 1.5.2, deploy API 0.5.2 and 0.5.3, the "Domains" section of `docs/contracts/README.md`) and #364 (the code: every platform default from configuration with the reference values, "Renoxium" wherever a person reads the product name, `README.md` "Naming") closed. The owner's decision of 2026-11-01: tenant apps on `renoxium.app` (`<app>.renoxium.app`, previews, `edge.renoxium.app` for custom domains; on the Public Suffix List), the platform's services and mail on `renoxium.com`; `renox.rs` is only the repository's name.

### Batch SDK-DOCS — now — the SDK on npm, the status lines and agent onboarding (2 issues)

```
Work on batch SDK-DOCS of arif-rachim/renox.rs: issues #376, #377 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

#376 (`[F7-39]`): `sdk/` publishes to npm as `@renoxium/sdk` (renamed from `renox`, which npm refused, D28; compiled JavaScript and declarations, `exports` to `dist/`, a `prepare` build so the workspace resolves the same map), the packed-package test, `.github/workflows/release-sdk.yml` on the `cli-v*` tag with npm provenance and trusted publishing (or `NPM_TOKEN`), and `renox new` pinning the SDK to the CLI's own version. Owner steps: the first publish of the name by hand from `renox-dev`, the Trusted Publisher on npmjs.com for `release-sdk.yml`, the `renoxium` organization's team access, and the SDK's licence (the repository has none yet). #377 (`[F7-40]`): this section and the table above, the status lines of `README.md`, `CLAUDE.md` and `AGENTS.md`, `www/public/llms.txt` and `llms-full.txt` with their generator and test, `AGENTS.md`, `CLAUDE.md` and `.mcp.json` written by `renox new`, and the "Build with an AI agent" section of `docs/12`.

Status (2026-11-01): merged as PR #379 (`7de8361`); #376 and #377 closed. The SDK was first published by hand in F7-44, as `@renoxium/sdk` (D28), not `renox`.

### Batch SINGLE-HOST — after DOMAINS — the first production on one machine behind Cloudflare (1 issue)

```
Work on batch SINGLE-HOST of arif-rachim/renox.rs: issue #366. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

The control plane, Postgres and the worker on `node-small`; the control API published through a Cloudflare Tunnel with `CONTROL_TRUSTED_PROXIES` and `CONTROL_CLIENT_IP_HEADER` (the socket address stays the default); loopback-only listeners with a start-up check; `cloudflared` and `lego` pinned by version and SHA-256 like Litestream; the firewall script; the wildcard certificate for `*.renoxium.app` by DNS-01; Litestream and `pg_dump` backups to R2 with a restore drill; the runbook `ops/single-host.md`. Owner steps: the Cloudflare tunnel credentials and the DNS-only API token (root-only files, never in the repository), the R2 bucket and keys, the DNS records, and the code-owner review of `ops/` and the units. The runbook says when the control plane moves to its own host (before the first paying tenant).

Status (2026-11-02): merged as PR #386 (`8a48d13`) on `o/f7-37-single-host`; #385 (the Resend mailer, `[F7-41]`) closed, #366 done but for the Litestream-to-R2 bullet (refused by the residency rule then in `config.rs`; D25 removed it in F7-38) and the owner steps. Follow-ups merged the same day: PR #388 (#387, `CONTROL_MCP_URL` behind the tunnel) and PR #390 (`--ssh-port` for the firewall script). The first real install on `node-small` found #391–#405 (HOST-WORKER, HOST-OPS, HOST-CONTROL, SINGLE-HOST-2 below), and F7-38 replaced its own TLS and `lego` with the Cloudflare tunnel. The three `control/api/README.md` rows it could not edit were added by DOCS-SYNC. #366 was closed on 2026-11-05; its owner steps are #458.

### Batch BINARY-SIZE — now — the release binary back under 100 MB (1 issue)

```
Work on batch BINARY-SIZE of arif-rachim/renox.rs: issue #372. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Measure first (`cargo bloat` on the size-built packaged binary, the top 20 crates against the 2026-10-28 build, in a result file), then the candidates the measurement points at: Cargo features `media` and `pdf` on `renox-runtime` and `renox-cell` (a worker without one answers its ops with the unavailable error the contract allows), a smaller AVIF encoder or AVIF off with WebP kept, `typst` trimmed. `MAX_BINARY_MB` and the B20 row back at 100 MB, or the sentence why not. Needs a release build (34 minutes on `node-small`, or the release workflow by hand). `.github/workflows/release-worker.yml` changes need the code-owner review.

Status (2026-11-02): merged as PR #380 (`96234bb`) and PR #383 (`e6c10a1`, the build-step commit #380 missed); #372 closed. The F7 growth is the PDF engine (`typst`, 26.3 MiB); Cargo features `media`, `avif` and `pdf` were added, and by the owner's decision the release is built without `pdf`, at 107.4 MiB on x86_64 Linux. `MAX_BINARY_MB` is 120 (the cosign ceiling is 128), not 100, with the reason in the B20 row. On a released worker `ctx.pdf.render` answers `RENOX_INTERNAL` with `pdf_unavailable`; bringing it back is #381. The pre-existing rollback timeout it found is #382 (GREEN-CI). Result file: `bench/results/2026-11-01-B20-binary-size-bloat-renox-worker.md`.

### Batch HOST-CONTROL — after SINGLE-HOST — what the first install found in `control/api` (3 issues)

```
Work on batch HOST-CONTROL of arif-rachim/renox.rs: issues #402, #398, #396 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Status (2026-11-03): merged as PR #408 (`a3536e1`); #402, #398, #396 closed. #402: the unhandled-error log line names its stage and cause chain, secrets masked, and an object-store failure answers 503 `RENOX_UNAVAILABLE` with `Retry-After: 5`. #398: a domain detaches only after three misses over at least 30 minutes (migration `0027`). #396: the platform-tenant flag (migration `0028`), set only by an operator through `POST /v1/ops/tenants/{id}/platform`, so the platform's own tenant can run `dashboard` and `www`.

### Batch HOST-OPS — after SINGLE-HOST, alongside HOST-CONTROL — what the first install found in `ops/` (7 issues)

```
Work on batch HOST-OPS of arif-rachim/renox.rs: issues #393, #394, #395, #399, #397, #400, #405 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Status (2026-11-03): merged as PR #409 (`4bba13d`); #393, #394, #395, #397, #399, #405 closed, #400 partly (SINGLE-HOST-2 finished it). A fresh single-host install needs no drop-ins and no hand edits: key files `renox:renox 0400`, the backup accepts systemd 255's 0440 credential inside `$CREDENTIALS_DIRECTORY`, the certificate script installs before it reloads. Part of it (the `:443` capability, ACME directories) was removed again the same day by F7-38. Code-owner review of `ops/`.

### Batch HOST-WORKER — after SINGLE-HOST, alongside HOST-CONTROL and HOST-OPS — what the first install found in the worker (5 issues)

```
Work on batch HOST-WORKER of arif-rachim/renox.rs: issues #391, #392, #401, #403, #404 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Status (2026-11-03): merged as PR #412 (`43087bd`); #391, #392, #401, #404 closed; #403 worker side only (a warning per paid tenant whose `process = "own"` is ignored, `RouteState::own_process_ignored()`), the heartbeat field needing a contract (now #454). The crate version moved to 0.2.1; the owner tagged `worker-v0.3.0` from `main` after F7-38 instead.

### Batch F7-38 (CF-EDGE) — after the HOST batches — the app edge behind Cloudflare (epic #421, 6 issues, then #424)

```
Work on batch CF-EDGE of arif-rachim/renox.rs: issues #416, #414, #418, #419, #417, #420 in that order (epic #421). Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Status (2026-11-03): merged as PR #422 (`cfe9649`), PR #423 (`87df5f4`) and PR #425 (`c5d33da`); #414, #416–#420 and #424 closed, epic #421 closed. ADR D25: the worker serves plain HTTP/1.1 on a unix socket behind `cloudflared` and trusts `CF-Connecting-IP` only from the `renox-tunnel` uid; every inbound TLS, ACME, `:80` and HTTP/2 path is deleted; custom domains are Cloudflare for SaaS custom hostnames (deploy API 0.6, breaking, kept on `/v1` until production by PR #423); the residency rule is out of the code, so Litestream can replicate to R2. ADR D26 (PR #425): no `edge` hostname, the zone apex `renoxium.app` is the fallback origin; `worker-v0.3.0`. The issues it made obsolete (#394, #397, #399, #404, #415, part of #406) were closed by the owner. Owner steps: the cut-over on `node-small` (#458).

### Batch F7-39 (DOTMATRIX) — the design of Renoxium's own pages (epic #429, 3 issues)

```
Work on batch DOTMATRIX of arif-rachim/renox.rs: issues #426, #428, #427 in that order (epic #429). Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Before it, PR #384 (`0277cb8`, no issue) built the first `renox-ui` design system and a new landing page under D24. Status (2026-11-04): merged as PR #432 (`69c5078`) and PR #439 (`9eed676`, the five review commits that landed on #432's branch after its merge, plus the `design-taste-frontend` skill under `.claude/skills/`); #426, #427, #428 closed, epic #429 closed. ADR D27: renox-ui v2 "dot matrix", one self-hosted font; the dashboard signs in with email and password; the site publishes the developer docs only.

### Batch F7-44 — the first public CLI and SDK release (1 issue, six PRs)

```
Work on issue #431 of arif-rachim/renox.rs alone, as batch F7-44. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if the issue blocks you, do what the rules say and stop.
```

Status (2026-11-04): merged as PRs #433 (the SDK's MIT licence), #434 (a cross-platform `prepare`), #435 (the SDK is `@renoxium/sdk`, ADR D28, after npm refused `renox`), #436 (the CLI pins `worker-v0.3.0`, `renox --version`, the WSL 2 hint, the install docs, `CHANGELOG.md`; closes #219), #437 (`release-sdk.yml` never republishes a version) and #438 (0.1.1, the first SDK version through trusted publishing). #431 was closed on 2026-11-03; the owner tagged `cli-v0.1.0` and `cli-v0.1.1` on 2026-11-04. `cli-v0.1.2` followed on 2026-11-05 (#455).

### Batch ONBOARD-1 — after F7-44 — the first hour of a new developer (8 issues)

```
Work on batch ONBOARD-1 of arif-rachim/renox.rs: issues #445, #446, #447, #448, #449, #450, #443, #444 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Status (2026-11-05): merged as PR #452 (`e689a29`). Closed at merge: #445 (sign-in with email and password, the second factor, "forgot password"), #447 (the real install line, only the CLI's templates), #450 (hourly billing, a real Alertmanager receiver, `OnFailure` on the backup). Closed after `cli-v0.1.2` under the "Resolved when" rule it added to `docs/22-development-plan.md`: #443 (type checking in `renox check` and before `renox deploy`), #446 (the `/device` and Tokens pages), #448 (the compiled CLI's `renox test` and `renox add auth`, the release smoke test), #449 (`renox new` next steps, the quickstart, help for every command, the link checker). #444 (a handler that returns no `Response`) closes with the next `worker-v*` release and the CLI pin. It filed #451 (HEARTBEAT-KEYS).

### Batch ISSUES-OPEN-1 — 2026-11-05 — cancelled

Status (2026-11-05): cancelled with every other session of that day, before it opened a PR; its branch was lost. The issues it had taken were reopened, and the tracker was cleaned the same day (#455 to #464 are the issues filed then). Its prompt is not recorded. What it would have done is in the batches below and in the table "Waits on the owner".

### Batch SINGLE-HOST-2 — after SINGLE-HOST — what the production install on `node-small` found (4 issues)

```
Work on batch SINGLE-HOST-2 of arif-rachim/renox.rs: issues #400, #403, #406, #407 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Status (2026-11-05): merged as PR #453 (`21f0d16`), closing #400, #406, #407; #403 was closed the same day with its heartbeat field moved to #454 and #460 (HEARTBEAT-KEYS). Run on `claude/lucid-ride-ia0tof` after the owner chose it, since no batch was left in this file once O4-HOST and SINGLE-HOST waited only on owner steps. #400's last item: the control API loads PGlite only for a `pglite:` URL, so it starts from a `bun install --production` tree. #403: the runbook states the single host's `[process]` decision; the heartbeat field needs a `type:contract` change (deploy API 0.5.4, proposed in the PR), so #403 stays open. #406: `renox build` links each `public/` file a template names by a content-hashed copy, served `immutable`; compression stays at Cloudflare's edge, and a gateway test keeps the worker from encoding twice. #407: `ops/scripts/single-host-e2e.test.sh` walks the runbook's steps 3 to 12 in a systemd container in CI's `ts` job (Pebble and cert-renew dropped since D25). Owner steps: the code-owner review of `.github/workflows/ci.yml` and `ops/`, and a contract issue for #403's heartbeat field.

### Batch DOCS-SYNC — now — the status lines, the batch records since 2026-11-01, the install line (1 issue)

```
Work on batch DOCS-SYNC of arif-rachim/renox.rs: issue #461. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if something blocks you, do what the rules say and continue.
```

Started 2026-11-05. Docs only: `README.md`, `AGENTS.md`, `CLAUDE.md`, this file, `docs/12`, `docs/15`, `docs/getting-started.md`, `cli/README.md`, `control/api/README.md`, the dashboard's install constant, `examples/hello/README.md`. It touches nothing GREEN-CI edits, and nothing in `cli/src`, `cli/tests`, `cli/scripts` or `.github/workflows/ci.yml`, which PR #463 owned while it was open.

### Batch GREEN-CI — now — the weekly chaos run, the bootstrap `--upgrade` flake, the rollback e2e test (3 issues)

```
Work on batch GREEN-CI of arif-rachim/renox.rs: issues #389, #464, #382 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Started 2026-11-05. #389 (the weekly chaos run of 2026-11-02 failed before the harness finished; `bench/chaos/`, the run's `chaos-results` artifact), #464 (`ops/scripts/bootstrap-node.test.sh`: the `--upgrade` step fails intermittently and hides its output, and the single-host steps inherit the failure; code-owner review of `ops/`), #382 (`cli/tests/deploy.e2e.test.ts`, "v1 again on the worker" times out after `renox deploy --rollback`, found by BINARY-SIZE). #382 is in `cli/tests`, which PR #463 also edited: branch from `main` at `d37a751` or later. Gate #79 waits for one green weekly chaos run.

### Batch HEARTBEAT-KEYS — now — `process_isolation` on the heartbeat, the master-key re-encryption job (3 issues)

```
Work on batch HEARTBEAT-KEYS of arif-rachim/renox.rs: issues #454, #460, #451 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for type:contract issues. Do not ask me questions; if an issue blocks you, do what the rules say and continue with the next one.
```

Started 2026-11-05. #454 first (special case `type:contract`: the deploy API patch with `process_isolation: { enabled, own_ignored[] }` on the heartbeat, `NodeDetail.process_isolation`, `OpsTenant.process_effective`). #460 implements it end to end (worker heartbeat, a `control/api` migration, `getNode`, `getOpsTenant`, the console pages); it is blocked by #454, earlier in the batch. #451 (the re-encryption job for a `CONTROL_MASTER_KEY` rotation, filed by ONBOARD-1) is independent. Paths: `docs/contracts/**` for #454 only; `crates/renox-cell/src/control/**`, `control/api/src/{nodes,ops}/**`, `control/api/migrations/` and `control/dashboard/pages/ops/**` for #460; `control/api/src/secrets/**`, the sealing helper, `control/api/scripts/reseal.ts` and `ops/security/keys.md` for #451 (code-owner review of `ops/`). No overlap with GREEN-CI or TUTORIAL.

### Batch TUTORIAL — now — build a Renox app step by step (1 issue)

```
Work on batch TUTORIAL of arif-rachim/renox.rs: issue #430. Follow docs/25-execution.md section "Rules for the agent" exactly. Do not ask me questions; if the issue blocks you, do what the rules say and stop.
```

Started 2026-11-05. #430 (`[F7-43]`): a team task board built in ten chapters (`docs/tutorial/`) with one tested checkpoint app per chapter (`examples/tutorial/step-01` to `step-10`), a drift test between the chapters' code blocks and the checkpoints, `renox new --template tutorial`, and the pages in the docs navigation and `llms*.txt`; written against the released CLI (`cli-v0.1.3` at the start). Its blocker #428 is closed (DOTMATRIX). Paths: `examples/tutorial/**`, `docs/tutorial/**`, `cli/templates/tutorial/**`, one entry in `cli/src/lib/templates.ts`, one case in `cli/tests/new.test.ts`, `www/lib/docs.ts`, `www/scripts/llms.ts`; no file of GREEN-CI or DOCS-SYNC. The first-time user's run on a clean machine and the deployed app are the owner's to arrange.

### Gate F7 — after F67-ALL and F67-B, the products launched and the first paying tenant

```
Run the gate review issue #86 of arif-rachim/renox.rs. Follow docs/25-execution.md section "Rules for the agent", special case type:review. Write the report as a comment on the issue and stop.
```

Needs #74 and #79, the two F7 checklists, `docs/15` open questions resolved or re-dated and the licence ADR (owner), and the kill criterion checked: no paying tenant means Renox becomes an internal tool.

## F5 to F7: what can run in parallel

F4 to F7 are all split above (F7 on 2026-10-30). The gate review before each phase proposes the task split; then this file gets that phase's batches with the same method (F4 and F5 were split ahead of their gates, see above). The dependencies already recorded on the epics give the shape:

| Phase | Starts after | Parallel sessions inside the phase | Why not more |
| --- | --- | --- | --- |
| F4 modules | split into batches above (contracts now; code after gates F2 and F3) | 3 → 1 → 2 → 1: R1, R2, T1; then T2; then M1 and M2; then M3 | the broker (#230, #231) and the build (#235) are what every module waits for |
| F5 authz and realtime | C5 #299, F5-ALL #301, F56-ALL #314 done (#304, #305, #306 closed; #102 and #119 updated); #307 runs in F56-B | 1: one long session | #307 waits for `jobs` (#297), which waits for the contract #315, both earlier in F56-B |
| F6 reliability | F6-ALL #270, F6-B #300, F56-ALL #314 done; F56-B now (#315, #297, #307, the open halves of #295, #308, #310, #311, then #105, #122) | 1, then gate #79 | #297 and #308 wait for the contract #315, first in the batch; #312 waits for a host |
| F7 external customers | split on 2026-10-30 into #318–#337, run inside F67-ALL after the F6 remainder | 1: the owner's choice is one long session; the fallback split by paths is contracts (#318, #319), then Rust (#320–#322) beside the control plane (#323–#327), then the modules (#328–#336), then #337 | `admin` (#335) needs `billing`, `storage`, `audit`, `notifications` and `jobs`; the products (#337) need everything |

Two observations for the F2 gate to settle:

- F6's three epics only need F1 and F3 infrastructure. If the F5 gate turns out to be the bottleneck, change their "Blocked by" from #74 to #61 and start them with F4.
- F4 was split on 2026-10-29 (above). The broker is #230 (contexts, services, hooks) with the events and password ops in #231, so the service-call part lands first as suggested.

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
