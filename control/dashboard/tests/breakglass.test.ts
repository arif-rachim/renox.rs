// The operator console's break-glass (#310; deploy-api.md 0.4 section 17;
// docs/24-threat-model.md G, "Operator reads tenant data") against the real
// control API in process: an `ops:impersonate` token and a reason start it,
// this dashboard session signs in with the read-only impersonation token
// and every page shows the banner; the status panel lists the active
// impersonation and ends it, which signs this session out; the time box
// ends it too; the operator's token is never stored.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { assertScoped, createApp_, signup } from "../../api/tests/helpers.ts";
import { load as appsLoad } from "../pages/apps/index.ts";
import { actions as opsActions } from "../pages/ops/tenants/[tenant].ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, dash, loaderCtx, SECRETS, type Dash } from "./helpers.ts";

setDefaultTimeout(30_000);
afterEach(assertScoped);

const T = "t_bgdash";
const OPS = { ...SECRETS, OPS_CONSOLE: "operators" };

async function setup(): Promise<{ d: Dash; opToken: string }> {
  const d = await dash({ secrets: OPS });
  // The impersonation's time box is the API's clock; the dashboard checks it against its own.
  d.h.clock.now = Date.now();
  const owner = await signup(d.h, "owner@bgdash.test", T);
  const ownerTok = ((await (await d.h.request("POST", "/v1/tokens", { session: owner, json: { name: "o", scopes: ["*"], expires_in_days: 1 } })).json()) as { token: string }).token;
  await createApp_(d.h, ownerTok, "shop");
  const operator = await signup(d.h, "ops@renox.test", "t_platform");
  await d.h.db.query("update users set operator = true where email = 'ops@renox.test'");
  const opToken = ((await (await d.h.request("POST", "/v1/tokens", { session: operator, json: { name: "console", scopes: ["ops:impersonate", "ops:read"], expires_in_days: 1 } })).json()) as { token: string }).token;
  // The operator's own dashboard sign-in (an ordinary token of their account's tenant).
  const own = ((await (await d.h.request("POST", "/v1/tokens", { session: operator, json: { name: "dash", scopes: ["*"], expires_in_days: 1 } })).json()) as { token: string }).token;
  expect(await signinActions.default(actionCtx(d, "/signin", "default", { token: own, next: "/apps" }))).toBeInstanceOf(Response);
  return { d, opToken };
}

const P = { params: { tenant: T } };

describe("break-glass in the console", () => {
  test("start: a reason is required; the session then reads the tenant's apps under a banner; the operator token is not kept", async () => {
    const { d, opToken } = await setup();
    const short = (await opsActions.impersonate(actionCtx(d, `/ops/tenants/${T}`, "impersonate", { token: opToken, reason: "short" }, P))) as Record<string, unknown>;
    expect(short.form_error).toContain("reason");
    const started = await opsActions.impersonate(actionCtx(d, `/ops/tenants/${T}`, "impersonate", { token: opToken, reason: "support ticket 4217: missing orders" }, P));
    expect(started).toBeInstanceOf(Response);
    expect((started as Response).headers.get("location")).toBe("/apps");
    const apps = (await appsLoad(loaderCtx(d, "/apps"))) as Record<string, unknown>;
    expect((apps.impersonation as { tenant_id: string }).tenant_id).toBe(T);
    expect(JSON.stringify(apps)).toContain("shop");
    // Stored encrypted for the session only: the operator token is nowhere in the dashboard's file.
    expect(JSON.stringify(d.sqlite.query("select * from app__sessions").all())).not.toContain(opToken.slice(9));
    expect(JSON.stringify(d.sqlite.query("select * from app__impersonations").all())).not.toContain(opToken.slice(9));
  });

  test("the status panel lists the active impersonation and ends it, which signs this session out", async () => {
    const { d, opToken } = await setup();
    await opsActions.impersonate(actionCtx(d, `/ops/tenants/${T}`, "impersonate", { token: opToken, reason: "support ticket 4218: billing question" }, P));
    const status = (await opsActions.status(actionCtx(d, `/ops/tenants/${T}`, "status", { token: opToken }, P))) as { status: { actions: { active_impersonation: string | null }[] } };
    const active = status.status.actions.find((a) => a.active_impersonation !== null)?.active_impersonation as string;
    expect(active).toMatch(/^imp_/u);
    const ended = await opsActions.end(actionCtx(d, `/ops/tenants/${T}`, "end", { token: opToken, impersonation_id: active }, P));
    expect((ended as Response).headers.get("location")).toBe("/signin");
    const after = await appsLoad(loaderCtx(d, "/apps"));
    expect((after as Response).status).toBe(303);
    expect(d.sqlite.query("select count(*) as n from app__impersonations").get()).toEqual({ n: 0 });
  });

  test("the time box ends the dashboard's break-glass sign-in", async () => {
    const { d, opToken } = await setup();
    await opsActions.impersonate(actionCtx(d, `/ops/tenants/${T}`, "impersonate", { token: opToken, reason: "support ticket 4219: export failed" }, P));
    d.sqlite.query("update app__impersonations set expires_at = ?").run(Date.now() - 1);
    const r = await appsLoad(loaderCtx(d, "/apps"));
    expect((r as Response).status).toBe(303);
    expect(d.sqlite.query("select count(*) as n from app__sessions").get()).toEqual({ n: 0 });
  });

  test("without OPS_CONSOLE the actions are 403", async () => {
    const d = await dash();
    const r = await opsActions.impersonate(actionCtx(d, `/ops/tenants/${T}`, "impersonate", { token: "renox_op_" + "a".repeat(32), reason: "a reason long enough" }, P));
    expect((r as Response).status).toBe(403);
  });
});
