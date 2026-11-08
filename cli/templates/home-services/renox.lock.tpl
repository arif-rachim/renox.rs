# Written by renox (renox add, renox remove); do not edit by hand (docs/contracts/manifest.md, MF12).
version = 1

[[module]]
name = "audit"
version = "1.0.0"
source = "official"
hash = "af95c4f9be252e48ae6bc1ab43f824697758b2c2352c391774c08e3cb6c03057"
isolation = "shared"
mount = "/audit"
dependencies = []
config = { retain_days = 365 }
approved = { tables = "audit__*", network = [], secrets = [], slots = [], hooks = [] }

[[module]]
name = "gcc"
version = "1.0.0"
source = "official"
hash = "bf2c22df6ed2077db93417c069aa27d820d6dc3acaaf024fb0eca8df67c7c550"
isolation = "shared"
mount = "/gcc"
dependencies = []
config = {}
approved = { tables = "gcc__*", network = [], secrets = [], slots = [], hooks = [] }

[[module]]
name = "i18n"
version = "1.0.0"
source = "official"
hash = "c91ad7f525744b571d23550a7aba0ab862159629874d02abf891f37a5c890b81"
isolation = "shared"
mount = "/i18n"
dependencies = []
config = { locales = "en,ar", default_locale = "en", digits = "latn", calendar = "gregory" }
approved = { tables = "i18n__*", network = [], secrets = [], slots = [], hooks = [] }

[[module]]
name = "auth"
version = "1.0.0"
source = "official"
hash = "b6b1aaba1da4cb3ca6c3604806fa2ac1da3332fe199b2fb4a8b9a027de4cd411"
isolation = "shared"
mount = "/auth"
dependencies = ["i18n"]
config = { session_idle_hours = 24, session_absolute_days = 30, password_min_length = 12, login_path = "/auth/login", google_client_id = "", github_client_id = "", microsoft_client_id = "", uaepass_client_id = "", uaepass_env = "staging", phone_login = true, passkeys = false, passkey_rp_id = "", passkey_origin = "" }
approved = { tables = "auth__*", network = ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com", "github.com", "api.github.com", "login.microsoftonline.com", "graph.microsoft.com", "stg-id.uaepass.ae", "id.uaepass.ae"], secrets = ["AUTH_GOOGLE_CLIENT_SECRET", "AUTH_GITHUB_CLIENT_SECRET", "AUTH_MICROSOFT_CLIENT_SECRET", "AUTH_UAEPASS_CLIENT_SECRET"], slots = ["app.header"], hooks = [] }

[[module]]
name = "admin"
version = "1.0.0"
source = "official"
hash = "9efa4220677750186c5f2e70846746ce477f9da045046f37aaa28df77bf8c5db"
isolation = "shared"
mount = "/system/admin"
dependencies = ["audit", "auth", "i18n"]
config = { base_path = "/system/admin", title = "Admin" }
approved = { tables = "admin__*", network = [], secrets = [], slots = [], hooks = [] }

[[module]]
name = "billing"
version = "1.0.0"
source = "official"
hash = "50217d15ce3cbb7af219ad04310f62bca5dd311fff262d5e7daa7287d074feaa"
isolation = "shared"
mount = "/billing"
dependencies = ["auth", "i18n"]
config = { currency = "AED", success_url = "/billing/thanks", cancel_url = "/billing", base_path = "/billing", methods = "card", bank_name = "", bank_beneficiary = "", bank_iban = "" }
approved = { tables = "billing__*", network = ["api.stripe.com"], secrets = ["BILLING_STRIPE_KEY", "BILLING_WEBHOOK_STRIPE_SECRET"], slots = ["admin.sidebar"], hooks = [] }

[[module]]
name = "jobs"
version = "1.0.0"
source = "official"
hash = "f4ebf4cf30f1c4b7701e31b3d1aa712aa1875ddd0fd4f0a09d4f782310e95275"
isolation = "shared"
mount = "/system/jobs"
dependencies = ["auth", "i18n"]
config = { base_path = "/jobs" }
approved = { network = [], secrets = [], slots = ["admin.sidebar"], hooks = [] }

[[module]]
name = "notifications"
version = "1.0.0"
source = "official"
hash = "4f4d321b357767a71860bd0bd37ad9bd8208c67658301db348b4505bd948237e"
isolation = "shared"
mount = "/notifications"
dependencies = ["auth", "i18n"]
config = { base_path = "/notifications", channels = "whatsapp,email" }
approved = { tables = "notifications__*", network = [], secrets = [], slots = ["app.header", "admin.sidebar"], hooks = [] }

[[module]]
name = "org"
version = "1.0.0"
source = "official"
hash = "7504cf39710d2c852f40d93f458e8e823c212a661908462dbda58d9fec15d70f"
isolation = "shared"
mount = "/org"
dependencies = ["auth", "i18n"]
config = { base_path = "/org", invite_days = 7 }
approved = { tables = "org__*", network = [], secrets = [], slots = ["app.header", "admin.sidebar"], hooks = ["auth.principal"] }

[[module]]
name = "email"
version = "1.0.0"
source = "official"
hash = "17c9c32bd49fdaadec430676684fe57ef8e365d897a06587a1be3d4f46c3b6ca"
isolation = "shared"
mount = "/email"
dependencies = ["auth", "i18n"]
config = { provider = "resend", from = "", ses_region = "me-central-1", sends_per_minute = 120, base_path = "/email" }
approved = { tables = "email__*", network = ["api.resend.com", "email.me-central-1.amazonaws.com", "email.eu-west-1.amazonaws.com", "email.us-east-1.amazonaws.com"], secrets = ["EMAIL_RESEND_KEY", "EMAIL_SES_ACCESS_KEY", "EMAIL_SES_SECRET_KEY", "EMAIL_WEBHOOK_SECRET"], slots = [], hooks = ["notifications.deliver", "auth.send_mail", "org.send_mail"] }

[[module]]
name = "booking"
version = "1.0.0"
source = "official"
hash = "63a5369115e2fb2e53ea40e1d13d9c4b94871628dbdd2b479d2343fe87d66651"
isolation = "shared"
mount = "/booking"
dependencies = ["auth", "billing", "email", "i18n"]
config = { slot_minutes = 30, hold_minutes = 10, base_path = "/booking" }
approved = { tables = "booking__*", network = [], secrets = [], slots = [], hooks = [] }

[[module]]
name = "storage"
version = "1.0.0"
source = "official"
hash = "edbfd7df6c760766674c79623d8aa24af970d3d84987fb0756429aec92d0a9dc"
isolation = "shared"
mount = "/files"
dependencies = ["auth", "i18n"]
config = { max_upload_bytes = 10485760, allow_svg = false, quota_mb = 500, base_path = "/files" }
approved = { network = [], secrets = [], slots = ["admin.sidebar"], hooks = [] }

[[module]]
name = "tax_gcc"
version = "1.0.0"
source = "official"
hash = "d246a8f4f548c4af1201e31a243bbe990fe4b4220365c090f260df9762b3e9a1"
isolation = "shared"
mount = "/tax"
dependencies = ["auth", "i18n"]
config = { seller_name = "FixIt Services LLC", seller_trn = "100000000000003", seller_address = "Dubai", prefix = "INV", base_path = "/tax" }
approved = { tables = "tax_gcc__*", network = [], secrets = [], slots = [], hooks = [] }

[[module]]
name = "reports"
version = "1.0.0"
source = "official"
hash = "ff1db1530bd04699df641f5b555f0cbc648bbf148a35ea46f3cbf7d8c4fcdca4"
isolation = "shared"
mount = "/reports"
dependencies = ["auth", "email", "i18n", "tax_gcc"]
config = { email_to = "accounts@fixit.example", base_path = "/reports" }
approved = { tables = "reports__*", network = [], secrets = [], slots = [], hooks = [] }

[[module]]
name = "twofa"
version = "1.0.0"
source = "official"
hash = "bdb7c0d207c3c46654d151b4e9367060d7882504bf759f4e01739825bbce7560"
isolation = "shared"
mount = "/2fa"
dependencies = ["auth", "i18n"]
config = { step_up_minutes = 15, allow_totp = true, allow_passkeys = true, recovery_codes = 10, issuer = "", base_path = "/2fa", passkey_rp_id = "", passkey_origin = "" }
approved = { tables = "twofa__*", network = [], secrets = ["TWOFA_KEY"], slots = ["account.sections"], hooks = ["auth.after_login", "auth.principal"] }

[[module]]
name = "whatsapp"
version = "1.0.0"
source = "official"
hash = "c332b16993958f70ddfbc2b9b19243df66a44ed75df5e07426f96cea86618215"
isolation = "shared"
mount = "/whatsapp"
dependencies = []
config = { api_version = "v21.0", sends_per_minute = 60, otp_template = "", otp_language = "en" }
approved = { tables = "whatsapp__*", network = ["graph.facebook.com"], secrets = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"], slots = [], hooks = ["notifications.deliver", "auth.send_otp"] }
