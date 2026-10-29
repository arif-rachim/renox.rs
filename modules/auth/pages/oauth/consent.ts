// GET <mount>/oauth/consent?<the authorization request>: the signed-in user
// allows or denies an agent (#286). The page lists the scopes asked for;
// it has no script and cannot be framed (the platform's default headers).
// Allow issues a single-use code and sends the browser back to the client;
// Deny sends `access_denied`.
import { checkAuthorize, denied, issueCode } from "../../lib/agents.ts";
import { type AuthCtx, currentSession, redirectWith } from "../../lib/core.ts";
import { localized } from "../../lib/locale.ts";

type Page = AuthCtx & { url: URL; form: FormData };

const FIELDS = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "response_type"];

/** The request: from the query on GET, from the form's hidden fields on an action. */
function params(ctx: Page, fromForm: boolean): URLSearchParams {
  if (!fromForm) return ctx.url.searchParams;
  const q = new URLSearchParams();
  for (const f of FIELDS) {
    const v = ctx.form.get(f);
    if (typeof v === "string" && v !== "") q.set(f, v);
  }
  return q;
}

async function check(ctx: Page, fromForm: boolean) {
  const s = await currentSession(ctx);
  const mount = ctx.url.pathname.replace(/\/oauth\/consent\/?$/u, "");
  if (s === null) return { redirect: redirectWith(`${mount}/login?next=${encodeURIComponent(`${ctx.url.pathname}?${ctx.url.searchParams.toString()}`)}`, []) };
  const r = await checkAuthorize(ctx, params(ctx, fromForm));
  return { s, r };
}

const describe = (scope: string): string => (scope === "tools:*" ? "every tool of this app, as you" : `the tool ${scope.slice("tools:".length)}, as you`);

export const load = localized(async (ctx: Page) => {
  const c = await check(ctx, false);
  if ("redirect" in c) return c.redirect;
  if ("error" in c.r) return { error: c.r.description, fields: [], client_name: "", scopes: [], user: c.s.user };
  const q = ctx.url.searchParams;
  return {
    error: null,
    user: c.s.user,
    client_name: c.r.client.client_name,
    redirect_host: new URL(c.r.redirect_uri).host,
    scopes: c.r.scopes.map((s) => ({ scope: s, text: describe(s) })),
    fields: FIELDS.filter((f) => q.get(f) !== null).map((f) => ({ name: f, value: q.get(f) as string })),
  };
});

export const actions = {
  allow: localized(async (ctx: Page) => {
    const c = await check(ctx, true);
    if ("redirect" in c) return c.redirect;
    if ("error" in c.r) return new Response(`${c.r.error}: ${c.r.description}\n`, { status: 400 });
    return new Response(null, { status: 303, headers: { location: await issueCode(ctx, c.s.user, c.r), "cache-control": "no-store" } });
  }),
  deny: localized(async (ctx: Page) => {
    const c = await check(ctx, true);
    if ("redirect" in c) return c.redirect;
    if ("error" in c.r) return new Response(`${c.r.error}: ${c.r.description}\n`, { status: 400 });
    return new Response(null, { status: 303, headers: { location: denied(c.r), "cache-control": "no-store" } });
  }),
};
