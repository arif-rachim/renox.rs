// GET <mount>/oauth/consent?<the authorization request>: the signed-in user
// allows or denies an agent (#286). The page lists the scopes asked for;
// it has no script and cannot be framed (the platform's default headers).
// Allow issues a single-use code and sends the browser back to the client;
// Deny sends `access_denied`.
//
// #590: the organisation the agent acts in. The `auth.agent_orgs` hook
// lists the user's organisations (org fills it): with two or more the page
// asks (`org_id`), with one it is that one, with none there is none. Allow
// refuses an `org_id` outside the list (422); the code, then the token,
// carry it, and it becomes `principal.org` of the agent.
import { agentOrgs, checkAuthorize, denied, issueCode, pickOrg } from "../../lib/agents.ts";
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

/** A scope as the page words it (#336: from the catalog, `auth.consent.scope_all` or `scope_tool`). */
const describe = (scope: string): { all: boolean; tool: string } => ({ all: scope === "tools:*", tool: scope.slice("tools:".length) });

export const load = localized(async (ctx: Page) => {
  const c = await check(ctx, false);
  if ("redirect" in c) return c.redirect;
  if ("error" in c.r) return { error: c.r.description, fields: [], client_name: "", scopes: [], user: c.s.user, orgs: [], org_choice: false, org_single: null };
  const q = ctx.url.searchParams;
  const orgs = await agentOrgs(ctx, c.s.user.id);
  return {
    error: null,
    user: c.s.user,
    client_name: c.r.client.client_name,
    redirect_host: new URL(c.r.redirect_uri).host,
    scopes: c.r.scopes.map((s) => ({ scope: s, ...describe(s) })),
    fields: FIELDS.filter((f) => q.get(f) !== null).map((f) => ({ name: f, value: q.get(f) as string })),
    orgs,
    org_choice: orgs.length > 1,
    org_single: orgs.length === 1 ? (orgs[0]?.id ?? null) : null,
  };
});

export const actions = {
  allow: localized(async (ctx: Page) => {
    const c = await check(ctx, true);
    if ("redirect" in c) return c.redirect;
    if ("error" in c.r) return new Response(`${c.r.error}: ${c.r.description}\n`, { status: 400 });
    const chosen = ctx.form.get("org_id");
    const org = pickOrg(await agentOrgs(ctx, c.s.user.id), typeof chosen === "string" ? chosen : null);
    if (org === null) return new Response("invalid_request: org_id is not one of your organisations\n", { status: 422 });
    return new Response(null, { status: 303, headers: { location: await issueCode(ctx, c.s.user, c.r, org.org_id), "cache-control": "no-store" } });
  }),
  deny: localized(async (ctx: Page) => {
    const c = await check(ctx, true);
    if ("redirect" in c) return c.redirect;
    if ("error" in c.r) return new Response(`${c.r.error}: ${c.r.description}\n`, { status: 400 });
    return new Response(null, { status: 303, headers: { location: denied(c.r), "cache-control": "no-store" } });
  }),
};
