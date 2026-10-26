# CLAUDE.md

Read `AGENTS.md` first. All rules, the documentation reading order, and the repository layout are there.

The summary you will need most often:

- Project: multi-tenant hosting platform for TypeScript applications. Rust data plane (V8 isolates on Supabase Edge Runtime, SQLite per tenant), Bun control plane.
- Status: phase F0 (spike). No platform code yet; the only code allowed is the benchmarks from `docs/14-benchmarks.md`.
- Architecture decisions are binding: `docs/13-decisions.md`. Change them through a new ADR, never a silent edit.
- Security: per-tenant limits are enforced in Rust; tenant `fetch` blocks private addresses; module SQL goes through the SQLite authorizer; secrets never reach logs.
- Language: everything in English.
