// What a customer's WhatsApp text asks for (lib/inbox.ts acts on it). No module is
// imported here, so a test can run it.

export type ReplyKind = "cancel" | "reschedule";

/** What the text asks for, or null. Case, surrounding space and punctuation do not matter. */
export function replyKind(text: string): ReplyKind | null {
  const t = text.normalize("NFKC").toLowerCase().replace(/[\s.!?,"'«»]+/gu, " ").trim();
  if (t === "cancel" || t === "إلغاء" || t === "الغاء") return "cancel";
  if (t === "reschedule" || t === "تغيير الموعد") return "reschedule";
  return null;
}
