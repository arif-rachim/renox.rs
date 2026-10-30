# authz evaluation on the dev container (#276)

| | |
| --- | --- |
| Date | 2026-10-29 |
| Host | **dev container** (not `node-small`): 4 vCPU Intel Xeon @ 2.80 GHz, Linux 6.18.44; other builds running on the host |
| Build | `cargo bench` (release profile), `cedar-policy` 4.14.0 |
| Scenario | `crates/renox-authz/benches/eval.rs`: 200 policies (role grants with an attribute condition, ownership permits, forbids on an attribute, forbids with `context.mfa_verified` or a role), 40 actions, one entity type with 4 attributes; a principal with 20 global roles; one allowed `check` with a resource. **cold**: entities built and Cedar evaluated every time (`Engine::check`); **cached**: the `DecisionCache` lookup, key hashing of the principal and the resource included |
| Target | `docs/11-authorization.md`, "Performance": evaluation ≤ 50 µs cached; #276: cold ≤ 500 µs |

## Result (criterion, 100 samples, [low median high])

| | time | target | |
| --- | --- | --- | --- |
| cold | [299.91 µs **308.37 µs** 318.60 µs] | ≤ 500 µs | met |
| cached | [1.42 µs **1.54 µs** 1.66 µs] | ≤ 50 µs | met |

Command: `cargo bench -p renox-authz --bench eval`.

## Reading

Dev-container numbers; the node that counts is `node-small` (O3, #158). The cold path is dominated by Cedar evaluating 200 policies; the cell caches decisions per principal and resource for the principal cache's TTL (`ops.md` Open 12), so a page that asks the same question again pays the cached cost.
