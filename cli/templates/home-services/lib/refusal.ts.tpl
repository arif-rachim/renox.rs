// The note of a job event that says a queued action of a technician's phone was refused (#810). Pure: no ctx, so the
// job page, the notification and the tests read it the same way (lib/visits.ts `noteOfflineRefusal` writes it).

/** The start of the note of a job event that says a queued action of the technician's phone was refused (#810). */
export const OFFLINE_REFUSED = "offline_action_refused";

/** What the note of an `offline_action_refused` event says: the action, the reason (a `Conflict`), the technician and when it was done on the phone (unix seconds). */
export interface OfflineRefusal {
  action: string;
  reason: string;
  technician: string;
  performed_at: number;
}

/** The refusal an event's note holds, or null when the note is not one. */
export function refusalOf(note: string): OfflineRefusal | null {
  if (!note.startsWith(`${OFFLINE_REFUSED} `)) return null;
  try {
    const v = JSON.parse(note.slice(OFFLINE_REFUSED.length + 1)) as Partial<OfflineRefusal>;
    if (typeof v.action !== "string" || typeof v.reason !== "string" || typeof v.technician !== "string" || typeof v.performed_at !== "number") return null;
    return { action: v.action, reason: v.reason, technician: v.technician, performed_at: v.performed_at };
  } catch {
    return null;
  }
}
