// renox authz explain --user <id> --action <a> [--resource <type:id>] [--role <r>]...
// [--attr <key=value>]... [--db <file>] (#283; docs/11-authorization.md, "renox authz explain"):
// why the app's policies allow or deny one request. The policies are the
// ones `renox build` would ship; the user's roles and the resource's
// declared attributes are read from the dev tenant file (.renox/data/dev/
// app.db, what `renox dev` runs on), the way the cell reads them. The
// principal attributes that a hook fills in the app (`principal.org` from
// org's `auth.principal`, `principal.mfa_verified`) are not computed here:
// `--attr key=value` (repeatable; the value is JSON when it parses, else a
// string) sets them, and the output lists the ones used (#476). The
// answer is `op_authz_explain`'s: the decision, the deciding policies with
// their text, and evaluation errors.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { EXIT, UserError } from "../errors.ts";
import { buildFiles } from "../lib/build.ts";
import { type AuthzBlock, checkPolicies, PolicyError } from "../lib/policies.ts";
import { devDb } from "./migrate.ts";

const USAGE = "usage: renox authz explain --user <id> --action <resource.verb> [--resource <type:id>] [--role <role>]... [--attr <key=value>]... [--db <file>] [--json]";

export interface ExplainArgs {
  user: string;
  action: string;
  resource?: { type: string; id: string };
  roles: string[];
  /** `--attr key=value`: principal attributes, the way the app's `auth.principal` hooks would set them. */
  attrs?: Record<string, unknown>;
  db?: string;
}

export interface ExplainResult {
  allow: boolean;
  reason: string;
  policies: string[];
  text: string;
  /** The principal as evaluated: its roles and the attributes used. */
  principal: { id: string; roles: string[]; attrs: Record<string, unknown> };
}

/** `key=value`: the value is JSON when it parses, else the string. */
function parseAttr(spec: string): [string, unknown] | null {
  const at = spec.indexOf("=");
  if (at <= 0) return null;
  const raw = spec.slice(at + 1);
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // Not JSON: a plain string.
  }
  return [spec.slice(0, at), value];
}

export function parse(args: string[]): ExplainArgs | null {
  if (args[0] !== "explain") return null;
  const out: ExplainArgs = { user: "", action: "", roles: [] };
  for (let i = 1; i < args.length; i++) {
    const [flag, value] = [args[i], args[i + 1]];
    if (flag === "--json") continue;
    if (value === undefined || value.startsWith("--")) return null;
    i++;
    if (flag === "--user") out.user = value;
    else if (flag === "--action") out.action = value;
    else if (flag === "--role") out.roles.push(value);
    else if (flag === "--attr") {
      const kv = parseAttr(value);
      if (!kv) return null;
      (out.attrs ??= {})[kv[0]] = kv[1];
    } else if (flag === "--db") out.db = value;
    else if (flag === "--resource") {
      const at = value.indexOf(":");
      if (at <= 0 || at === value.length - 1) return null;
      out.resource = { type: value.slice(0, at), id: value.slice(at + 1) };
    } else return null;
  }
  return out.user && out.action ? out : null;
}

/** Roles of `user` and the resource's declared attributes from the tenant file, when there is one. */
function fromDb(file: string, user: string, resource: ExplainArgs["resource"], blocks: (AuthzBlock | undefined)[]): { roles: string[]; attrs: Record<string, unknown> } {
  if (!existsSync(file)) return { roles: [], attrs: {} };
  const db = new Database(file, { readonly: true });
  try {
    let roles: string[] = [];
    try {
      roles = (db.query("select role from renox__role_assignments where user_id = ? order by role").all(user) as { role: string }[]).map((r) => r.role);
    } catch {
      // No role table yet (migrations not run): no roles.
    }
    const attrs: Record<string, unknown> = {};
    const decl = resource ? blocks.map((b) => b?.entities?.[resource.type]).find((d) => d !== undefined) : undefined;
    if (resource && decl?.table && /^[a-z][a-z0-9_]*$/u.test(decl.table)) {
      const idCol = decl.id && /^[a-z][a-z0-9_]*$/u.test(decl.id) ? decl.id : "id";
      try {
        const row = db.query(`select * from "${decl.table}" where "${idCol}" = ?`).get(resource.id) as Record<string, unknown> | null;
        for (const a of decl.attrs ?? []) if (row && a in row) attrs[a] = row[a];
      } catch {
        // Unknown table or column: the resource has no attributes.
      }
    }
    return { roles, attrs };
  } finally {
    db.close();
  }
}

/** The explanation of one request against the project's policies. */
export async function explain(project: string, a: ExplainArgs): Promise<ExplainResult> {
  const built = await buildFiles(project);
  const blocks = [built.manifest.authz, ...(built.manifest.modules ?? []).map((m) => (m as { authz?: AuthzBlock }).authz)];
  const db = a.db ? resolve(a.db) : devDb(project);
  const stored = fromDb(db, a.user, a.resource, blocks);
  const roles = [...new Set([...stored.roles, ...a.roles])];
  const resource = a.resource ? { ...stored.attrs, type: a.resource.type, id: a.resource.id } : undefined;
  const attrs = a.attrs ?? {};
  const { errors, results } = await checkPolicies(built.files, [
    { principal: { type: "User", id: a.user, roles, ...(Object.keys(attrs).length ? { attrs } : {}) }, action: a.action, ...(resource ? { resource } : {}), expected: "allow" },
  ], undefined, true);
  if (errors.length) throw new PolicyError(errors);
  const r = results[0];
  if (!r) throw new UserError("renox-worker check-policies returned no result");
  return {
    allow: r.allow,
    reason: r.reason,
    policies: r.policies,
    text: r.explanation?.text ?? (r.allow ? "ALLOW\n" : "DENY\n"),
    principal: { id: a.user, roles, attrs },
  };
}

/** The "principal attributes" lines of the output. */
export function attrsText(p: ExplainResult["principal"]): string {
  const entries = Object.entries(p.attrs);
  const list = entries.length ? entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") : "none (pass --attr key=value for hook attributes such as org)";
  return `principal attributes: ${list}\n`;
}

export async function run(args: string[]): Promise<number> {
  const a = parse(args);
  if (!a) {
    console.error(USAGE);
    return EXIT.USER;
  }
  const r = await explain(process.cwd(), a);
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ allow: r.allow, reason: r.reason, policies: r.policies, principal: r.principal }, null, 2)}\n`);
  else process.stdout.write(`${r.text}${r.text.endsWith("\n") ? "" : "\n"}${attrsText(r.principal)}`);
  return EXIT.OK;
}
