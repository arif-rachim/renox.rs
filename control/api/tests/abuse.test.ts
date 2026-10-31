// Abuse controls (#123; deploy-api.md 0.5 sections 21-22): a public report
// becomes a ticket for the hostname's tenant, an operator takes it down
// (routes suspended) and restores it, transitions follow the abuse table,
// and a disposable sign-up domain is refused.
import { afterEach, expect, test } from "bun:test";

import { contentHash } from "@renox/artifact-validate";

import { ABUSE_TRANSITIONS } from "../src/abuse/routes.ts";
import { disposable } from "../src/signup/friction.ts";
import spec from "../../../docs/contracts/schemas/deploy-api.yaml";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, auditRows, harness, OPERATOR_TOKEN, registeredNode, tenant } from "./helpers.ts";

afterEach(assertScoped);

test("the transitions are deploy-api.yaml's abuse machine", () => {
  const machine = (spec as any)["x-renox-state-machines"].abuse.transitions;
  for (const [s, to] of Object.entries(ABUSE_TRANSITIONS)) expect([...to].sort()).toEqual([...(machine[s] as string[])].sort());
});

test("report, take down (routes gone), a refused transition, restore (routes back)", async () => {
  const h = await harness();
  const token = await tenant(h, "t_phish");
  expect((await h.request("POST", "/v1/apps", { token, json: { name: "hello" } })).status).toBe(201);
  const files = helloArtifact();
  expect((await upload(h, token, "hello", files)).status).toBe(201);
  await registeredNode(h, "node-1");
  expect((await h.request("POST", "/v1/apps/hello/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
  const host = (await h.db.query<{ hostname: string }>("select hostname from route_entries where tenant_id = 't_phish' limit 1"))[0]?.hostname as string;
  const routes = async () => (await h.db.query<{ n: number }>("select count(*)::int as n from route_entries where tenant_id = 't_phish' and status = 'active'"))[0]?.n;
  expect((await h.request("POST", "/v1/abuse", { json: { url: `https://${host}/login`, category: "phishing", description: "x", captcha_token: "t" } })).status).toBe(400);
  const r = await h.request("POST", "/v1/abuse", { json: { url: `https://${host}/login`, category: "phishing", description: "Imitates a bank login page", captcha_token: "t", reporter_email: "r@x.ae" } });
  expect(r.status).toBe(202);
  const { ticket_id } = (await r.json()) as { ticket_id: string };
  const list = (await (await h.request("GET", "/v1/ops/abuse?state=open", { token: OPERATOR_TOKEN })).json()) as { items: Record<string, unknown>[] };
  expect(list.items[0]).toMatchObject({ id: ticket_id, hostname: host, tenant_id: "t_phish", state: "open" });
  expect(JSON.stringify(list)).not.toContain("r@x.ae");
  expect((await h.request("GET", "/v1/ops/abuse", { token })).status).toBe(403);
  const down = await h.request("POST", `/v1/ops/abuse/${ticket_id}`, { token: OPERATOR_TOKEN, json: { state: "taken_down", reason: "Confirmed bank phishing page" } });
  expect(down.status).toBe(200);
  expect(await routes()).toBe(0);
  expect((await h.request("POST", `/v1/ops/abuse/${ticket_id}`, { token: OPERATOR_TOKEN, json: { state: "dismissed", reason: "changed my mind about it" } })).status).toBe(409);
  expect((await h.request("POST", `/v1/ops/abuse/${ticket_id}`, { token: OPERATOR_TOKEN, json: { state: "restored", reason: "The site was cleaned up" } })).status).toBe(200);
  expect(await routes()).toBeGreaterThan(0);
});

test("report → ticket → takedown → the neutral page's entries, audited; another tenant on the node unaffected (#123 acceptance 1)", async () => {
  const h = await harness();
  await registeredNode(h, "node-1");
  const hosts: Record<string, string> = {};
  for (const [id, app] of [["t_phish2", "bankcopy"], ["t_shop2", "storefront"]] as const) {
    const token = await tenant(h, id);
    expect((await h.request("POST", "/v1/apps", { token, json: { name: app } })).status).toBe(201);
    const files = helloArtifact((m) => ((m.app as Record<string, unknown>).name = app));
    expect((await upload(h, token, app, files)).status).toBe(201);
    expect((await h.request("POST", `/v1/apps/${app}/activate`, { token, json: { hash: contentHash(files) } })).status).toBe(200);
    hosts[id] = (await h.db.query<{ hostname: string }>("select hostname from route_entries where tenant_id = $1 limit 1", [id]))[0]?.hostname as string;
  }
  const entries = (id: string) => h.db.query<{ status: string; display_name: string | null }>("select status, display_name from route_entries where tenant_id = $1 order by hostname", [id]);
  const before = await entries("t_shop2");
  const r = await h.request("POST", "/v1/abuse", { json: { url: `https://${hosts.t_phish2}/`, category: "phishing", description: "A copy of a bank's sign-in page", captcha_token: "t" }, headers: { "x-forwarded-for": "203.0.113.9" } });
  expect(r.status).toBe(202);
  const { ticket_id } = (await r.json()) as { ticket_id: string };
  expect((await h.request("POST", `/v1/ops/abuse/${ticket_id}`, { token: OPERATOR_TOKEN, json: { state: "reviewing", reason: "Checking the reported page" } })).status).toBe(200);
  expect((await h.request("POST", `/v1/ops/abuse/${ticket_id}`, { token: OPERATOR_TOKEN, json: { state: "taken_down", reason: "Confirmed bank phishing page" } })).status).toBe(200);
  // The gateway serves the neutral page from these (crates/renox-gateway/tests/suspended.rs).
  const [{ name }] = (await h.db.query<{ name: string }>("select name from tenants where id = 't_phish2'")) as [{ name: string }];
  const down = await entries("t_phish2");
  expect(down.length).toBeGreaterThan(0);
  expect(down.every((e) => e.status === "suspended" && e.display_name === name)).toBe(true);
  expect((await h.db.query<{ state: string }>("select state from tenants where id = 't_phish2'"))[0]?.state).toBe("suspended");
  // The other tenant on the same node keeps its active entries, unchanged.
  expect(await entries("t_shop2")).toEqual(before);
  expect(before.every((e) => e.status === "active")).toBe(true);
  // Audited: the report, each transition with its reason.
  const audit = (await auditRows(h)).filter((a) => ["reportAbuse", "setAbuseTicket"].includes(String(a.action)));
  expect(audit.map((a) => [a.action, (a.target as Record<string, unknown>).to ?? (a.target as Record<string, unknown>).category, a.status])).toEqual([
    ["reportAbuse", "phishing", 202],
    ["setAbuseTicket", "reviewing", 200],
    ["setAbuseTicket", "taken_down", 200],
  ]);
  expect(audit.every((a) => (a.target as Record<string, unknown>).ticket === ticket_id)).toBe(true);
});

test("a disposable sign-up domain is refused", async () => {
  expect(disposable("x@mailinator.com")).toBe(true);
  expect(disposable("x@sub.yopmail.com")).toBe(true);
  expect(disposable("owner@hello.ae")).toBe(false);
  const h = await harness();
  const r = await h.request("POST", "/v1/account/signup", { json: { email: "bot@mailinator.com", password: "correct horse battery staple", tenant_id: "t_bot" } });
  expect(r.status).toBe(400);
});
