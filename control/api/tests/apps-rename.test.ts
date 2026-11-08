// Rename one app (#537; docs/contracts/deploy-api.md 0.7 section 3;
// docs/24-threat-model.md C, "Custom domain takeover", and E): renameApp
// keeps the app's deployments, secrets, domains, client errors, logs and
// meters, moves its route entries in one delta, keeps its database id,
// quarantines the old name and leaves a hint for the renaming tenant; every
// refusal; an injected failure rolls everything back.

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { holdingApps } from "../src/apps/busy.ts";
import { slugState } from "../src/apps/slugs.ts";
import { createTenantToken } from "../src/auth/tokens.ts";
import { tick } from "../src/domains/jobs.ts";
import { configureDomains } from "../src/domains/service.ts";
import { logIngest } from "../src/ingest/logs.ts";
import { currentVersion, deltaSince } from "../src/routes/table.ts";
import { named, upload } from "./artifacts.ts";
import { StubCloudflare } from "./domain-stubs.ts";
import { addMember, assertScoped, auditRows, createApp_, harness, login, nodeToken, OPERATOR_TOKEN, scopedToken, signup, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const T = "t_ren";
const HOUR = 3_600_000;

interface Setup {
  h: Harness;
  token: string;
  cf: StubCloudflare;
  hashes: Record<string, string>;
  node: string;
}

/** Tenant `t_ren` (paid, an owner account) with live apps `shop` and `notes` on the shared file, and a registered node. */
async function setup(): Promise<Setup> {
  const h = await harness();
  const node = await nodeToken(h, "node-1");
  const reg = await h.request("POST", "/v1/nodes/register", {
    token: node,
    json: { type: "node_register", schema_version: 0, node_id: "node-1", worker_version: "0.7.0", region: "me-central-1", max_cells: 100, listen_url: "http://10.0.0.10:8790" },
  });
  expect(reg.status).toBe(200);
  await signup(h, "owner@ren.test", T);
  await h.db.query("update tenants set tier = 'paid' where id = $1", [T]);
  const token = await scopedToken(h, T, ["*"]);
  const hashes: Record<string, string> = {};
  for (const app of ["shop", "notes"]) {
    await createApp_(h, token, app);
    const files = named(app);
    expect((await upload(h, token, app, files)).status).toBe(201);
    hashes[app] = contentHash(files);
    expect((await h.request("POST", `/v1/apps/${app}/activate`, { token, json: { hash: hashes[app] } })).status).toBe(200);
  }
  const cf = new StubCloudflare();
  configureDomains(h.deps, { cloudflare: cf });
  return { h, token, cf, hashes, node };
}

type Auth = { token?: string; session?: { cookie: string; csrf: string } };
const rename = (h: Harness, app: string, name: unknown, auth: Auth) => h.request("POST", `/v1/apps/${app}/rename`, { ...auth, json: { name } });
const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const names = async (h: Harness, token: string): Promise<string[]> => ((await body(await h.request("GET", "/v1/apps", { token }))).apps as { name: string }[]).map((a) => a.name);
const routes = async (h: Harness, app: string) =>
  h.db.query<{ hostname: string; deployment_hash: string; status: string; database: string | null }>(
    "select hostname, deployment_hash, status, database from route_entries where app = $1 order by hostname, deployment_hash",
    [app],
  );
const count = async (h: Harness, table: string, app: string): Promise<number> => Number((await h.db.query<{ n: unknown }>(`select count(*) as n from ${table} where app = $1`, [app]))[0]?.n ?? 0);

describe("renameApp (deploy-api.md 0.7 section 3)", () => {
  test("shop -> store: the same app under the new name; the old name 404 with the hint; one route delta moves the hostname; the custom domain stays; audited", async () => {
    const { h, token, cf, hashes } = await setup();
    // A secret, a verified custom domain, a client error group, a module install, an advisory, a meter row and a log line.
    expect((await h.request("PUT", "/v1/apps/shop/secrets/API_KEY", { token, json: { value: "sk_live_000000" } })).status).toBe(200);
    expect((await h.request("POST", "/v1/apps/shop/domains", { token, json: { hostname: "www.shop.example" } })).status).toBe(201);
    cf.setStatus("www.shop.example", "active");
    await tick(h.deps);
    expect((await routes(h, "shop")).map((r) => r.hostname)).toEqual(["shop.renox.app", "www.shop.example"]);
    await h.db.query("insert into client_error_groups (tenant_id, app, fingerprint, kind, message, first_seen, last_seen, count) values ($1, 'shop', '0123456789abcdef', 'error', 'boom', $2, $2, 1)", [T, h.clock.now]);
    await h.db.query(
      "insert into client_error_events (tenant_id, app, fingerprint, ts, client_ts, deployment_hash, message, url, ua, frames) values ($1, 'shop', '0123456789abcdef', $2, $2, $3, 'boom', 'https://shop.renox.app/', 'ua', '[]'::jsonb)",
      [T, h.clock.now, hashes.shop],
    );
    await h.db.query("insert into client_error_deployments (tenant_id, app, fingerprint, deployment_hash, count) values ($1, 'shop', '0123456789abcdef', $2, 1)", [T, hashes.shop]);
    await h.db.query("insert into app_modules (tenant_id, app, name, source, version, hash, approved, approved_at) values ($1, 'shop', 'auth', 'registry:renox/auth', '1.0.0', $2, '{}', $3)", [T, "a".repeat(64), h.clock.now]);
    await h.db.query("insert into deployment_advisories (tenant_id, app, hash, sbom, checked_at) values ($1, 'shop', $2, false, $3) on conflict do nothing", [T, hashes.shop, h.clock.now]);
    const hour = Math.floor(h.clock.now / HOUR) * HOUR;
    await h.db.query("insert into meters_hourly (tenant_id, deployment_hash, hour_start, requests) values ($1, $2, $3, 42)", [T, hashes.shop, hour]);
    await logIngest(h.deps).store.append([
      { ts: h.clock.now, tenant_id: T, app: "shop", deployment_hash: hashes.shop as string, request_id: null, module: "app", level: "info", message: "hello", fields: null, source: "server", node_id: "node-1" },
    ]);
    const before = await body(await h.request("GET", "/v1/apps/shop", { token }));
    const version = await currentVersion(h.db);

    const res = await rename(h, "shop", "store", { token });
    expect(res.status).toBe(200);
    const view = await body(res);
    expect(view).toMatchObject({ name: "store", tenant_id: T, created_at: before.created_at, active_deployment: hashes.shop, hostnames: ["store.renox.app", "www.shop.example"] });
    expect(await body(await h.request("GET", "/v1/apps/store", { token }))).toEqual(view);
    expect(await names(h, token)).toEqual(["notes", "store"]);

    // The old name: 404 everywhere; getApp names the new one to this tenant only.
    const old = await h.request("GET", "/v1/apps/shop", { token });
    expect(old.status).toBe(404);
    expect(((await body(old)).error as { details?: unknown }).details).toEqual([{ field: "renamed_to", reason: "store" }]);
    expect((await h.request("GET", "/v1/apps/shop/deployments", { token })).status).toBe(404);
    const other = await tenant(h, "t_other");
    const foreign = await h.request("GET", "/v1/apps/shop", { token: other });
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(await foreign.json())).not.toContain("store");

    // Secrets (names), domains, deployments, client errors, usage, logs: listed under the new name.
    expect(JSON.stringify(await body(await h.request("GET", "/v1/apps/store/secrets", { token })))).toContain("API_KEY");
    const domains = (await body(await h.request("GET", "/v1/apps/store/domains", { token }))).domains as { hostname: string; app: string; state: string }[];
    expect(domains.map((d) => [d.hostname, d.app, d.state])).toEqual([["www.shop.example", "store", "verified"]]);
    expect(cf.of("www.shop.example")).toBeDefined();
    expect(cf.calls.filter((c) => c.startsWith("delete "))).toEqual([]);
    const deployments = (await body(await h.request("GET", "/v1/apps/store/deployments", { token }))).deployments as { hash: string; state: string; app: string }[];
    expect(deployments.map((d) => [d.app, d.hash, d.state])).toEqual([["store", hashes.shop as string, "active"]]);
    const groups = (await body(await h.request("GET", "/v1/apps/store/client-errors", { token }))).groups as { fingerprint: string }[];
    expect(groups.map((g) => g.fingerprint)).toEqual(["0123456789abcdef"]);
    for (const table of ["client_error_events", "client_error_deployments", "app_modules", "deployment_advisories", "permissions", "secrets", "secret_sets"]) {
      expect([table, await count(h, table, "shop")]).toEqual([table, 0]);
    }
    expect(await count(h, "app_modules", "store")).toBe(1);
    expect(await count(h, "deployment_advisories", "store")).toBe(1);
    const usage = await body(await h.request("GET", "/v1/apps/store/usage", { token }));
    expect((usage.total as { requests: number }).requests).toBe(42);
    expect((await logIngest(h.deps).store.read(T, "store", { since: 0 })).map((l) => l.message)).toEqual(["hello"]);
    expect(await logIngest(h.deps).store.read(T, "shop", { since: 0 })).toEqual([]);

    // The route delta: the old platform hostname removed; the new one and the custom domain written with the new app name.
    const delta = await deltaSince(h.db, version);
    expect(delta?.removals.map((r) => r.hostname)).toEqual(["shop.renox.app"]);
    expect(delta?.upserts.map((u) => [u.hostname, u.app, u.deployment_hash, u.status]).sort()).toEqual([
      ["store.renox.app", "store", hashes.shop as string, "active"],
      ["www.shop.example", "store", hashes.shop as string, "active"],
    ]);
    expect((await routes(h, "store")).map((r) => r.hostname)).toEqual(["store.renox.app", "www.shop.example"]);
    expect(await routes(h, "shop")).toEqual([]);
    // The other app of the shared file is untouched.
    expect((await routes(h, "notes")).map((r) => r.hostname)).toEqual(["notes.renox.app"]);
    // The domain job keeps the custom domain on the new app.
    await tick(h.deps);
    expect((await routes(h, "store")).map((r) => r.hostname)).toEqual(["store.renox.app", "www.shop.example"]);

    const audit = (await auditRows(h)).filter((r) => r.action === "renameApp");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: 200, target: { app: "shop", from: "shop", to: "store", routes_removed: "2", routes_written: "2" } });
  });

  test("a cell created before the rename still gets its secret bundle under the old name; another tenant's or an unknown name does not", async () => {
    const { h, token, hashes, node } = await setup();
    const version = Number((await h.db.query<{ v: unknown }>("select secrets_version as v from deployments where app = 'shop' and hash = $1", [hashes.shop]))[0]?.v);
    const fetchAs = (app: string) => h.request("GET", `/v1/nodes/node-1/secrets/${app}/${hashes.shop}?version=${version}`, { token: node });
    expect((await fetchAs("shop")).status).toBe(200);
    expect((await rename(h, "shop", "store", { token })).status).toBe(200);
    const old = await fetchAs("shop");
    expect(old.status).toBe(200);
    expect(await body(old)).toMatchObject({ tenant_id: T, app: "store", deployment_hash: hashes.shop, version });
    expect((await fetchAs("store")).status).toBe(200);
    expect((await fetchAs("nothing")).status).toBe(404);
    // Another tenant cannot reach the bundle through the old name of this one.
    expect((await h.db.query("select 1 from app_renames where old_name = 'shop' and tenant_id <> $1", [T])).length).toBe(0);
  });

  test("the database id does not change: the shared file stays the tenant's; an own database keeps <tenant_id>.<old>; a new staging app cannot take that id", async () => {
    const { h, token, hashes } = await setup();
    // Shared file: no database on the entry, before and after.
    expect((await routes(h, "notes")).map((r) => r.database)).toEqual([null]);
    expect((await rename(h, "notes", "memo", { token })).status).toBe(200);
    expect((await routes(h, "memo")).map((r) => [r.hostname, r.deployment_hash, r.database])).toEqual([["memo.renox.app", hashes.notes as string, null]]);
    // Own database: the staging app's id stays <tenant_id>.stage.
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "stage", staging: true } })).status).toBe(201);
    const files = named("stage");
    expect((await upload(h, token, "stage", files)).status).toBe(201);
    expect((await h.request("POST", "/v1/apps/stage/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
    expect((await routes(h, "stage")).map((r) => r.database)).toEqual([`${T}.stage`]);
    expect((await rename(h, "stage", "preprod", { token })).status).toBe(200);
    expect((await routes(h, "preprod")).map((r) => [r.hostname, r.database])).toEqual([["preprod.renox.app", `${T}.stage`]]);
    expect((await h.db.query<{ database: string | null; staging: boolean }>("select database, staging from apps where name = 'preprod'"))[0]).toEqual({ database: `${T}.stage`, staging: true });
    // The tenant may take the old name again, but not as a staging app whose database id is still in use.
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "stage", staging: true } })).status).toBe(409);
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "stage" } })).status).toBe(201);
    // Taking the name again ends its hint: getApp answers the new app.
    expect((await body(await h.request("GET", "/v1/apps/stage", { token }))).name).toBe("stage");
  });

  test("refused: a taken name, a deleted app's name, a reserved name for an ordinary tenant (the platform tenant may), a quarantined name, the same name, an invalid name (400), another tenant's app (404)", async () => {
    const { h, token } = await setup();
    const other = await tenant(h, "t_other");
    await createApp_(h, other, "theirs");
    const notAvailable = async (res: Response): Promise<void> => {
      expect(res.status).toBe(409);
      const text = JSON.stringify(await res.json());
      expect(text).toContain("not available");
      expect(text).not.toContain("t_other");
    };
    await notAvailable(await rename(h, "shop", "notes", { token }));
    await notAvailable(await rename(h, "shop", "theirs", { token }));
    // A deleted app still reserves its name.
    expect((await h.request("DELETE", "/v1/apps/notes", { token, json: { confirm: "notes" } })).status).toBe(200);
    await notAvailable(await rename(h, "shop", "notes", { token }));
    await notAvailable(await rename(h, "shop", "dashboard", { token }));
    // Another tenant's quarantined name.
    expect((await rename(h, "theirs", "kept", { token: other })).status).toBe(200);
    await notAvailable(await rename(h, "shop", "theirs", { token }));
    // 400: invalid or unchanged.
    for (const bad of ["Shop", "1shop", "", "a".repeat(51)]) {
      const r = await rename(h, "shop", bad, { token });
      expect([bad, r.status]).toEqual([bad, 400]);
    }
    expect((await h.request("POST", "/v1/apps/shop/rename", { token, json: {} })).status).toBe(400);
    expect((await rename(h, "shop", "shop", { token })).status).toBe(400);
    // Another tenant's app and an unknown app: 404, never 403.
    expect((await rename(h, "kept", "mine", { token })).status).toBe(404);
    expect((await rename(h, "nope", "mine", { token })).status).toBe(404);
    // A deleted app cannot be renamed.
    expect((await rename(h, "notes", "memo", { token })).status).toBe(404);
    // Nothing moved.
    expect(await names(h, token)).toEqual(["shop"]);
    expect((await routes(h, "shop")).map((r) => r.hostname)).toEqual(["shop.renox.app"]);
    // The platform tenant may take a reserved name.
    expect((await h.request("POST", `/v1/ops/tenants/${T}/platform`, { token: OPERATOR_TOKEN, json: { platform: true, reason: "the platform's own apps (#396)" } })).status).toBe(200);
    const res = await rename(h, "shop", "dashboard", { token });
    expect(res.status).toBe(200);
    expect((await body(res)).hostnames).toEqual(["dashboard.renox.app"]);
    // Quarantine applies to the platform tenant like to everyone.
    await notAvailable(await rename(h, "dashboard", "theirs", { token }));
  });

  test("permissions: owner and admin (apps:delete); a token without it, the developer and viewer roles are 403", async () => {
    const { h, token } = await setup();
    const writer = await scopedToken(h, T, ["apps:read", "apps:write", "deploy"]);
    expect((await rename(h, "shop", "store", { token: writer })).status).toBe(403);
    for (const role of ["viewer", "developer"]) {
      await signup(h, `${role}@ren.test`);
      await addMember(h, T, `${role}@ren.test`, role);
      const session = await login(h, `${role}@ren.test`, undefined, { tenant_id: T });
      expect((await rename(h, "shop", "store", { session })).status).toBe(403);
      const uid = (await h.db.query<{ id: string }>("select id from users where email = $1", [`${role}@ren.test`]))[0]?.id as string;
      const userToken = (await createTenantToken(h.db, T, "cli", ["*"], 30, h.clock.now, uid)).token;
      expect((await rename(h, "shop", "store", { token: userToken })).status).toBe(403);
    }
    expect(await names(h, token)).toEqual(["notes", "shop"]);
    await signup(h, "admin@ren.test");
    await addMember(h, T, "admin@ren.test", "admin");
    const admin = await login(h, "admin@ren.test", undefined, { tenant_id: T });
    expect((await rename(h, "shop", "store", { session: admin })).status).toBe(200);
    const deleter = await scopedToken(h, T, ["apps:delete"]);
    expect((await rename(h, "store", "boutique", { token: deleter })).status).toBe(200);
    // The hint follows the chain: the first name points at the latest.
    expect(((await body(await h.request("GET", "/v1/apps/shop", { token }))).error as { details?: unknown }).details).toEqual([{ field: "renamed_to", reason: "boutique" }]);
    expect(((await body(await h.request("GET", "/v1/apps/store", { token }))).error as { details?: unknown }).details).toEqual([{ field: "renamed_to", reason: "boutique" }]);
    expect((await auditRows(h)).filter((r) => r.action === "renameApp").map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 200, 200]);
  });

  test("the old name is quarantined: another tenant cannot take it, by createApp or by a rename; the renaming tenant can", async () => {
    const { h, token } = await setup();
    expect((await rename(h, "shop", "store", { token })).status).toBe(200);
    expect(await slugState(h.db, "shop", "t_other", h.clock.now)).toBe("quarantined");
    const other = await tenant(h, "t_other");
    expect((await h.request("POST", "/v1/apps", { token: other, json: { name: "shop" } })).status).toBe(409);
    await createApp_(h, other, "theirs");
    expect((await rename(h, "theirs", "shop", { token: other })).status).toBe(409);
    // The renaming tenant may rename back.
    expect((await rename(h, "store", "shop", { token })).status).toBe(200);
    expect((await routes(h, "shop")).map((r) => r.hostname)).toEqual(["shop.renox.app"]);
    expect((await h.request("GET", "/v1/apps/shop", { token })).status).toBe(200);
    expect(((await body(await h.request("GET", "/v1/apps/store", { token }))).error as { details?: unknown }).details).toEqual([{ field: "renamed_to", reason: "shop" }]);
  });

  test("409 while a restore or an import involves the app, or the tenant moves", async () => {
    const { h, token } = await setup();
    for (const reason of ["restore in progress", "import in progress"] as const) {
      await holdingApps(h.deps, T, ["shop"], reason, async () => {
        const r = await rename(h, "shop", "store", { token });
        expect(r.status).toBe(409);
        expect(JSON.stringify(await r.json())).toContain(reason);
      });
    }
    await h.db.query("update tenants set moving_since = $2 where id = $1", [T, h.clock.now]);
    expect((await rename(h, "shop", "store", { token })).status).toBe(409);
    await h.db.query("update tenants set moving_since = null where id = $1", [T]);
    expect((await rename(h, "shop", "store", { token })).status).toBe(200);
  });

  test("one transaction: a failure in the middle leaves the old name fully in place", async () => {
    const { h, token, hashes } = await setup();
    expect((await h.request("PUT", "/v1/apps/shop/secrets/API_KEY", { token, json: { value: "sk_live_000000" } })).status).toBe(200);
    const version = await currentVersion(h.db);
    // The last write of the rename (its hint) fails.
    await h.db.exec(`
      create function test_fail_rename() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$;
      create trigger test_fail_rename before insert on app_renames for each row execute function test_fail_rename();
    `);
    try {
      const res = await rename(h, "shop", "store", { token });
      expect(res.status).toBe(500);
    } finally {
      await h.db.exec("drop trigger test_fail_rename on app_renames; drop function test_fail_rename();");
    }
    expect(await names(h, token)).toEqual(["notes", "shop"]);
    expect((await body(await h.request("GET", "/v1/apps/shop", { token }))).active_deployment).toBe(hashes.shop);
    expect((await routes(h, "shop")).map((r) => r.hostname)).toEqual(["shop.renox.app"]);
    expect(await routes(h, "store")).toEqual([]);
    for (const table of ["deployments", "secrets", "secret_sets", "permissions"]) expect([table, await count(h, table, "store")]).toEqual([table, 0]);
    expect(await count(h, "deployments", "shop")).toBe(1);
    expect(await currentVersion(h.db)).toBe(version);
    expect(await slugState(h.db, "shop", "t_other", h.clock.now)).toBe("available");
    expect((await h.request("GET", "/v1/apps/store", { token })).status).toBe(404);
    // Without the failure the same rename goes through.
    expect((await rename(h, "shop", "store", { token })).status).toBe(200);
  });
});
