// The sign-in check every dashboard page and action starts with. It reads
// only the dashboard's own SQLite, so a redirect to /signin is decided before
// the first call to the control API: a loader that awaits the API may run
// past the shell delay, after which it can no longer answer with a
// `Response` (ops.md section 14, "Streaming the shell").

import type { ActionContext, LoaderContext } from "renox";

import { Api, apiBase, type ApiFailure } from "./api.ts";
import { applyLocale } from "./locale.ts";
import { currentToken, SessionKeyMissing, signOut } from "./session.ts";

type Context = LoaderContext | ActionContext;

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** A path of the dashboard to come back to after signing in; anything else is `/apps`. */
export function nextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !/^\/[A-Za-z0-9/_.~?=&%-]{0,200}$/u.test(raw) || raw.startsWith("//") || raw.startsWith("/signin")) return "/apps";
  return raw;
}

const toSignIn = (url: URL): Response =>
  new Response(null, { status: 303, headers: { location: `/signin?next=${encodeURIComponent(nextPath(url.pathname + url.search))}` } });

/**
 * The API client of the signed-in user, or the `Response` to send instead
 * (sign in, not configured, or the redirect that stores a `?lang=` choice).
 * It sets the page's locale first (lib/locale.ts, #336).
 */
export async function signedIn(ctx: Context): Promise<Api | Response> {
  const lang = applyLocale(ctx);
  if (lang !== null) return lang;
  let token: string | null;
  try {
    token = await currentToken(ctx.db, ctx.secrets, ctx.session.id, Date.now());
  } catch (e) {
    if (e instanceof SessionKeyMissing) return text(503, `The dashboard is not configured: ${e.message}.`);
    throw e;
  }
  if (token === null) return toSignIn(ctx.url);
  const api = new Api(ctx.fetch, token, apiBase(ctx.secrets));
  // #310: a break-glass sign-in shows a banner on every page, and ends at its time box.
  const imp = await ctx.db.queryOne<{ impersonation_id: string; tenant_id: string; expires_at: number }>(
    "select impersonation_id, tenant_id, expires_at from app__impersonations where session_id = ?",
    [ctx.session.id],
  );
  if (imp !== null) {
    if (Date.now() >= imp.expires_at) {
      await ctx.db.execute("delete from app__impersonations where session_id = ?", [ctx.session.id]);
      await signOut(ctx.db, ctx.session.id);
      return toSignIn(ctx.url);
    }
    api.impersonation = { tenant_id: imp.tenant_id, impersonation_id: imp.impersonation_id, until: new Date(imp.expires_at).toISOString().replace(/\.\d{3}Z$/u, "Z") };
  }
  return api;
}

/** What a page shows for a failed call; a 401 also ends the dashboard sign-in. */
export interface Problem {
  code: string;
  message: string;
  status: number;
  request_id: string | null;
  signed_out: boolean;
  /** Field errors and violations, as `field: reason` lines. */
  details: string[];
}

export async function problem(ctx: Context, f: ApiFailure): Promise<Problem> {
  const signedOut = f.status === 401;
  if (signedOut) await signOut(ctx.db, ctx.session.id);
  const message =
    f.status === 0
      ? `The control API at ${new URL(apiBase(ctx.secrets)).host} could not be reached (${f.code}).`
      : signedOut
        ? "Your token was refused (expired or revoked). Sign in again."
        : f.status === 403
          ? `Your token or role does not allow this (${f.message}).`
          : f.message;
  const details = f.details.flatMap((d) => {
    if (typeof d !== "object" || d === null) return [];
    const o = d as Record<string, unknown>;
    const head = [o.rule, o.stage, o.field ?? o.path].filter((x) => typeof x === "string").join(" ");
    const reason = typeof o.reason === "string" ? o.reason : "";
    return [`${head}${head && reason ? ": " : ""}${reason}`.slice(0, 600)];
  });
  return { code: f.code, message, status: f.status, request_id: f.requestId, signed_out: signedOut, details };
}

/** An app name as the API accepts it (deploy-api.yaml `AppName`); null otherwise. */
export function appParam(raw: string | string[] | undefined): string | null {
  return typeof raw === "string" && /^[a-z][a-z0-9-]{0,49}$/u.test(raw) ? raw : null;
}

/** A deployment hash (`Sha256`); null otherwise. */
export function hashParam(raw: unknown): string | null {
  return typeof raw === "string" && /^[0-9a-f]{64}$/u.test(raw) ? raw : null;
}

export const notFound = (): Response => text(404, "Not found");
