// App MCP tool `job_status`: where a job stands: its status, technician, the
// scheduled time and the status of its invoice. Read only (`job.read`, then the
// job's own check: a technician reads only their own jobs, as on the pages).
// An unknown number, or one of a branch the user is not in, is `not_found`.
// The libraries are imported inside `run` (`renox:modules` resolves only at runtime, and `renox build` evaluates this file).
import { tool } from "@renoxium/sdk";

import type { JobRow } from "../../lib/jobs";
import { field, inputOf, str } from "../../lib/tool-input";

interface Input {
  number: string;
}

const READ = "job.read";

export default tool({
  name: "job_status",
  description: "The status of a job by its number (J-000012): technician, scheduled time and invoice status",
  input: inputOf<Input>({ type: "object", properties: { number: str("The job number, for example J-000012", 20) }, required: ["number"], additionalProperties: false }, (raw, issues) => ({
    number: (field(raw, "number", 20, issues) ?? "").toUpperCase(),
  })),
  action: "job.read",
  async run(ctx) {
    const { clock } = await import("../../lib/booking-sync");
    const { jobResource } = await import("../../lib/jobs");
    const { day } = await import("../../lib/quotes");
    const { techniciansOf } = await import("../../lib/technicians");
    const { branchesOfUser, fenced, refuse } = await import("../../lib/tools");
    // The run gets the arguments as sent (the schema checks them, it does not rewrite them).
    const number = ctx.tool.input.number.trim().toUpperCase();
    const me = ctx.principal;
    if (me === null) return refuse("forbidden", "A signed-in user is required.");
    // The number is company-wide; the branch it belongs to must be one of the user's.
    const mine = await branchesOfUser(ctx.db, me.id);
    if (mine.length === 0) return refuse("forbidden", "You belong to no branch.");
    const row = await ctx.db.queryOne<{ branch_id: string }>("select branch_id from app__jobs where number = ?", [number]);
    const branch = row === null ? undefined : mine.find((b) => b.id === row.branch_id);
    if (branch === undefined) return refuse("not_found", `No job ${number}.`);
    const sdb = fenced(ctx.db, branch);
    const job = await sdb.queryOne<JobRow>("select id, branch_id, number, status, service_id, technician_user_id, scheduled_start, scheduled_end, priority, customer_id from app__jobs where number = ?", [number]);
    if (job === null) return refuse("not_found", `No job ${number}.`);
    // The job's own check, for the token's principal (a technician reads only their own jobs). The action is a constant: a
    // literal one in a functions/ file makes `renox check` ask for a `guard` export, and a tool's own `action` is its guard.
    if (!(await ctx.authz.can(READ, jobResource(job, me.id)))) return refuse("forbidden", `You may not read job ${job.number}.`);
    const tech = job.technician_user_id === null ? null : ((await techniciansOf(ctx, branch)).find((t) => t.id === job.technician_user_id)?.name ?? job.technician_user_id);
    const invoice = await ctx.db.queryOne<{ invoice_id: string; status: string }>("select invoice_id, status from app__invoice_status where job_id = ? and branch_id = ?", [job.id, branch.id]);
    const service = await ctx.db.queryOne<{ code: string }>("select code from app__services where id = ?", [job.service_id]);
    return {
      number: job.number,
      branch: branch.slug,
      status: job.status,
      service: service?.code ?? null,
      technician: tech,
      scheduled: job.scheduled_start === null ? null : { day: day(job.scheduled_start), start: clock(job.scheduled_start), end: job.scheduled_end === null ? null : clock(job.scheduled_end) },
      invoice: invoice === null ? null : { number: invoice.invoice_id, status: invoice.status },
    };
  },
});

