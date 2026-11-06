// The domains page (#477): list with state and records, add, remove, against the
// real control API (in process) with StubCloudflare; Cloudflare is never called.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import { tick } from "../../api/src/domains/jobs.ts";
import { configureDomains } from "../../api/src/domains/service.ts";
import { EDGE, StubCloudflare } from "../../api/tests/domain-stubs.ts";
import { assertScoped, createApp_, scopedToken, tenant } from "../../api/tests/helpers.ts";
import { load, actions, hostnameOf } from "../pages/apps/[app]/domains.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, dash, loaderCtx } from "./helpers.ts";

setDefaultTimeout(30_000);
afterEach(assertScoped);

const HELLO = { app: "hello" };
const HOST = "www.example.com";

type Data = Record<string, unknown>;
const data = (v: unknown): Data => {
  expect(v).not.toBeInstanceOf(Response);
  return v as Data;
};

async function signedIn(scopes?: string[]) {
  const d = await dash();
  const owner = await tenant(d.h, "t_hello", "paid");
  await createApp_(d.h, owner, "hello");
  const cf = new StubCloudflare();
  configureDomains(d.h.deps, { cloudflare: cf });
  const token = scopes === undefined ? owner : await scopedToken(d.h, "t_hello", scopes);
  expect(await signinActions.default(actionCtx(d, "/signin", "default", { token, next: "/apps" }))).toBeInstanceOf(Response);
  return { d, cf, token };
}

type Row = { hostname: string; state: string; pending: boolean; verified: boolean; records: { type: string; name: string; value: string; purpose: string }[] };

describe("domains (3.10)", () => {
  test("add shows the CNAME and both TXT records while pending; verified once Cloudflare reports active; remove detaches", async () => {
    const { d, cf } = await signedIn();
    expect(data(await load(loaderCtx(d, "/apps/hello/domains", { params: HELLO }))).domains).toEqual([]);

    const added = data(await actions.add(actionCtx(d, "/apps/hello/domains", "add", { hostname: "WWW.Example.com" }, { params: HELLO })));
    expect(added.notice).toContain(`${HOST} added`);
    const id = cf.of(HOST)?.id as string;
    const [row] = data(await load(loaderCtx(d, "/apps/hello/domains", { params: HELLO }))).domains as Row[];
    expect(row).toMatchObject({ hostname: HOST, state: "pending", pending: true, verified: false });
    expect(row?.records.map((r) => [r.type, r.name, r.value])).toEqual([
      ["CNAME", HOST, EDGE],
      ["TXT", `_cf-custom-hostname.${HOST}`, `own-${id}`],
      ["TXT", `_acme-challenge.${HOST}`, `dcv-${id}`],
    ]);

    cf.setStatus(HOST, "active");
    await tick(d.h.deps);
    const [ok] = data(await load(loaderCtx(d, "/apps/hello/domains", { params: HELLO }))).domains as Row[];
    expect(ok).toMatchObject({ state: "verified", verified: true, pending: false });

    const removed = data(await actions.remove(actionCtx(d, "/apps/hello/domains", "remove", { hostname: HOST }, { params: HELLO })));
    expect(removed.notice).toContain(`${HOST} removed`);
    expect(((data(await load(loaderCtx(d, "/apps/hello/domains", { params: HELLO }))).domains as Row[])[0] as Row).state).toBe("detached");
  });

  test("a bad hostname is refused before the API; the API's refusals (platform domain, taken, no write scope) are shown", async () => {
    const { d, cf } = await signedIn();
    const before = d.calls.sent.length;
    for (const hostname of ["", "https://www.example.com/", "www.example.com:443", "../x", "localhost"]) {
      expect(data(await actions.add(actionCtx(d, "/apps/hello/domains", "add", { hostname }, { params: HELLO }))).form_error).toContain("full hostname");
    }
    expect(d.calls.sent.length).toBe(before);
    expect(cf.calls).toEqual([]);
    const platform = data(await actions.add(actionCtx(d, "/apps/hello/domains", "add", { hostname: "x.renox.app" }, { params: HELLO })));
    expect((platform.action_problem as { status: number }).status).toBe(400);
  });

  test("apps:read lists but cannot add or remove (domains:write)", async () => {
    const { d } = await signedIn(["apps:read"]);
    expect(data(await load(loaderCtx(d, "/apps/hello/domains", { params: HELLO }))).problem).toBeNull();
    const r = data(await actions.add(actionCtx(d, "/apps/hello/domains", "add", { hostname: HOST }, { params: HELLO })));
    expect((r.action_problem as { status: number }).status).toBe(403);
  });

  test("hostnameOf", () => {
    expect(hostnameOf(" WWW.Example.COM. ")).toBe(HOST);
    expect(hostnameOf("a_b.example.com")).toBeNull();
    expect(hostnameOf(undefined)).toBeNull();
  });
});
