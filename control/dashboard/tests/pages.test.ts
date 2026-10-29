// Every dashboard page and action against the real control API (in process,
// PGlite) through the tenant `fetch` of tests/helpers.ts: sign in with a
// tenant token, the app list and a new app, deployments with promote and
// rollback, logs with filters and the live fragment, hourly usage, secrets
// (names only). Rendering is checked through the worker in
// dashboard.e2e.test.ts.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";

import { helloArtifact, upload } from "../../api/tests/artifacts.ts";
import { assertScoped, createApp_, registeredNode, scopedToken, tenant } from "../../api/tests/helpers.ts";
import { load as appsLoad, actions as appsActions } from "../pages/apps/index.ts";
import { load as overviewLoad, actions as overviewActions } from "../pages/apps/[app]/index.ts";
import { load as deploymentsLoad, actions as deploymentsActions } from "../pages/apps/[app]/deployments.ts";
import { load as logsLoad } from "../pages/apps/[app]/logs.ts";
import { load as usageLoad, meanLatencyMs } from "../pages/apps/[app]/usage.ts";
import { load as secretsLoad, actions as secretsActions } from "../pages/apps/[app]/secrets.ts";
import { load as signinLoad, actions as signinActions } from "../pages/signin.ts";
import { actions as signoutActions } from "../pages/signout.ts";
import { actionCtx, addLogs, API_ORIGIN, dash, loaderCtx, type Dash } from "./helpers.ts";

// The first test starts PGlite (seconds).
setDefaultTimeout(30_000);
// Every API request the dashboard made stayed inside its tenant (control/api/README.md, #113).
afterEach(assertScoped);

const enc = new TextEncoder();
const variant = (n: number) => helloArtifact((_m, f) => f.set("code/n.json", enc.encode(String(n))));
const HELLO = { app: "hello" };

type Data = Record<string, unknown>;
const data = (v: unknown): Data => {
  expect(v).not.toBeInstanceOf(Response);
  return v as Data;
};

/** A tenant `t_hello` with app `hello`, and a signed-in dashboard session holding `token`. */
async function signedIn(scopes?: string[]): Promise<{ d: Dash; token: string; owner: string }> {
  const d = await dash();
  const owner = await tenant(d.h, "t_hello");
  await createApp_(d.h, owner, "hello");
  const token = scopes === undefined ? owner : await scopedToken(d.h, "t_hello", scopes);
  const r = await signinActions.default(actionCtx(d, "/signin", "default", { token, next: "/apps" }));
  expect(r).toBeInstanceOf(Response);
  return { d, token, owner };
}

describe("sign-in", () => {
  test("a page without a sign-in redirects to /signin with next, before any API call", async () => {
    const d = await dash();
    const r = await appsLoad(loaderCtx(d, "/apps/hello/logs?level=warn", { params: HELLO }));
    expect(r).toBeInstanceOf(Response);
    expect((r as Response).status).toBe(303);
    expect((r as Response).headers.get("location")).toBe(`/signin?next=${encodeURIComponent("/apps/hello/logs?level=warn")}`);
    expect(d.calls.sent).toEqual([]);
  });

  test("a valid token is checked against the API, stored, and the browser goes to next", async () => {
    const d = await dash();
    const token = await tenant(d.h, "t_hello");
    expect(data(signinLoad(loaderCtx(d, "/signin?next=/apps/hello"))).next).toBe("/apps/hello");
    const r = (await signinActions.default(actionCtx(d, "/signin", "default", { token, next: "/apps/hello" }))) as Response;
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/apps/hello");
    // One call, to the public origin, with the user's own token (ADR D23).
    expect(d.calls.sent).toEqual([{ method: "GET", url: `${API_ORIGIN}/v1/apps`, authorization: `Bearer ${token}`, body: null }]);
    expect(d.sqlite.query("select count(*) as n from app__sessions").get()).toEqual({ n: 1 });
  });

  /** docs/24-threat-model.md E, "Open redirect via next/return_to": next is a dashboard path or /apps. */
  test("next is never another site", async () => {
    const d = await dash();
    const token = await tenant(d.h, "t_hello");
    for (const next of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "/signin?next=/x"]) {
      const r = (await signinActions.default(actionCtx(d, "/signin", "default", { token, next }))) as Response;
      expect(r.headers.get("location")).toBe("/apps");
    }
  });

  test("a malformed, unknown, or scope-less token is refused and nothing is stored", async () => {
    const d = await dash();
    await tenant(d.h, "t_hello");
    const noScope = await scopedToken(d.h, "t_hello", ["deploy"]);
    const cases: [string, string][] = [
      ["renox_node_" + "a".repeat(32), "not a Renox token"],
      [`renox_pat_${"a".repeat(32)}`, "refused this token"],
      [noScope, "needs the apps:read scope"],
    ];
    for (const [token, message] of cases) {
      const r = data(await signinActions.default(actionCtx(d, "/signin", "default", { token })));
      expect(String(r.error)).toContain(message);
    }
    expect(d.sqlite.query("select count(*) as n from app__sessions").get()).toEqual({ n: 0 });
  });

  test("sign-out deletes the stored token; the next page asks to sign in again", async () => {
    const { d } = await signedIn();
    const r = (await signoutActions.default(actionCtx(d, "/signout", "default", {}))) as Response;
    expect(r.headers.get("location")).toBe("/signin");
    expect(d.sqlite.query("select count(*) as n from app__sessions").get()).toEqual({ n: 0 });
    expect(await appsLoad(loaderCtx(d, "/apps"))).toBeInstanceOf(Response);
  });

  test("a token revoked at the API ends the dashboard sign-in on the next page", async () => {
    const { d, token } = await signedIn();
    await d.h.db.query("update tokens set revoked_at = $1 where token_sha256 is not null", [Date.now()]);
    const r = data(await appsLoad(loaderCtx(d, "/apps")));
    expect((r.problem as { signed_out: boolean; status: number }).signed_out).toBe(true);
    expect(d.sqlite.query("select count(*) as n from app__sessions").get()).toEqual({ n: 0 });
    // The token itself is never part of the page data.
    expect(JSON.stringify(r)).not.toContain(token);
  });
});

describe("apps (3.1, 3.2)", () => {
  test("lists the tenant's apps with status, version and hostnames; creates an app", async () => {
    const { d } = await signedIn();
    const list = data(await appsLoad(loaderCtx(d, "/apps")));
    expect(list.tenant_id).toBe("t_hello");
    expect(list.apps).toEqual([{ name: "hello", live: false, status: "○ no live deployment", version: "—", hostnames: "hello.renox.app", url: "https://hello.renox.app/" }]);
    expect(data(await appsActions.create(actionCtx(d, "/apps", "create", { name: "Bad Name" }))).create_error).toContain("lower-case");
    expect(data(await appsActions.create(actionCtx(d, "/apps", "create", { name: "shop" }))).created).toBe("shop");
    expect(data(await appsActions.create(actionCtx(d, "/apps", "create", { name: "shop" }))).create_error).toBe("name: not available");
    expect((data(await appsLoad(loaderCtx(d, "/apps"))).apps as { name: string }[]).map((a) => a.name)).toEqual(["hello", "shop"]);
  });

  test("a viewer-like token (apps:read only) sees the list but cannot create", async () => {
    const { d } = await signedIn(["apps:read"]);
    expect((data(await appsLoad(loaderCtx(d, "/apps"))).apps as unknown[]).length).toBe(1);
    expect(data(await appsActions.create(actionCtx(d, "/apps", "create", { name: "shop" }))).create_error).toContain("does not allow");
  });

  test("an unreachable API is shown, not thrown", async () => {
    const { d } = await signedIn();
    d.fetch = () => Promise.reject(Object.assign(new Error("blocked"), { code: "RENOX_FETCH_BLOCKED" }));
    const p = data(await appsLoad(loaderCtx(d, "/apps"))).problem as { status: number; code: string; message: string };
    expect(p).toMatchObject({ status: 0, code: "RENOX_FETCH_BLOCKED" });
    expect(p.message).toContain("api.renox.app");
  });
});

describe("deployments (3.3, 3.4): promote and rollback", () => {
  test("states, promote, rollback, and the detail panel", async () => {
    const { d, owner } = await signedIn();
    // Activation needs a healthy node to own the tenant (deploy-api.md section 7).
    await registeredNode(d.h, "node-1");
    const a = contentHash(variant(1));
    const b = contentHash(variant(2));
    expect((await upload(d.h, owner, "hello", variant(1))).status).toBe(201);
    expect((await upload(d.h, owner, "hello", variant(2))).status).toBe(201);
    const ctx = () => loaderCtx(d, "/apps/hello/deployments", { params: HELLO });

    let rows = data(await deploymentsLoad(ctx())).deployments as { hash: string; state: string; can_activate: boolean; can_rollback: boolean }[];
    expect(rows.map((r) => [r.hash, r.state, r.can_activate, r.can_rollback])).toEqual([
      [b, "validated", true, false],
      [a, "validated", true, false],
    ]);

    // Promote a, then b: b live, a superseded and promotable, b can roll back.
    expect(data(await deploymentsActions.activate(actionCtx(d, "/apps/hello/deployments", "activate", { hash: a }, { params: HELLO }))).notice).toBe(`${a.slice(0, 7)} is live.`);
    expect(data(await deploymentsActions.activate(actionCtx(d, "/apps/hello/deployments", "activate", { hash: b }, { params: HELLO }))).notice).toBe(`${b.slice(0, 7)} is live.`);
    rows = data(await deploymentsLoad(ctx())).deployments as typeof rows;
    expect(rows.map((r) => [r.state, r.can_activate, r.can_rollback])).toEqual([
      ["active", false, true],
      ["superseded", true, false],
    ]);

    // Rollback from the overview page: a live again.
    expect(data(await overviewActions.rollback(actionCtx(d, "/apps/hello", "rollback", {}, { params: HELLO }))).notice).toBe(`Rolled back: ${a.slice(0, 7)} is live again.`);
    const overview = data(await overviewLoad(loaderCtx(d, "/apps/hello", { params: HELLO })));
    expect(overview.info).toMatchObject({ live: true, version: a.slice(0, 7), hostnames: ["hello.renox.app"] });
    expect((overview.deployments as { state: string }[]).map((r) => r.state)).toEqual(["superseded", "active"]);

    // A wrong hash is the API's answer, shown on the page.
    const wrong = data(await deploymentsActions.activate(actionCtx(d, "/apps/hello/deployments", "activate", { hash: "f".repeat(64) }, { params: HELLO })));
    expect((wrong.action_problem as { status: number }).status).toBe(404);
    expect((data(await deploymentsActions.activate(actionCtx(d, "/apps/hello/deployments", "activate", { hash: "x" }, { params: HELLO }))).action_problem as { code: string }).code).toBe("RENOX_VALIDATION");

    // Detail.
    const detail = data(await deploymentsLoad(loaderCtx(d, `/apps/hello/deployments?hash=${a}`, { params: HELLO }))).detail as Record<string, unknown>;
    expect(detail).toMatchObject({ hash: a, state: "● live", network: "none", violations: [], last_error: null });
  });

  test("a token without deploy cannot promote; the page says so", async () => {
    const { d, owner } = await signedIn(["apps:read"]);
    expect((await upload(d.h, owner, "hello", variant(1))).status).toBe(201);
    const r = data(await deploymentsActions.activate(actionCtx(d, "/apps/hello/deployments", "activate", { hash: contentHash(variant(1)) }, { params: HELLO })));
    expect((r.action_problem as { status: number }).status).toBe(403);
    expect((await d.h.request("GET", "/v1/apps/hello", { token: owner }).then((x) => x.json())).active_deployment).toBeNull();
  });

  test("another tenant's app is not found, as at the API", async () => {
    const { d } = await signedIn();
    const other = await tenant(d.h, "t_other");
    await createApp_(d.h, other, "secret-app");
    const r = data(await deploymentsLoad(loaderCtx(d, "/apps/secret-app/deployments", { params: { app: "secret-app" } })));
    expect((r.problem as { status: number }).status).toBe(404);
    const bad = await deploymentsLoad(loaderCtx(d, "/apps/..%2F/deployments", { params: { app: "../" } }));
    expect((bad as Response).status).toBe(404);
  });
});

describe("logs (3.5)", () => {
  async function withLines() {
    const s = await signedIn();
    expect((await upload(s.d.h, s.owner, "hello", variant(1))).status).toBe(201);
    const hash = contentHash(variant(1));
    const now = Date.now();
    const line = (i: number, level: "info" | "warn" | "error", source: "server" | "client", message: string) => ({
      ts: now - 60_000 + i,
      tenant_id: "t_hello",
      app: "hello",
      deployment_hash: hash,
      request_id: `01JBQ3Z7M8K5V6W9X2Y4A1B3C${i}`,
      module: "functions/api/hello",
      level,
      message,
      fields: i === 2 ? { status: 500 } : null,
      source,
    });
    await addLogs(s.d.h, [line(1, "info", "server", "GET /products 200"), line(2, "error", "server", "<script>alert(1)</script> failed"), line(3, "warn", "client", "htmx timeout")]);
    // Two hours old: outside the default one-hour window.
    await addLogs(s.d.h, [{ ...line(4, "info", "server", "old line"), ts: now - 2 * 3_600_000 }]);
    return { ...s, hash };
  }

  test("newest first within the window, with level, source, search and deployment filters", async () => {
    const { d, hash } = await withLines();
    const get = async (qs: string) => (data(await logsLoad(loaderCtx(d, `/apps/hello/logs${qs}`, { params: HELLO }))).lines as { message: string; level: string; source: string }[]).map((l) => l.message);
    expect(await get("")).toEqual(["htmx timeout", "<script>alert(1)</script> failed", "GET /products 200"]);
    expect(await get("?window=24h")).toHaveLength(4);
    expect(await get("?level=warn")).toEqual(["htmx timeout", "<script>alert(1)</script> failed"]);
    expect(await get("?source=client")).toEqual(["htmx timeout"]);
    expect(await get("?q=PRODUCTS")).toEqual(["GET /products 200"]);
    expect(await get(`?deployment=${hash}`)).toHaveLength(3);
    expect(await get(`?deployment=${"0".repeat(64)}`)).toEqual([]);
    // The source filter goes to the API; the window becomes `since`.
    const sent = d.calls.sent.filter((c) => c.url.includes("/logs")).map((c) => new URL(c.url).searchParams);
    expect(sent.some((p) => p.get("source") === "client")).toBe(true);
    expect(sent.every((p) => Number(p.get("since")) > 0)).toBe(true);
  });

  test("live mode polls the log_lines fragment with the same filters", async () => {
    const { d } = await withLines();
    const page = data(await logsLoad(loaderCtx(d, "/apps/hello/logs?level=warn&live=1", { params: HELLO })));
    expect((page.filters as { live: boolean }).live).toBe(true);
    expect(page.poll_url).toBe("/apps/hello/logs?level=warn&source=all&window=1h&q=&live=1");
    const frag = data(await logsLoad(loaderCtx(d, "/apps/hello/logs?level=warn&live=1", { params: HELLO, fragment: "log_lines" })));
    expect((frag.lines as unknown[]).length).toBe(2);
  });

  test("a token without logs:read gets the API's refusal on the page", async () => {
    const { d } = await signedIn(["apps:read"]);
    const r = data(await logsLoad(loaderCtx(d, "/apps/hello/logs", { params: HELLO })));
    expect((r.problem as { status: number }).status).toBe(403);
  });
});

describe("usage (3.13, per app)", () => {
  test("24 hourly bars, totals and the quota, from the API's rollup", async () => {
    const { d } = await signedIn();
    const r = data(await usageLoad(loaderCtx(d, "/apps/hello/usage", { params: HELLO })));
    expect(r.problem).toBeNull();
    const charts = r.charts as { title: string; bars: { height: number; label: string }[] }[];
    expect(charts.map((c) => c.bars.length)).toEqual([24, 24, 24, 24]);
    expect(charts[3]?.title).toBe("Average latency per hour (ms)");
    expect(charts[0]?.bars.every((b) => b.height === 0)).toBe(true);
    expect(r.totals).toMatchObject({ requests: "0" });
    expect((r.quota as { tier: string; rows: unknown[] }).tier).toBe("free");
    expect((data(await usageLoad(loaderCtx(d, "/apps/hello/usage?range=7d", { params: HELLO }))).charts as { bars: unknown[] }[])[0]?.bars).toHaveLength(168);
    // An unknown range is the default.
    expect(data(await usageLoad(loaderCtx(d, "/apps/hello/usage?range=1y", { params: HELLO }))).range).toBe("24h");
  });
});

test("the latency chart is the mean wall time per request of each hour (#296)", () => {
  const hour = { hour_start: 0, requests: 4, cpu_ms: 10, wall_ms: 90, egress_bytes: 0, fetch_sent_bytes: 0, db_ms: 0, db_rows: 0, render_fuel: 0 };
  expect(meanLatencyMs(hour)).toBe(22.5);
  expect(meanLatencyMs({ ...hour, requests: 0, wall_ms: 0 })).toBe(0);
});

describe("secrets (3.9)", () => {
  const VALUE = "sk_test_value_never_shown_0123456789";

  test("set, list names only, delete; the value never comes back", async () => {
    const { d } = await signedIn();
    const set = data(await secretsActions.set(actionCtx(d, "/apps/hello/secrets", "set", { name: "STRIPE_KEY", value: VALUE }, { params: HELLO })));
    expect(set.notice).toContain("STRIPE_KEY saved (set v1)");
    const list = data(await secretsLoad(loaderCtx(d, "/apps/hello/secrets", { params: HELLO })));
    expect((list.secrets as { name: string }[]).map((s) => s.name)).toEqual(["STRIPE_KEY"]);
    expect(list.version).toBe(1);
    /** docs/24-threat-model.md B, "Secrets in logs, errors, bundle, responses". */
    expect(JSON.stringify([set, list])).not.toContain(VALUE);
    expect(JSON.stringify(d.h.log.lines)).not.toContain(VALUE);
    expect(data(await secretsActions.remove(actionCtx(d, "/apps/hello/secrets", "remove", { name: "STRIPE_KEY" }, { params: HELLO }))).notice).toContain("STRIPE_KEY deleted");
    expect(data(await secretsLoad(loaderCtx(d, "/apps/hello/secrets", { params: HELLO }))).secrets).toEqual([]);
  });

  test("bad names and short values are refused before the API; secrets:read cannot write", async () => {
    const { d } = await signedIn(["apps:read", "secrets:read"]);
    const before = d.calls.sent.length;
    expect(data(await secretsActions.set(actionCtx(d, "/apps/hello/secrets", "set", { name: "lower", value: VALUE }, { params: HELLO }))).form_error).toContain("upper-case");
    expect(data(await secretsActions.set(actionCtx(d, "/apps/hello/secrets", "set", { name: "KEY", value: "short" }, { params: HELLO }))).form_error).toContain("8 characters");
    expect(d.calls.sent.length).toBe(before);
    const r = data(await secretsActions.set(actionCtx(d, "/apps/hello/secrets", "set", { name: "KEY", value: VALUE }, { params: HELLO })));
    expect((r.action_problem as { status: number }).status).toBe(403);
  });
});
