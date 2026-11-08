// Input schemas for the job forms (same shape as lib/forms.ts): an issue's
// message is an i18n key (`jobs.err.<field>`), its path names the field.
import { schema, text } from "./forms";
import { PRIORITIES, STATUSES, type JobStatus, type NewJob, type Priority } from "./jobs";

const ID = /^[A-Za-z0-9_-]{1,64}$/u;

/** The new-job form: a site, an optional approved quotation, a catalogue service, a priority and a description. */
export const newJobSchema = schema<NewJob>(async (raw) => {
  const errors: Record<string, string> = {};
  const site = text(raw, "site_id", 64);
  const quote = text(raw, "quote_id", 64);
  const service = Number(text(raw, "service", 12));
  const priority = text(raw, "priority", 10) || "normal";
  const description = text(raw, "description", 1000);
  if (!ID.test(site)) errors.site_id = "jobs.err.site";
  if (quote !== "" && !ID.test(quote)) errors.quote_id = "jobs.err.quote";
  if (!Number.isSafeInteger(service) || service < 1) errors.service = "jobs.err.service";
  if (!(PRIORITIES as readonly string[]).includes(priority)) errors.priority = "jobs.err.priority";
  if (description.length > 1000) errors.description = "jobs.err.description";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { site_id: site, quote_id: quote === "" ? null : quote, service_id: service, priority: priority as Priority, description } };
});

/** The schedule form's `slot`: `<technician user id>@<start in unix milliseconds>`, as the slot picker writes it. */
export const scheduleSchema = schema<{ technician: string; start: number; note: string }>(async (raw) => {
  const slot = text(raw, "slot", 100);
  const note = text(raw, "note", 200);
  const at = slot.lastIndexOf("@");
  const technician = at > 0 ? slot.slice(0, at) : "";
  const start = /^\d{10,15}$/u.test(slot.slice(at + 1)) ? Number(slot.slice(at + 1)) : 0;
  const errors: Record<string, string> = {};
  if (!ID.test(technician) || start === 0) errors.slot = "jobs.err.slot";
  if (note.length > 200) errors.note = "jobs.err.note";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { technician, start, note } };
});

export const assignSchema = schema<{ technician: string }>(async (raw) => {
  const technician = text(raw, "technician", 64);
  return ID.test(technician) ? { value: { technician } } : { errors: { technician: "jobs.err.technician" } };
});

/** A status change from the job page: `to` is a status, `note` optional. */
export const statusSchema = schema<{ to: JobStatus; note: string }>(async (raw) => {
  const to = text(raw, "to", 20);
  const note = text(raw, "note", 200);
  const errors: Record<string, string> = {};
  if (!(STATUSES as readonly string[]).includes(to)) errors.to = "jobs.err.status";
  if (note.length > 200) errors.note = "jobs.err.note";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { to: to as JobStatus, note } };
});
