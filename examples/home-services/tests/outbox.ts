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
