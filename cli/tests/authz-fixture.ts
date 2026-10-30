// Shared fixture of the #283 tests: a small app with `[authz]`, one policy,
// a guarded and scoped route, and the migration of its owned table.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const TOML = `[app]
name = "docs"
timezone = "Asia/Dubai"

[authz]
actions = ["doc.read", "doc.edit"]
sensitive = ["doc.edit"]

[authz.ownership]
app__docs = { owner = "owner" }

[authz.entities]
Doc = { table = "app__docs", attrs = ["owner"] }

[authz.default_roles]
editor = ["doc.edit"]
`;

export const POLICY = `// Owners read and edit their documents; editors edit any.
permit (principal is Renox::User, action == Renox::Action::"doc.read", resource is App::Doc)
when { resource.owner == principal.id };
permit (principal in Renox::Role::"editor", action == Renox::Action::"doc.edit", resource);
`;

export const DOC_TS = `export const guard = { action: "doc.read", resource: { type: "Doc", id: ":id" } };
export async function GET(ctx) {
  return Response.json(await ctx.db.scoped({ user_id: ctx.principal?.id }).query("select * from app__docs where id = ?", [ctx.params.id]));
}
`;

/** A temporary app: `files` relative to its root. */
export function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-authz-"));
  for (const [p, s] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), s);
  }
  return dir;
}

export const BASE: Record<string, string> = {
  "renox.toml": TOML,
  "policies/app/docs.cedar": POLICY,
  "functions/docs/[id].ts": DOC_TS,
  "migrations/001_docs.sql": "create table app__docs (id text primary key, owner text not null, title text);\n",
};
