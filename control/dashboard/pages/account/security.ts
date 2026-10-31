// GET /account/security: the signed-in user's second factors (#307;
// deploy-api.md 0.4 section 18, "User token rule"). The dashboard signs in
// with the user's own token (D23), and the API accepts that token on the MFA
// endpoints with a verification window of the token's own: adding a factor
// next to an existing one and new recovery codes need a code entered here
// within 15 minutes. When the API answers `step_up_required`, the page asks
// for a code inline and then retries the action it was asked for.
//
// POST ?/totp_start, ?/totp_confirm (code), ?/passkey_options and
// ?/passkey_register (the browser's WebAuthn answer, public/passkey.js),
// ?/verify (code, then), ?/recovery, ?/disable (password, code).
//
// The team's `mfa_required` stays session only in the contract
// (`setTeamMfaRequired`), so the page shows the requirement and how to
// change it, and never sends it with a token.
import type { ActionContext, LoaderContext } from "renox";

import { apiBase, type Api, type ApiFailure, type MfaStatus, needsStepUp, type Result } from "../../lib/api.ts";
import { problem, type Problem, signedIn } from "../../lib/guard.ts";
import { trOf } from "../../lib/i18n.ts";
import { clock } from "../../lib/view.ts";

/** The actions a verification may retry. */
const RETRY = ["recovery", "totp_start", "passkey_options"] as const;
type Retry = (typeof RETRY)[number];

const CODE = /^[a-z0-9 -]{6,24}$/iu;

interface View {
  notice: string | null;
  problem: Problem | null;
  step_up: Retry | null;
  totp_setup: { secret: string; uri: string } | null;
  recovery_codes: string[] | null;
  passkey_options: string | null;
}

/**
 * A refused code or password is the API's 401 with `field: "mfa"`: show it,
 * and keep the dashboard sign-in (problem() ends the sign-in on any other
 * 401, a refused token).
 */
const codeRefused = (f: ApiFailure): boolean =>
  f.status === 401 && f.details.some((d) => typeof d === "object" && d !== null && (d as { field?: unknown }).field === "mfa");

async function failure(ctx: LoaderContext | ActionContext, f: ApiFailure): Promise<Problem> {
  if (codeRefused(f)) return { code: f.code, message: trOf(ctx)("dash.security.code_refused"), status: f.status, request_id: f.requestId, signed_out: false, details: [] };
  return problem(ctx, f);
}

const empty = (): View => ({ notice: null, problem: null, step_up: null, totp_setup: null, recovery_codes: null, passkey_options: null });

function shown(s: MfaStatus) {
  return {
    totp: s.totp,
    passkeys: s.passkeys,
    recovery_left: s.recovery_left,
    enrolled: s.enrolled,
    required: s.required,
    grace_until: s.enrolled || s.grace_until === 0 ? null : clock(s.grace_until),
    verified: s.verified_at === null ? null : clock(s.verified_at),
  };
}

async function page(ctx: LoaderContext | ActionContext, api: Api, view: View) {
  const r = await api.getMfa();
  const base = { signed_in: true, impersonation: api.impersonation, api_host: new URL(apiBase(ctx.secrets)).host, section: "security", ...view };
  if (!r.ok) return { ...base, status: null, problem: view.problem ?? (await problem(ctx, r)) };
  return { ...base, status: shown(r.value) };
}

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  return page(ctx, api, empty());
}

/** The view after a call: a step-up prompt for `retry`, or the failure shown, or `ok`. */
async function after<T>(ctx: ActionContext, api: Api, r: Result<T>, retry: Retry | null, ok: (v: T) => Partial<View>) {
  if (!r.ok) {
    if (retry !== null && needsStepUp(r)) return page(ctx, api, { ...empty(), step_up: retry });
    return page(ctx, api, { ...empty(), problem: await failure(ctx, r) });
  }
  return page(ctx, api, { ...empty(), ...ok(r.value) });
}

const field = (ctx: ActionContext, name: string): string => {
  const v = ctx.form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

async function run(ctx: ActionContext, api: Api, action: Retry) {
  switch (action) {
    case "recovery":
      return after(ctx, api, await api.regenerateRecoveryCodes(), "recovery", (v) => ({ recovery_codes: v.recovery_codes, notice: trOf(ctx)("dash.security.new_codes") }));
    case "totp_start":
      return after(ctx, api, await api.startTotp(), "totp_start", (v) => ({ totp_setup: { secret: v.secret, uri: v.otpauth_uri } }));
    case "passkey_options":
      return after(ctx, api, await api.passkeyOptions(), "passkey_options", (v) => ({ passkey_options: JSON.stringify(v) }));
  }
}

const withApi =
  (fn: (ctx: ActionContext, api: Api) => Promise<unknown>) =>
  async (ctx: ActionContext): Promise<unknown> => {
    const api = await signedIn(ctx);
    if (api instanceof Response) return api;
    return fn(ctx, api);
  };

export const actions = {
  totp_start: withApi((ctx, api) => run(ctx, api, "totp_start")),
  passkey_options: withApi((ctx, api) => run(ctx, api, "passkey_options")),
  recovery: withApi((ctx, api) => run(ctx, api, "recovery")),

  totp_confirm: withApi(async (ctx, api) => {
    const code = field(ctx, "code").replace(/\s/gu, "");
    if (!/^\d{6}$/u.test(code)) return page(ctx, api, { ...empty(), notice: trOf(ctx)("dash.security.enter_totp") });
    return after(ctx, api, await api.confirmTotp(code), null, (v) => ({ recovery_codes: v.recovery_codes, notice: trOf(ctx)("dash.security.totp_added") }));
  }),

  passkey_register: withApi(async (ctx, api) => {
    const client_data = field(ctx, "client_data");
    const attestation_object = field(ctx, "attestation_object");
    const name = field(ctx, "name").slice(0, 60);
    if (client_data === "" || attestation_object === "") return page(ctx, api, { ...empty(), notice: trOf(ctx)("dash.security.no_passkey") });
    return after(ctx, api, await api.registerPasskey({ client_data, attestation_object, ...(name === "" ? {} : { name }) }), null, (v) => ({
      recovery_codes: v.recovery_codes ?? null,
      notice: trOf(ctx)("dash.security.passkey_added"),
    }));
  }),

  verify: withApi(async (ctx, api) => {
    const code = field(ctx, "code");
    const then = field(ctx, "then") as Retry;
    if (!CODE.test(code)) return page(ctx, api, { ...empty(), step_up: RETRY.includes(then) ? then : null, notice: trOf(ctx)("dash.common.enter_code") });
    const method = /^\d{6}$/u.test(code.replace(/\s/gu, "")) ? "totp" : "recovery";
    const r = await api.verifyMfa({ method, code: method === "totp" ? code.replace(/\s/gu, "") : code });
    if (!r.ok) return page(ctx, api, { ...empty(), step_up: RETRY.includes(then) ? then : null, problem: await failure(ctx, r) });
    return RETRY.includes(then) ? run(ctx, api, then) : page(ctx, api, { ...empty(), notice: trOf(ctx)("dash.common.verified") });
  }),

  disable: withApi(async (ctx, api) => {
    const password = ctx.form.get("password");
    const code = field(ctx, "code");
    return after(ctx, api, await api.disableMfa(typeof password === "string" ? password : "", code), null, () => ({ notice: trOf(ctx)("dash.security.removed") }));
  }),
};
