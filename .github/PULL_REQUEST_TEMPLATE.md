## Issue

Closes #<number> (`[Fx-nn]`). Branch `<track>/<key>-<slug>`.

## ADR or docs section

<!-- The ADR in docs/13-decisions.md or the docs section this PR implements. -->

## What changed

<!-- Two or three sentences. What a reviewer should look at first. -->

## Verification

<!-- Commands run and their result. Benchmark result files under bench/results/ if any. -->

## What was measured (if any)

<!-- Benchmark IDs and result files under bench/results/, or "Nothing". -->

## Security

Answer each question. "No" is a fine answer; a blank is not.

- New input from the network or from tenant code (header, body, op argument, file, message)? **No / Yes:** <!-- how it is limited and validated -->
- New place a secret flows through (log, error, response, artifact, CI, backup)? **No / Yes:** <!-- how it is redacted or excluded -->
- New table, op, route, header, or permission? **No / Yes:** <!-- authorizer, policy, or limit that governs it -->
- Row(s) in `docs/24-threat-model.md` or `docs/23-failure-modes.md` this PR proves or changes: <!-- row name → test name -->

## Differences from the issues

<!-- Where the code differs from what the issue text assumed, or "None". -->

## Skipped

<!-- Issues of the batch left out and why, or "None". -->

## Checklist

- [ ] fmt / clippy / tests pass (`make check test`)
- [ ] Docs updated in the same PR for architectural changes
- [ ] Only directories owned by this issue's track were touched (`docs/22-development-plan.md` section 3)
- [ ] No ADR in `docs/13-decisions.md` was changed silently
- [ ] Everything is in English
