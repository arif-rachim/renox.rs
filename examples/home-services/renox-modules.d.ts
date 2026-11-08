// The part of `renox:modules` the app uses so far: auth's currentUser, i18n's
// detectLocale, notifications' badge and notify, whatsapp's templates and inbox, email's
// raw send, org's switcher and gcc's validators.
// Later sub-issues add what they call.
// `renox dev` writes the complete, generated types to .renox/types/ (#236);
// this file keeps `bun run check` working without them.
declare module "renox:modules" {
  export const auth: {
    currentUser(): Promise<{ id: string; email: string; display_name: string } | null>;
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
    inbox(filter?: { phone?: string; direction?: "in" | "out"; limit?: number }): Promise<{ id: string; direction: "in" | "out"; kind: string; phone: string; body: string; status: string; at: number }[]>;
  };
  export const email: {
    sendRaw(msg: { to: string; subject: string; text?: string; html?: string; reply_to?: string }): Promise<{ id: string | null; cancelled?: true }>;
    isSuppressed(address: string): Promise<boolean>;
  };
  export const org: {
    switcher(next?: string): Promise<{ current?: { id: string; locale?: string | null } | null } | null>;
    /** The members of an organisation (the caller must be one). */
    members(orgId: string): Promise<{ user_id: string; display_name: string; email: string; role: string }[]>;
  };
  export const audit: {
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
