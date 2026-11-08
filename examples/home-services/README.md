# examples/home-services

A reference app for UAE home-services and facility-management companies: booking, jobs, photo reports, quotes, invoices and yearly contracts for one company with several branches, built only from Renoxium's official modules. This is the skeleton (epic #554); the plan is `docs/plans/2026-11-07-home-services-reference-app.md`.

Modules: `i18n`, `auth`, `org`, `twofa`, `audit`, `notifications`, `email`, `whatsapp`, `billing`, `booking`, `jobs`, `storage`, `tax_gcc`, `reports`, `admin`, `gcc`.

Jobs (F7-122): `/jobs` (the branch's work, a technician sees only their own), `/jobs/new` (blank or from an approved quotation), `/jobs/<id>` (timeline, slot picker, assign, cancel) and `/dispatch`, the board that two dispatchers of a branch share live over `/ws/dispatch/<branch>`. Scheduling goes through the `booking` module (`lib/booking-sync.ts`); the `jobs` module's own runs page is mounted at `/system/jobs`.

    bun install
    RENOX_WORKER_PATH=<renox-worker> bun ../../cli/src/main.ts check
    RENOX_WORKER_PATH=<renox-worker> bun ../../cli/src/main.ts test --seed seeds/001_demo.sql
