// App MCP tool `create_job`: a visit booked for a customer, by the customer's
// phone, a service and a slot of `next_free_slot`. `confirm`: the first call
// only checks everything and answers what it would create (nothing is written,
// not even in a transaction that is rolled back: a scheduled visit tells the
// customer); the call that repeats it with the confirmation token creates the
// job through lib/jobs.ts (the pages' rules) and schedules it, so the customer
// is told. It needs `job.write` and `job.dispatch`, like the pages. The libraries
// are imported inside `run` (`renox:modules` resolves only at runtime, and
// `renox build` evaluates this file).
import { tool } from "@renoxium/sdk";

import { field, inputOf, str } from "../../lib/tool-input";

interface Input {
  customer_phone: string;
  service: string;
  site_label?: string;
  slot: string;
  branch?: string;
}

const WRITE = "job.write";
const DISPATCH = "job.dispatch";

export default tool({
  name: "create_job",
  description: "Book a visit for a customer: needs their phone, a service and a slot from next_free_slot; asks you to confirm first",
  input: inputOf<Input>(
    {
      type: "object",
      properties: {
        customer_phone: str("The customer's phone, +971 50 123 4567 or 050 123 4567", 20, 6),
        service: str("The service code (AC-SERVICE) or its English name", 80),
        site_label: str("The site's name when the customer has several (Villa, Office)", 80),
        slot: str("A slot of next_free_slot: <technician id>@<start in unix ms>", 100, 3),
        branch: str("The branch's short name; needed when you belong to several", 80),
      },
      required: ["customer_phone", "service", "slot"],
      additionalProperties: false,
    },
    (raw, issues) => {
      const out: Input = { customer_phone: field(raw, "customer_phone", 20, issues) ?? "", service: field(raw, "service", 80, issues) ?? "", slot: field(raw, "slot", 100, issues) ?? "" };
      const site = field(raw, "site_label", 80, issues, true);
      if (site !== undefined) out.site_label = site;
      const branch = field(raw, "branch", 80, issues, true);
      if (branch !== undefined) out.branch = branch;
      return out;
    },
  ),
  action: "job.write",
  confirm: true,
  async run(ctx) {
    const { bookingService, clock, ensureSynced, slotsOn } = await import("../../lib/booking-sync");
    const { sitesOf } = await import("../../lib/customers");
    const { createJob, schedule } = await import("../../lib/jobs");
    const { day } = await import("../../lib/quotes");
    const { techniciansOf } = await import("../../lib/technicians");
    const { canAs, customerByPhone, fenced, findService, inBranch, isToolError, pickBranch, refuse } = await import("../../lib/tools");
    const input = ctx.tool.input;
    const picked = await pickBranch(ctx, input.branch);
    if (isToolError(picked)) return picked;
    const branch = picked.branch;
    const sdb = fenced(ctx.db, branch);
    // The pages ask job.write and job.dispatch of a dispatcher: the tool's action is the first (the cell checked it without roles),
    // both are asked again here with the user's roles for this branch. The actions are constants, not literals: `renox check`
    // (missing-guard) reads a literal action in a functions/ file as a route that needs a `guard` export, and a tool's own
    // `action` is its guard.
    if (!(await canAs(ctx, branch, WRITE)) || !(await canAs(ctx, branch, DISPATCH))) return refuse("forbidden", "Booking a visit needs the dispatcher's permissions (job.write and job.dispatch).");

    const customer = await customerByPhone(sdb, input.customer_phone);
    if (customer === "none") return refuse("not_found", "No customer of this branch has that phone.");
    if (customer === "several") return refuse("bad_input", "Several customers have that phone: create the job on the page.");
    const sites = await sitesOf(sdb, customer.id);
    const site = input.site_label === undefined ? (sites.length === 1 ? sites[0] : undefined) : sites.find((s) => s.label.toLowerCase() === (input.site_label as string).toLowerCase());
    if (site === undefined) {
      return refuse(sites.length === 0 ? "not_found" : "bad_input", sites.length === 0 ? `${customer.name} has no site.` : `Name the site in site_label: ${sites.map((s) => s.label).join(", ")}.`);
    }
    const service = await findService(ctx.db, input.service, branch.id);
    if (service === null) return refuse("not_found", `No active service "${input.service}".`);

    const at = input.slot.lastIndexOf("@");
    const technicianId = at > 0 ? input.slot.slice(0, at) : "";
    const startMs = /^\d{10,15}$/u.test(input.slot.slice(at + 1)) ? Number(input.slot.slice(at + 1)) : 0;
    if (technicianId === "" || startMs === 0) return refuse("bad_input", "slot is <technician id>@<start in unix ms>, as next_free_slot gives it.");
    const technicians = await techniciansOf(ctx, branch);
    const tech = technicians.find((t) => t.id === technicianId);
    if (tech === undefined) return refuse("bad_input", "That technician is not in this branch.");
    await ensureSynced(ctx.db, branch, technicians);
    const free = (await slotsOn(bookingService(service.code), day(Math.floor(startMs / 1000)), [tech.id])).find((s) => s.start === startMs);
    if (free === undefined || startMs < Date.now()) return refuse("slot_unavailable", "That slot is not free any more: ask next_free_slot again.");

    const plan = { customer: customer.name, site: site.label, service: service.code, technician: tech.name, day: day(Math.floor(startMs / 1000)), start: clock(Math.floor(startMs / 1000)), branch: branch.slug };
    if (ctx.tool.preview) return { would_create: plan };

    const as = inBranch(ctx, branch);
    const made = await createJob(as, { site_id: site.id, quote_id: null, service_id: service.id, priority: "normal", description: "Booked by an agent", });
    if (!made.ok) return refuse(made.status === 403 ? "forbidden" : "bad_input", made.message);
    const booked = await schedule(as, made.job.id, tech.id, startMs, "booked through the agent");
    // Nothing is left half done: a failure here rolls the transaction back (the job above included).
    if (!booked.ok) throw new Error(`could not schedule ${made.job.number}: ${booked.message}`);
    return { created: true, number: booked.job.number, status: booked.job.status, ...plan };
  },
});
