# examples/home-services

A reference app for UAE home-services and facility-management companies: booking, jobs, photo reports, quotes, invoices and yearly contracts for one company with several branches, built only from Renoxium's official modules. This is the skeleton (epic #554); the plan is `docs/plans/2026-11-07-home-services-reference-app.md`.

Modules: `i18n`, `auth`, `org`, `twofa`, `audit`, `notifications`, `email`, `whatsapp`, `billing`, `booking`, `jobs`, `storage`, `tax_gcc`, `reports`, `admin`, `gcc`.

Jobs (F7-122): `/jobs` (the branch's work, a technician sees only their own), `/jobs/new` (blank or from an approved quotation), `/jobs/<id>` (timeline, slot picker, assign, cancel) and `/dispatch`, the board that two dispatchers of a branch share live over `/ws/dispatch/<branch>`. Scheduling goes through the `booking` module (`lib/booking-sync.ts`); the `jobs` module's own runs page is mounted at `/system/jobs`.

The technician's visit (F7-123): `/me` (today's visits) and `/me/visits/<job id>` on a phone: check in (with the browser's position, if shared; the job becomes `in_progress`), photos before and after, parts, notes, the customer's drawn signature, check out (the job becomes `done`). Only the job's technician may perform it (`visit.perform`, with a policy on `mine`); dispatchers read the visit on `/jobs/<id>` and may edit its summary. Check-out drafts a two-sentence summary in English and Arabic with `ctx.ai` (empty when no AI is configured) and builds the report PDF (`lib/report.ts`, `partials/pdf/visit-report.{en,ar}.html`), served at `/visits/<visit id>/report?lang=en|ar`.

Visit report, what the platform does today: the PDF renderer of the worker reads no images (`crates/renox-runtime/src/ops/pdf.rs`: "No images, no includes"), although `ops.md` section 24 says an `<img>` may be a data URI or a `/_img` key. The report therefore lists each photo by phase and caption and names the signer; the templates already carry the `<img>` elements, so photos and the signature appear once the renderer reads them. A page action takes at most 1 MiB at the gateway, so the visit page scales a big photo down on the phone before it is posted; the 10 MiB limit of the `storage` module is the action's own check.

    bun install
    RENOX_WORKER_PATH=<renox-worker> bun ../../cli/src/main.ts check
    RENOX_WORKER_PATH=<renox-worker> bun ../../cli/src/main.ts test --seed seeds/001_demo.sql
