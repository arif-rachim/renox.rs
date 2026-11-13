// Whether a customer may cancel or move one of their visits on /my (#778).
// A pure function of the job, the time and the company's rules
// (lib/settings.ts portalCutoffHours, portalMaxReschedules): the page asks it
// to show the links, and each action asks it again inside its transaction,
// with the job read again, so a change that lost a race is refused.
//
// The rules:
//   - only a job that is `new` (a self-booking the dispatcher has not
//     confirmed yet) or `scheduled`; a visit on its way or started is
//     "in_progress", anything else (done, invoiced, cancelled) "not_scheduled";
//   - nothing within `cutoff_hours` of `scheduled_start` ("too_late"), except
//     that a `new` job can be cancelled at any time before it is confirmed;
//   - a visit is moved at most `max_reschedules` times by the customer
//     (`reschedules`: its events of kind customer_rescheduled) ("limit");
//   - a visit a maintenance contract made (`source = 'contract'`) can be
//     moved but not cancelled by the customer ("contract_visit").
// `reason` is the first rule that refuses something, "ok" when both are allowed.
//
// No module is imported: the tests run it as a unit.

export type ChangeReason = "ok" | "too_late" | "not_scheduled" | "in_progress" | "limit" | "contract_visit";

export interface ChangeJob {
  readonly status: string;
  /** Unix seconds; null for a job with no time yet. */
  readonly scheduled_start: number | null;
  readonly source: string;
  /** How often the customer moved it already. */
  readonly reschedules: number;
}

export interface ChangeRules {
  readonly cutoff_hours: number;
  readonly max_reschedules: number;
}

export interface ChangeAnswer {
  readonly cancel: boolean;
  readonly reschedule: boolean;
  readonly reason: ChangeReason;
}

/** What the customer may do with `job` at `now` (unix seconds). */
export function canChange(job: ChangeJob, now: number, rules: ChangeRules): ChangeAnswer {
  if (job.status === "en_route" || job.status === "in_progress") return { cancel: false, reschedule: false, reason: "in_progress" };
  if (job.status !== "new" && job.status !== "scheduled") return { cancel: false, reschedule: false, reason: "not_scheduled" };
  const pending = job.status === "new";
  const late = job.scheduled_start !== null && job.scheduled_start - now < rules.cutoff_hours * 3600;
  const cancel = job.source !== "contract" && (pending || !late);
  const reschedule = !late && job.reschedules < rules.max_reschedules;
  let reason: ChangeReason = "ok";
  if (late) reason = "too_late";
  else if (!reschedule) reason = "limit";
  else if (!cancel) reason = "contract_visit";
  return { cancel, reschedule, reason };
}

/** The reason's sentence on /my/visits/<id>: the `my.change.why.*` key. */
export const reasonKey = (reason: ChangeReason): string => `my.change.why.${reason}`;

/** The reasons a customer may give for a cancellation (the select of `?cancel=1`), and the most characters of "Other". */
export const CANCEL_REASONS = ["no_longer_needed", "found_other_time", "other"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];
export const OTHER_MAX = 200;

/**
 * The cancel form's reason: `{ reason, text }` (the reason is optional: "" when none was picked; the
 * text is kept for "Other" only), or the field to i18n key map of what is wrong.
 */
export function cancelReasonOf(form: { get(name: string): unknown }): { value: { reason: CancelReason | ""; text: string } } | { errors: Record<string, string> } {
  const raw = form.get("reason");
  const reason = typeof raw === "string" ? raw : "";
  const other = form.get("reason_other");
  const text = typeof other === "string" ? other.replace(/\r\n?/gu, "\n").trim() : "";
  const errors: Record<string, string> = {};
  if (reason !== "" && !(CANCEL_REASONS as readonly string[]).includes(reason)) errors.reason = "my.change.err.reason";
  if ([...text].length > OTHER_MAX) errors.reason_other = "my.change.err.other";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { reason: reason as CancelReason | "", text: reason === "other" ? text : "" } };
}

/** The note of a customer's change on the job's timeline (the dispatcher reads it; the count of moves reads its prefix). */
export const RESCHEDULED = "customer_rescheduled";
export const CANCELLED = "customer_cancelled";
