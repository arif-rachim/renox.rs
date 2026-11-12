// GET /admin/whatsapp: what the `whatsapp` module sent, for the owner (`settings.read`): the last 50 outgoing
// messages of `whatsapp.outbox()`, newest first, with the time, the recipient (only the last four digits show), the
// template or the first 80 characters of the text, and the status. `?status=failed` and `?phone=<number>` narrow the
// list (the phone is matched on the number as the customer form normalises it); with a filter the last 200 messages
// are searched, the most the service returns. Read only: no resend. The module hides an OTP's code (its body is
// `[otp]`) and this page shows the body as it gets it.
import type { LoaderContext } from "@renoxium/sdk";
import { gcc, whatsapp } from "renox:modules";

import { OFFSET_MS } from "../../lib/booking-sync";
import { shell } from "../../lib/page";

export const guard = { action: "settings.read" };

/** The statuses of an outgoing message (the whatsapp module's README, "Sending never blocks a request"). */
export const STATUSES = ["queued", "sent", "delivered", "read", "failed"] as const;
const SHOWN = 50;
const MAX = 200;

/** `+971•••••••0001`: the last four digits of a phone, the others masked. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/gu, "");
  return `${phone.startsWith("+") ? "+" : ""}${"•".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

/** What the message says: a template's name, or the first 80 characters of a text. */
function summary(kind: string, body: string): { template: string; text: string } {
  if (kind === "template") {
    try {
      const name = (JSON.parse(body) as { name?: unknown }).name;
      if (typeof name === "string") return { template: name, text: "" };
    } catch {
      /* a body that is no JSON is shown as text */
    }
  }
  const chars = [...body];
  return { template: "", text: chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : body };
}

/** `YYYY-MM-DD HH:MM` in the company's time zone. */
const when = (ms: number): string => new Date(ms + OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const askedStatus = ctx.url.searchParams.get("status") ?? "";
  const status = (STATUSES as readonly string[]).includes(askedStatus) ? askedStatus : "";
  const askedPhone = (ctx.url.searchParams.get("phone") ?? "").trim().slice(0, 40);
  let phone: string | null = null;
  if (askedPhone !== "") {
    const p = await gcc.validatePhone(askedPhone);
    phone = p.ok ? p.value : "";
  }
  const filtered = status !== "" || askedPhone !== "";
  const sent = await whatsapp.outbox(filtered ? MAX : SHOWN);
  const rows = sent.filter((m) => (status === "" || m.status === status) && (phone === null || m.phone === phone)).slice(0, SHOWN);
  return {
    ...page,
    status,
    phone: askedPhone,
    statuses: STATUSES.map((s) => ({ value: s, current: s === status })),
    filtered,
    messages: rows.map((m) => ({ id: m.id, kind: m.kind, when: when(m.at), phone: maskPhone(m.phone), status: m.status, ...summary(m.kind, m.body) })),
  };
}
