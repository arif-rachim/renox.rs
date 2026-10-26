## Issue

Closes #<number> (`[Fx-nn]`). Branch `<track>/<key>-<slug>`.

## What changed

<!-- Two or three sentences. What a reviewer should look at first. -->

## Verification

<!-- Commands run and their result. Benchmark result files under bench/results/ if any. -->

## Security

Answer each question. "No" is a fine answer; a blank is not.

- New input from the network or from tenant code (header, body, op argument, file, message)? **No / Yes:** <!-- how it is limited and validated -->
- New place a secret flows through (log, error, response, artifact, CI, backup)? **No / Yes:** <!-- how it is redacted or excluded -->
- New table, op, route, header, or permission? **No / Yes:** <!-- authorizer, policy, or limit that governs it -->
- Row(s) in `docs/24-threat-model.md` or `docs/23-failure-modes.md` this PR proves or changes: <!-- row name → test name -->

## Checklist

- [ ] Only directories owned by this issue's track were touched (`docs/22-development-plan.md` section 3)
- [ ] No ADR in `docs/13-decisions.md` was changed silently
- [ ] Everything is in English
