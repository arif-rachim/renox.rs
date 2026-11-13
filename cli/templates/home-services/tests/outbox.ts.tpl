// What the `whatsapp` module sent (sandbox: recorded as sent, no API call). The
// module's `outbox(limit)` service is `inbox({ direction: "out" })` over its table
// `whatsapp__messages`; a test reads that table the same way (the test harness
// cannot call a module service). A template's body is `{ name, language,
// components }` as JSON, the components being what the Cloud API would receive;
// until the module's outbox handler has run, the row still holds `{ name,
// language, params }` as queued, and both forms are read.
export interface Sent {
  kind: string;
  phone: string;
  status: string;
  /** The template's name, empty for a text. */
  template: string;
  language: string;
  /** The template's body parameters in order. */
  params: string[];
  /** The parameters joined by a space: what a test looks for a name, a number or a link in. */
  text: string;
}

type Query = (sql: string, params?: (string | number | null)[]) => Record<string, unknown>[];

/** The outgoing messages to `phone` (E.164), oldest first. */
export function outboxOf(query: Query, phone: string): Sent[] {
  return query("select kind, phone, body, status from whatsapp__messages where direction = 'out' and phone = ? order by at, id", [phone]).map((r) => {
    let name = "";
    let language = "";
    let params: string[] = [];
    if (r.kind === "template") {
      const b = JSON.parse(String(r.body)) as { name: string; language: string; params?: string[]; components?: { parameters?: { text: string }[] }[] };
      name = b.name;
      language = b.language;
      params = b.params ?? (b.components ?? []).flatMap((c) => (c.parameters ?? []).map((p) => p.text));
    }
    return { kind: String(r.kind), phone: String(r.phone), status: String(r.status), template: name, language, params, text: params.join(" ") };
  });
}

type Write = (sql: string, params: (string | number | null)[]) => void;

/** The code the tests sign in by phone with. */
export const TEST_CODE = "424242";

/**
 * Signs `who` in by phone through auth's real pages: `/auth/phone` asks for a
 * code (with `phone_signup`, a number with no account gets one too) and
 * whatsapp's `auth.send_otp` filler queues it; `/auth/phone/verify` checks it.
 * The queued code cannot be read back: it is sealed, and the module's outbox
 * handler empties the body once it is sent, which races the test. So the test
 * checks that a code went out, then replaces auth's stored argon2id hash of it
 * (auth__phone_codes for an account, auth__phone_signups for a new number)
 * with one of TEST_CODE, and enters that. Returns the verify page's answer: a
 * 303 to `next`, or the response of an `auth.after_login` filler that halted
 * the sign-in.
 */
export async function phoneSignIn<R extends { status: number }>(who: { action(path: string, name: string, form: Record<string, string>): Promise<R> }, query: Query, write: Write, phone: string, next = "/"): Promise<R> {
  const sent = await who.action("/auth/phone", "default", { phone, next });
  if (sent.status !== 303) throw new Error(`/auth/phone answered ${sent.status} for ${phone}`);
  if (query("select id from whatsapp__messages where direction = 'out' and kind = 'otp' and phone = ?", [phone]).length === 0) throw new Error(`no code was sent to ${phone}`);
  const hash = await Bun.password.hash(TEST_CODE, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
  write("update auth__phone_codes set code_hash = ? where phone = ? and purpose = 'login'", [hash, phone]);
  write("update auth__phone_signups set code_hash = ? where phone = ?", [hash, phone]);
  return who.action("/auth/phone/verify", "default", { phone, code: TEST_CODE, next });
}
