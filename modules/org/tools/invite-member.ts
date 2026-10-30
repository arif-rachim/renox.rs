// The `invite_member` App MCP tool (#286; ops.md 1.5.0 section 19): an
// agent invites someone to one of the user's organisations, as that user.
// `confirm = true`: the first call is a preview inside a transaction that
// is rolled back; the agent repeats it with the confirmation token. The
// org services still require the user to be an admin or owner of `org`.
//
// The module tree has no node_modules, so the input is a Standard Schema
// written out (with its JSON Schema for `renox build`), not zod; the org
// services are imported inside `run` (`renox:modules` resolves only at
// runtime, and `renox build` evaluates this file to read the schema).

const ROLES = ["member", "admin", "owner"] as const;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/u;

interface Input {
  org: string;
  email: string;
  role?: (typeof ROLES)[number];
}

const JSON_SCHEMA = {
  type: "object",
  properties: {
    org: { type: "string", minLength: 1, maxLength: 64, description: "The organisation id" },
    email: { type: "string", minLength: 3, maxLength: 254, description: "Who to invite" },
    role: { enum: [...ROLES], description: "member (default), admin, or owner" },
  },
  required: ["org", "email"],
  additionalProperties: false,
};

const input = {
  "~standard": {
    version: 1 as const,
    vendor: "org",
    validate(v: unknown) {
      const o = v as Partial<Input> | null;
      const issues: { message: string; path: string[] }[] = [];
      if (typeof o !== "object" || o === null) return { issues: [{ message: "an object", path: [] }] };
      if (typeof o.org !== "string" || o.org === "") issues.push({ message: "org is required", path: ["org"] });
      if (typeof o.email !== "string" || !EMAIL.test(o.email)) issues.push({ message: "a valid email", path: ["email"] });
      if (o.role !== undefined && !ROLES.includes(o.role)) issues.push({ message: "member, admin, or owner", path: ["role"] });
      return issues.length ? { issues } : { value: o as Input };
    },
    jsonSchema: { input: () => JSON_SCHEMA, output: () => JSON_SCHEMA },
  },
};

interface ToolCtx {
  principal: { id: string } | null;
  db: { queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> };
  tool: { input: Input; preview: boolean };
}

export default {
  name: "invite_member",
  description: "Invite someone by email to one of your organisations (you must be an admin or owner)",
  input,
  action: "org.invite",
  confirm: true,
  async run(ctx: ToolCtx) {
    const core = await import("../lib/core.ts");
    const me = ctx.principal;
    if (me === null) throw new Error("a signed-in user is required");
    const user = await ctx.db.queryOne<{ id: string; display_name: string }>("select id, display_name from auth__public_users_v1 where id = ?", [me.id]);
    const r = await core.inviteAs(ctx as never, user ?? { id: me.id, display_name: "" }, null, ctx.tool.input);
    if (!r.ok) return { invited: false, error: r.error };
    return { invited: !ctx.tool.preview, preview: ctx.tool.preview, invite_id: r.invite_id, expires_at: r.expires_at, email: ctx.tool.input.email };
  },
};
