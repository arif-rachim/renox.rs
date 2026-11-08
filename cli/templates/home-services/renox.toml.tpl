[app]
name = "{{APP}}"
timezone = "Asia/Dubai"

# No outbound host of the app's own: the whatsapp module declares
# graph.facebook.com for itself. The four secrets are the whatsapp module's.
[permissions]
network = []
secrets = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"]

[modules]
i18n = { version = "^1.0.0" }
auth = { version = "^1.0.0", config = { phone_login = true } }
org = { version = "^1.0.0" }
# twofa reads TWOFA_KEY (renox secrets set; tests: .env.test).
twofa = { version = "^1.0.0", mount = "/2fa" }
audit = { version = "^1.0.0" }
notifications = { version = "^1.0.0", mount = "/notifications", config = { channels = "whatsapp,email" } }
email = { version = "^1.0.0" }
whatsapp = { version = "^1.0.0", mount = "/whatsapp" }
# billing is booking's dependency; no PSP is configured (D31: no payments).
billing = { version = "^1.0.0" }
booking = { version = "^1.0.0", mount = "/booking", config = { slot_minutes = 30, hold_minutes = 10 } }
# The module's runs page is the operator's; /jobs is this app's own work list.
jobs = { version = "^1.0.0", mount = "/system/jobs" }
storage = { version = "^1.0.0", mount = "/files", config = { quota_mb = 500, max_upload_bytes = 10485760 } }
tax_gcc = { version = "^1.0.0", mount = "/tax", config = { seller_name = "FixIt Services LLC", seller_trn = "100000000000003", seller_address = "Dubai" } }
# The nightly summary (03:00 UTC, CSV by email) goes to the accounts email. The
# module reads its address from this config, which is static: it is the seed's
# `accounts_email` setting, and changing the setting does not change it.
reports = { version = "^1.0.0", mount = "/reports", config = { email_to = "accounts@fixit.example" } }
# The module's back office (users, audit, the dashboard cards of modules) is the
# operator's, like the jobs runs page; the owner's back office is this app's own
# /admin (pages/admin): the app's pages cannot share a path with a module's.
admin = { version = "^1.0.0", mount = "/system/admin", config = { base_path = "/system/admin" } }
gcc = { version = "^1.0.0" }

[authz]
actions = ["customer.read", "customer.write", "quote.read", "quote.write", "quote.approve", "job.read", "job.write", "job.dispatch", "visit.perform", "invoice.read", "invoice.issue", "invoice.pay", "contract.read", "contract.write", "report.view", "settings.read", "settings.write", "user.manage"]
sensitive = ["invoice.issue", "invoice.pay", "settings.write", "user.manage"]

[authz.default_roles]
owner = ["customer.read", "customer.write", "quote.read", "quote.write", "quote.approve", "job.read", "job.write", "job.dispatch", "visit.perform", "invoice.read", "invoice.issue", "invoice.pay", "contract.read", "contract.write", "report.view", "reports.view", "reports.export", "settings.read", "settings.write", "user.manage"]
branch_manager = ["customer.read", "customer.write", "quote.read", "quote.write", "quote.approve", "job.read", "job.write", "job.dispatch", "visit.perform", "invoice.read", "contract.read", "contract.write", "report.view"]
dispatcher = ["customer.read", "customer.write", "quote.read", "quote.write", "job.read", "job.write", "job.dispatch", "contract.read", "contract.write"]
technician = ["job.read", "visit.perform"]
accountant = ["invoice.read", "invoice.issue", "invoice.pay", "report.view", "reports.view", "reports.export", "customer.read", "job.read", "contract.read"]

# Customers and sites belong to one branch. The ownership rule fences them by
# `branch_id`: `owner` names the column that db.scoped({ user_id }) is compared
# to, and lib/scope.ts passes the branch id there. app__services is not owned:
# branch_id null means "every branch", which the fence ("branch_id = ?") cannot
# express, so the catalogue's loader filters it itself.
[authz.ownership]
app__customers = { owner = "branch_id" }
app__sites = { owner = "branch_id" }
# Quotations and their lines, the same way (each line repeats the quotation's
# branch_id). app__links and app__quote_numbers are not owned: a link is found
# by the hash of its token, and the number sequence is company-wide.
app__quotes = { owner = "branch_id" }
app__quote_lines = { owner = "branch_id" }

# Jobs and their timeline, the same way. app__job_numbers is the company-wide
# sequence, and app__branch_hours and app__booking_sync are read by branch id
# by lib/booking-sync.ts: none of the three is owned.
app__jobs = { owner = "branch_id" }
app__job_events = { owner = "branch_id" }

# Visits, their photos and their parts, the same way (each row repeats the
# job's branch_id).
app__visits = { owner = "branch_id" }
app__visit_photos = { owner = "branch_id" }
app__visit_parts = { owner = "branch_id" }

# What the customers are told and what they answer (F7-124): the preview of a
# sandboxed WhatsApp message and the dispatcher's tasks, the same way.
# app__inbox_seen is the sweep's own bookkeeping, not owned.
app__outbox_preview = { owner = "branch_id" }
app__tasks = { owner = "branch_id" }

# Invoices and their payments, the same way (each payment repeats the invoice's
# branch_id). app__invoice_status is a view: not ownable, so it is always read
# with an explicit branch_id (lib/invoices.ts).
app__job_invoices = { owner = "branch_id" }
app__payments = { owner = "branch_id" }

# Maintenance contracts, their items and the visits made for them (F7-126), the
# same way (each row repeats the contract's branch_id). app__contract_numbers is
# the company-wide sequence, not owned.
app__contracts = { owner = "branch_id" }
app__contract_items = { owner = "branch_id" }
app__contract_jobs = { owner = "branch_id" }

# Staff invitations (F7-128): the app role chosen for an invited person, the same way.
app__staff_invites = { owner = "branch_id" }

[authz.entities]
Customer = { table = "app__customers", attrs = ["branch_id", "kind"] }
Site = { table = "app__sites", attrs = ["branch_id", "customer_id"] }
Service = { table = "app__services", attrs = ["branch_id", "active"] }
# Job: `mine` ("yes"/"no") is computed for the signed-in user from
# technician_user_id (lib/jobs.ts jobResource): a technician reads only their own
# jobs (policies/app/base.cedar). Branch is what the dispatch socket's guard
# loads from its URL (`/ws/dispatch/dubai`: the slug), to compare its
# organisation with the principal's.
Job = { table = "app__jobs", attrs = ["branch_id", "status", "mine"] }
Branch = { table = "app__branches", id = "slug", attrs = ["org_id"] }

# Every committed change of a job reaches the board of its branch as
# `{ table, rowid, op }`; the transition also publishes the re-rendered card.
[realtime.feeds]
app__jobs = "jobs:{branch_id}"
