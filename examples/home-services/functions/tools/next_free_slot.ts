// App MCP tool `next_free_slot`: the next three free slots for a service, each
// with its technician, as the schedule picker of the job page offers them
// (lib/booking-sync.ts). Read only (`job.read`); the branch is the one named
// or the user's only one (lib/tools.ts). `renox build` evaluates this file, and
// `renox:modules` (which lib/tools.ts reaches) resolves only at runtime, so the
// library is imported inside `run`.
import { tool } from "@renoxium/sdk";

import { field, inputOf, str } from "../../lib/tool-input";

interface Input {
  service: string;
  branch?: string;
  from?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

const READ = "job.read";

export default tool({
  name: "next_free_slot",
  description: "The next three free visit slots for a service in a branch, each with its technician",
  input: inputOf<Input>(
    {
      type: "object",
      properties: {
        service: str("The service code (AC-SERVICE) or its English name", 80),
        branch: str("The branch's short name (dubai, sharjah); needed when you belong to several", 80),
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The first day to look at, YYYY-MM-DD (default today, Dubai time)" },
      },
      required: ["service"],
      additionalProperties: false,
    },
    (raw, issues) => {
      const out: Input = { service: field(raw, "service", 80, issues) ?? "" };
      const branch = field(raw, "branch", 80, issues, true);
      if (branch !== undefined) out.branch = branch;
      if (raw.from !== undefined) {
        if (typeof raw.from === "string" && DAY.test(raw.from)) out.from = raw.from;
        else issues.push({ message: "from is a day as YYYY-MM-DD", path: ["from"] });
      }
      return out;
    },
  ),
  action: "job.read",
  async run(ctx) {
    const { findService, isToolError, nextFreeSlots, pickBranch, refuse } = await import("../../lib/tools");
    const { service, branch: wanted, from } = ctx.tool.input;
    const picked = await pickBranch(ctx, wanted);
    if (isToolError(picked)) return picked;
    // The cell checked the action for the token's principal; asked again here as the pages do.
    if (!(await ctx.authz.can(READ))) return refuse("forbidden", "You may not read jobs in this branch.");
    const found = await findService(ctx.db, service, picked.branch.id);
    if (found === null) return refuse("not_found", `No active service "${service}".`);
    const slots = await nextFreeSlots(ctx, picked.branch, found.code, from);
    return { branch: picked.branch.slug, service: found.code, slots };
  },
});
