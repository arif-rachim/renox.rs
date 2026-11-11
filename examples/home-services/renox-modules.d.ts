// The part of `renox:modules` the app uses so far: auth's currentUser, storage's signed uploads, i18n's
// detectLocale, notifications' badge and notify, whatsapp's templates and inbox, email's
// raw send, tax_gcc's invoices, reports' csv, twofa's step-up, org's switcher and gcc's validators.
// Later sub-issues add what they call.
// `renox dev` writes the complete, generated types to .renox/types/ (#236);
// this file keeps `bun run check` working without them.
declare module "renox:modules" {
  export const auth: {
    currentUser(): Promise<{ id: string; email: string; display_name: string } | null>;
    /** The account and a confirmation (sign-in) link by mail; the same `message` whether or not the email was taken (#711: the setup's owner). */
    register(input: { email: string; password: string; display_name?: string }): Promise<{ message: string } | { error: string }>;
  };
  export const i18n: {
    detectLocale(who?: { user_id?: string | null; org_locale?: string | null }): Promise<{ locale: string; dir: "ltr" | "rtl"; alternates: { locale: string; href: string; current: boolean }[] }>;
  };
  export const notifications: {
    badge(): Promise<{ unread: number } | null>;
    notify(user: string, item: { category: string; title: string; body?: string; link?: string }): Promise<{ id: number | null; channels: string[] }>;
  };
  export const whatsapp: {
    /** Queues an approved template; the module's outbox sends it. `to` is E.164. */
    sendTemplate(to: string, name: string, params?: string[], language?: string): Promise<{ id: string }>;
    send(to: string, text: string): Promise<{ id: string }>;
    /** Messages newest first; an inbound one has direction "in". */
    /** Outgoing messages newest first (a sandbox app's would-have-sent list); a template's body is `{ name, language, components }` as JSON. */
    outbox(limit?: number): Promise<{ id: string; direction: "in" | "out"; kind: string; phone: string; body: string; status: string; at: number }[]>;
    inbox(filter?: { phone?: string; direction?: "in" | "out"; limit?: number }): Promise<{ id: string; direction: "in" | "out"; kind: string; phone: string; body: string; status: string; at: number }[]>;
  };
  export const email: {
    sendRaw(msg: { to: string; subject: string; text?: string; html?: string; reply_to?: string; from_name?: string }): Promise<{ id: string | null; cancelled?: true }>;
    isSuppressed(address: string): Promise<boolean>;
  };
  /** The tax_gcc module: FTA tax invoices and credit notes (amounts in fils). */
  export const tax_gcc: {
    issue(input: { buyer: { name: string; trn?: string; address?: string }; lines: { description: string; quantity: number; unit_fils: number; rate?: "standard" | "zero" | "exempt" }[] }): Promise<unknown>;
    creditNote(invoice: string, lines: unknown[] | undefined, reason: string): Promise<unknown>;
    invoice(number: string): Promise<unknown | null>;
  };
  /** The storage module: a folder per owner under `storage/<owner>/`; signed uploads, links and listings (the app's own `ctx.storage` is confined to `app/`). */
  export const storage: {
    /** A signed URL for one browser PUT into the owner's folder; `maxBytes` is capped at the module's `max_upload_bytes`; never SVG. */
    uploadUrl(owner: string, name: string, options: { contentType: string; maxBytes: number; public?: boolean }): Promise<{ url: string; expires_at: number; max_bytes: number; key: string }>;
    list(owner: string, options?: { limit?: number; cursor?: string | null }): Promise<{ items: { key: string; bytes: number; content_type: string; sha256: string; width: number | null; height: number | null; public: boolean; created_at: number }[]; next_cursor: string | null }>;
    link(owner: string, name: string, ttlSeconds: number): Promise<{ url: string; expires_at: number }>;
  };
  /** The reports module: the app's own reports are exported through `csv` (amounts stay in the rows' units). */
  export const reports: {
    /** Rows as RFC 4180 CSV with a UTF-8 BOM and a formula guard; `headers` orders the columns. */
    csv(rows: readonly Record<string, unknown>[], headers?: string[]): Promise<string>;
    /** Rows as a one-sheet .xlsx (bytes): numbers stay numbers, strings are never formulas; `sheet` is 1 to 31 characters. */
    xlsx(sheet: string, rows: readonly (readonly (string | number | null)[])[]): Promise<Uint8Array>;
    /** The first sheet of an .xlsx as rows of cells (a gap is null, rows padded to the widest); throws for a file that is no .xlsx, over 10 MiB or over 100,000 cells. */
    readXlsx(bytes: Uint8Array): Promise<(string | number | null)[][]>;
    /** The nightly report for the day before `nowMs`: kept as a snapshot and emailed to the addresses of the `reports.nightly_to` fillers (else `email_to`). */
    nightly(nowMs: number): Promise<{ day: string; sent_to: string | null }>;
  };
  export const twofa: {
    /** Whether a user has a second factor. */
    isEnrolled(userId: string): Promise<boolean>;
    /** Resolves when this session verified a second factor recently; else throws STEP_UP_REQUIRED (403). */
    requireRecent(opts?: { within?: number; next?: string }): Promise<void>;
  };
  export const org: {
    switcher(next?: string): Promise<{ current?: { id: string; locale?: string | null } | null } | null>;
    /** The members of an organisation (the caller must be one). */
    members(orgId: string): Promise<{ user_id: string; display_name: string; email: string; role: string }[]>;
    /** A new organisation (the caller owns it and it becomes the active one) or the reason it was refused. */
    createOrg(input: { name: string; slug?: string }): Promise<{ org: { id: string; slug: string; name: string } } | { error: string }>;
    switchOrg(orgId: string): Promise<{ org: { id: string } } | { error: string }>;
    listOrgs(userId: string): Promise<{ id: string; slug: string; name: string; role: string }[]>;
    /** Invites by email (admin or owner of the organisation); the link goes out through the email module. */
    invite(input: { org: string; email: string; role?: "member" | "admin" | "owner" }): Promise<{ invite_id: string; expires_at: number } | { error: string }>;
    removeMember(input: { org: string; user: string }): Promise<{ ok: true } | { error: string }>;
    /** Renames an organisation (admin or owner; 1 to 80 characters); the slug stays. */
    rename(input: { org: string; name: string }): Promise<{ ok: true } | { error: string }>;
  };
  export const audit: {
    /** The trail, newest first (needs `audit.read`): the module's rows merged with the platform's decisions on sensitive actions. */
    query(filter?: { actor?: string; action?: string; since?: number; until?: number; platform?: boolean; limit?: number; cursor?: string }): Promise<{ events: { id: string; at: number; kind?: string; actor_kind?: string; actor_id?: string; action: string; result: string; resource_type?: string; resource_id?: string; details?: unknown }[]; next: string | null }>;
    record(event: { action: string; actor: { kind: "user" | "agent" | "system"; id: string; client?: string }; resource?: { type: string; id?: string }; result?: "ok" | "denied" | "failed"; details?: Record<string, unknown>; request_id?: string }): Promise<{ id: string }>;
  };
  /** A free start of a day: `start` and `end` are unix milliseconds, `staff` the booking staff id (here: the technician's user id). */
  type Slot = { start: number; end: number; staff: string };
  export const booking: {
    addService(s: { id: string; name: string; minutes: number; buffer?: number; deposit_fils?: number; cancel_hours?: number }): Promise<{ id: string }>;
    addStaff(s: { id: string; name: string; user_id?: string; services: string[] }): Promise<{ id: string }>;
    setHours(staff: string, when: number | string, openMin: number, closeMin: number): Promise<true>;
    slots(service: string, day: string, opts?: { staff?: string }): Promise<Slot[]>;
    hold(service: string, staff: string, start: number, customer: string): Promise<{ id: string; expires_at: number; pay_url: string | null }>;
    confirm(id: string): Promise<{ id: string; status: string }>;
    cancel(id: string): Promise<boolean>;
  };
  /** Each validator answers the normalised value or the reason it failed. */
  type Checked = { ok: true; value: string } | { ok: false; reason: string };
  export const gcc: {
    validatePhone(s: unknown): Promise<Checked>;
    validateTrn(s: unknown): Promise<Checked>;
    validateMakani(s: unknown): Promise<Checked>;
    listAreas(emirate: string): Promise<{ id: number; emirate: string; name_en: string; name_ar: string; makani: number }[]>;
  };
}
