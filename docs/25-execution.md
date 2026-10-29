# 25 — Execution: batches

One session takes one **batch** of issues and works through them in the order listed, on one branch, ending in one PR that closes all of them. "After X" means: start the batch only after the PR of batch X is merged. Batches with the same "after" can run at the same time in separate sessions; they never touch the same crate or package.

Open Claude Code in the repository root and paste the batch's prompt. Merge with `gh pr merge <PR> --squash --delete-branch`, then remove the batch worktree if the session created one (`git worktree remove ../renox-<batch>`).

Issue #87 (UAE entity and bank account) is yours, not a session; it is needed before the first external tenant (F3 done criteria).

Prompts of finished batches are kept as the record of what ran; the status line under each heading says what happened.

## Where we are (2026-10-29)

| Phase | Done (PR) | Running | Next |
| --- | --- | --- | --- |
| F0 | A #130, B #131 #132, gate #133 (GO) | — | — |
| F1 | C #134, D #136, E #137, F #138, G #135, G2 #140, H #148, H2 #151, I (checklists), gate #165 (GO) | — | — |
| F2 | J0 #172, H3 #171, H4 #190, J #178, K #176, L #177, M #185, N #191, O #197 (#42 only), O2 #195, Y #198, Y2 #204 (#201, #157, #111), Y3 #210 (#207, #139 Linux arm64), Y4 #211 | — | Y5 (#170, #182) and P (#94, #112) now; O3 after the owner's two bench hosts (#158); gate #49 after P and O3. #212 (macOS CPU clock) needs a Mac and blocks no gate |
| F3 | Q #169, R #183, S #181, T #196 (#162 only), U0 #194, R2 #203, T2 #205, U #209 (#58, #60, #62), U2 #215, V #216 (#164 only), V2 #220 (#57 except its logs screen), T3 #221 | — | V3 (#222, #223, #128) now; U3 (#219) after the owner tags `worker-v0.2.0`; W after P and V3; gate #61 after W and O3 |

Issues created outside the batches since the F1 gate: #182 (timing-dependent tests), #184 (deploy API 0.1 contract), #186 and #189 (CI), #199 (control/api node endpoints), #201 (ops 1.1.1 after the isolate pool), #206 (ops 1.2.0 streamed body, the contract #161 needs), #207 (tenant `Set-Cookie` domain rule at the gateway, found by #114), #212 (macOS CPU clock accuracy, split from #139), #213 (docs after Y3 and Y4), #218 (D23 follow-ups: node-facing endpoints off the public edge), #219 (pin the CLI to a signed worker release), #222 and #223 (the contract and the `streamLogs` endpoint that #128 and the dashboard's Logs screen need), all placed in the batches below. Owner prerequisites: two bench hosts for #158 (`node-small` and a load generator, SSH addresses in the issue), which is the critical path to gate F2, P, W and gate F3; the `worker-v0.2.0` tag from `main` (signed, both Linux targets) for #219; and a Mac for #212, which blocks no gate. Owner prerequisite: #158 needs two bench hosts (`node-small` and a load generator) reachable over SSH; see the issue.

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

### Batch W — after P and V3 — the two checklists (2 issues)

```
Work on batch W of arif-rachim/renox.rs: issues #99, #116 in that order. Follow docs/25-execution.md section "Rules for the agent" exactly, including the special case for checklist issues. Do not ask me questions.
```

#116 needs #112 (P); #99 needs #128 (V3). Neither needs the bench hosts, so W can run as soon as P and V3 are in, before gate F2.

### Gate F3 — after W, O3 and gate F2

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
