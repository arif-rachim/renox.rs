// The texts of the messages to customers: one entry per kind in
// i18n/whatsapp.en.json and whatsapp.ar.json, with `{placeholders}`. The same
// entry is the WhatsApp template (its name, and its parameters in the order
// the placeholders first appear in the body, as Meta's {{1}}, {{2}} do) and the
// email (subject and body). The customer's language picks the file.
import ar from "../i18n/whatsapp.ar.json";
import en from "../i18n/whatsapp.en.json";

export const KINDS = ["quote_sent", "visit_scheduled", "technician_on_the_way", "report_ready", "invoice_due", "amc_renewal", "booking_received"] as const;
export type MessageKind = (typeof KINDS)[number];
export type Language = "en" | "ar";

type Entry = { template: string; subject: string; body: string };
const TEXTS: Record<Language, Record<MessageKind, Entry>> = { en, ar };

export type Rendered = { template: string; language: Language; subject: string; body: string; params: string[] };

const PLACEHOLDER = /\{([a-z_]+)\}/gu;

const fill = (text: string, vars: Record<string, string>): string => text.replace(PLACEHOLDER, (_m, k: string) => vars[k] ?? "");

/** The message of `kind` in `language`: subject and body filled in from `vars`, and the template parameters. */
export function renderMessage(kind: MessageKind, language: Language, vars: Record<string, string>): Rendered {
  const e = TEXTS[language][kind];
  const names: string[] = [];
  for (const m of e.body.matchAll(PLACEHOLDER)) if (!names.includes(m[1] as string)) names.push(m[1] as string);
  return { template: e.template, language, subject: fill(e.subject, vars), body: fill(e.body, vars), params: names.map((n) => vars[n] ?? "") };
}
