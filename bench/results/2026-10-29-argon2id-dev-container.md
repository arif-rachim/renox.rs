# argon2id hash time on the dev container (#275)

| | |
| --- | --- |
| Date | 2026-10-29 |
| Host | **dev container** (not `node-small`): 4 vCPU Intel Xeon @ 2.80 GHz, Linux 6.18.44 |
| Build | `cargo test` debug profile; dependencies at `opt-level = 1` (workspace `[profile.dev.package."*"]`), so the `argon2` crate is optimised but not at release level |
| Scenario | `crates/renox-runtime/tests/password.rs` `argon2id_hash_time_at_the_platform_parameters`: 5 hashes of distinct passwords through `renox_runtime::ops::password::hash`, one at a time, at the platform parameters m = 64 MiB, t = 3, p = 1 (`ops.md` 1.3.0 section 16) |
| Target | none of its own: `docs/24-threat-model.md` A, "Login brute force" asks for the number; `ops.md` Open 6 lists the `node-small` run |

## Result

| | ms |
| --- | --- |
| median | 449.0 |
| min | 291.8 |
| max | 1067.9 |

Command: `cargo test -p renox-runtime --test password -- --nocapture`. The test also asserts the PHC string carries `m=65536,t=3,p=1`, a median above 5 ms (the memory cost is applied), and below 5 s.

## Reading

This is a dev-container number from a debug test build with other compilations running on the host, so it overstates the cost on a release worker. It is recorded because `docs/24` asks for the measured cost; the number that counts is the release `renox-worker` on `node-small`, which stays with O3 (#158).
