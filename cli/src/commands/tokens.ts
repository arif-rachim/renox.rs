// renox tokens list | create <name> [--scope <scope>]... [--expires-days <n>] | revoke <id>
//
// Tenant tokens (docs/contracts/deploy-api.md section 2; #113). A token is
// created with at most the scopes of the calling token and the role of its
// user; its value is printed once and never again.

import { EnvironmentError, EXIT, UserError } from "../errors.ts";
import { apiAuth, defaultIo, type Io } from "./login.ts";

const USAGE = "usage: renox tokens list | create <name> [--scope <scope>]... [--expires-days <n>] | revoke <id>";
const SCOPE = /^(\*|(apps:read|apps:write|deploy|logs:read|secrets:read|secrets:write|domains:write|tokens:write)(:[a-z][a-z0-9-]{0,49})?)$/u;

interface Token {
  id: string;
  name: string;
  scopes: string[];
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const day = (ms: number | null): string => (ms === null ? "never" : new Date(ms).toISOString().slice(0, 10));

/** The error for a non-2xx answer: the API's code and message, with what to do. */
async function apiError(res: Response): Promise<Error> {
  let code = "";
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: { field: string; reason: string }[] } };
    code = body.error?.code ?? "";
    message = [body.error?.message, ...(body.error?.details ?? []).map((d) => `${d.field}: ${d.reason}`)].filter(Boolean).join(" ") || message;
  } catch {
    // not JSON: keep the status
  }
  if (res.status === 401) return new UserError(`${message} (${code})`, { hint: "the token expired or was revoked: run `renox login`" });
  if (res.status === 403) return new UserError(`${message} (${code})`, { hint: "the token or your role does not allow this" });
  if (res.status >= 500) return new EnvironmentError(`${message} (${code})`);
  return new UserError(code === "" ? message : `${message} (${code})`);
}

async function call(io: Io, method: string, path: string, body?: unknown): Promise<Response> {
  const { api, token } = apiAuth(io.env);
  try {
    return await io.fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new EnvironmentError(`cannot reach ${api}: ${(e as Error).message}`);
  }
}

export async function run(args: string[], io: Io = defaultIo()): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "list" && rest.length === 0) {
    const res = await call(io, "GET", "/v1/tokens");
    if (!res.ok) throw await apiError(res);
    const { tokens } = (await res.json()) as { tokens: Token[] };
    const live = tokens.filter((t) => t.revoked_at === null);
    if (live.length === 0) io.out("No tokens.");
    for (const t of live) io.out(`${t.id}  ${t.name}  [${t.scopes.join(" ")}]  expires ${day(t.expires_at)}  last used ${day(t.last_used_at)}`);
    return EXIT.OK;
  }
  if (sub === "create") {
    const [name, ...flags] = rest;
    if (name === undefined || name.startsWith("--")) throw new UserError("missing token name", { hint: USAGE });
    const scopes: string[] = [];
    let days = 90;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (f === "--scope") {
        const s = flags[++i] ?? "";
        if (!SCOPE.test(s)) throw new UserError(`${JSON.stringify(s)} is not a scope`, { hint: "for example deploy, deploy:<app>, apps:read, logs:read, secrets:write" });
        scopes.push(s);
      } else if (f === "--expires-days") {
        days = Number(flags[++i]);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new UserError("--expires-days takes 1 to 365");
      } else throw new UserError(`unknown argument ${JSON.stringify(f)}`, { hint: USAGE });
    }
    if (scopes.length === 0) throw new UserError("give at least one --scope", { hint: "for example: renox tokens create ci --scope deploy:<app>" });
    const res = await call(io, "POST", "/v1/tokens", { name, scopes, expires_in_days: days });
    if (res.status !== 201) throw await apiError(res);
    const t = (await res.json()) as Token & { token: string };
    io.out(t.token);
    io.out(`Created ${t.id} [${t.scopes.join(" ")}], expires ${day(t.expires_at)}. The value is shown only now; store it as a secret.`);
    return EXIT.OK;
  }
  if (sub === "revoke" && rest.length === 1) {
    const res = await call(io, "DELETE", `/v1/tokens/${encodeURIComponent(rest[0] as string)}`);
    if (res.status !== 204) throw await apiError(res);
    io.out(`Revoked ${rest[0]}.`);
    return EXIT.OK;
  }
  throw new UserError(sub === undefined ? "missing subcommand" : `unknown or incomplete subcommand ${JSON.stringify(sub)}`, { hint: USAGE });
}
