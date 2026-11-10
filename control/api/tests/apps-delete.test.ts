// Delete and restore one app (#536; docs/contracts/deploy-api.md 0.7 section
// 3; docs/24-threat-model.md E, "App deleted by a token with apps:delete"):
// deleteApp, restoreApp, listApps?deleted=true, the 7-day window, the purge
// sweep, the refusals, the conflict, shared versus own database, detached
// custom domains.

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { holdingApps } from "../src/apps/busy.ts";
import { RESTORE_WINDOW_MS } from "../src/apps/repo.ts";
import { sweepAppDeletions } from "../src/apps/purge.ts";
import { slugState } from "../src/apps/slugs.ts";
import { createTenantToken } from "../src/auth/tokens.ts";
import { tick } from "../src/domains/jobs.ts";
import { configureDomains } from "../src/domains/service.ts";
import { currentVersion, deltaSince } from "../src/routes/table.ts";
import { setNodeCall } from "../src/workers/failover.ts";
import { named, upload } from "./artifacts.ts";
import { StubCloudflare } from "./domain-stubs.ts";
import { addMember, assertScoped, auditRows, createApp_, harness, login, nodeToken, scopedToken, signup, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const T = "t_del";
const DAY = 86_400_000;

interface Setup {
  h: Harness;
  token: string;
  cf: StubCloudflare;
  hashes: Record<string, string>;
  drops: string[];
  nodeUp: { up: boolean };
}

/** Tenant `t_del` (paid, an owner account) with live apps `shop` and `notes` on the shared file, and node-1 with a listener. */
async function setup(): Promise<Setup> {
  const h = await harness();
  const node = await nodeToken(h, "node-1");
  const reg = await h.request("POST", "/v1/nodes/register", {
    token: node,
    json: { type: "node_register", schema_version: 0, node_id: "node-1", worker_version: "0.7.0", region: "me-central-1", max_cells: 100, listen_url: "http://10.0.0.10:8790" },
  });
  expect(reg.status).toBe(200);
  await signup(h, "owner@del.test", T);
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
  const drops: string[] = [];
  const nodeUp = { up: true };
  setNodeCall(h.deps, async (_target, method, path) => {
    if (!nodeUp.up) throw new Error("unreachable");
    drops.push(`${method} ${path}`);
    const database = new URL(path, "http://node").searchParams.get("database");
    return {
      status: 200,
      body: { type: "tenant_dropped", schema_version: 0, node_id: "node-1", tenant_id: T, ...(database === null ? {} : { database }), cells_drained: 1, file: "kept", replica_generations_deleted: 2, replica_purged_at: h.clock.now },
    };
  });
  return { h, token, cf, hashes, drops, nodeUp };
}

const del = (h: Harness, app: string, auth: { token?: string; session?: { cookie: string; csrf: string } }, confirm = app) => h.request("DELETE", `/v1/apps/${app}`, { ...auth, json: { confirm } });
const restore = (h: Harness, app: string, auth: { token?: string; session?: { cookie: string; csrf: string } }) => h.request("POST", `/v1/apps/${app}/restore`, auth);
const names = async (h: Harness, token: string, query = ""): Promise<string[]> => ((await (await h.request("GET", `/v1/apps${query}`, { token })).json()) as { apps: { name: string }[] }).apps.map((a) => a.name);
const rows = async (h: Harness, table: string, app: string, column = "app"): Promise<number> =>
  Number((await h.db.query<{ n: unknown }>(`select count(*) as n from ${table} where ${column} = $1`, [app]))[0]?.n ?? 0);
const hostsOf = async (h: Harness, app: string): Promise<string[]> => (await h.db.query<{ hostname: string }>("select hostname from route_entries where app = $1 order by hostname", [app])).map((r) => r.hostname);

describe("deleteApp and restoreApp (deploy-api.md 0.7 section 3)", () => {
  test("delete: 200 with restorable_until; 404 afterwards, absent from listApps, listed with deleted=true; one route delta removes the hostname; the other app of the shared file keeps serving; audited", async () => {
    const { h, token } = await setup();
    const before = await currentVersion(h.db);
    const res = await del(h, "shop", { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "shop", deleted_at: h.clock.now, restorable_until: h.clock.now + 7 * DAY });
    expect((await h.request("GET", "/v1/apps/shop", { token })).status).toBe(404);
    expect((await h.request("GET", "/v1/apps/shop/deployments", { token })).status).toBe(404);
    expect((await h.request("GET", "/v1/apps/shop/secrets", { token })).status).toBe(404);
    expect(await names(h, token)).toEqual(["notes"]);
    const deleted = (await (await h.request("GET", "/v1/apps?deleted=true", { token })).json()) as { apps: Record<string, unknown>[] };
    expect(deleted.apps).toMatchObject([{ name: "shop", deleted_at: h.clock.now, restorable_until: h.clock.now + RESTORE_WINDOW_MS }]);
    expect((await h.request("GET", "/v1/apps?deleted=maybe", { token })).status).toBe(400);
    // The route delta: shop's hostname in removals, nothing of notes.
    const delta = await deltaSince(h.db, before);
    expect(delta?.removals.map((r) => r.hostname)).toEqual(["shop.renox.app"]);
    expect(delta?.upserts).toEqual([]);
    expect(await hostsOf(h, "shop")).toEqual([]);
    // The shared file: notes is untouched and still routed (its database is the tenant's).
    expect(await hostsOf(h, "notes")).toEqual(["notes.renox.app"]);
    expect((await h.request("GET", "/v1/apps/notes", { token })).status).toBe(200);
    expect((await h.db.query<{ database: string | null }>("select database from route_entries where app = 'notes'"))[0]?.database ?? null).toBeNull();
    const audit = (await auditRows(h)).filter((r) => r.action === "deleteApp");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: 200, target: { app: "shop", deleted_at: String(h.clock.now), restorable_until: String(h.clock.now + 7 * DAY) } });
  });

  test("restore within 7 days lists the app again and re-publishes its active deployment; after 7 days, or for a live app, 404", async () => {
    const { h, token, hashes } = await setup();
    expect((await del(h, "shop", { token })).status).toBe(200);
    expect((await restore(h, "notes", { token })).status).toBe(404);
    h.clock.now += 6 * DAY;
    const before = await currentVersion(h.db);
    const res = await restore(h, "shop", { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "shop", active_deployment: hashes.shop, hostnames: ["shop.renox.app"] });
    expect(await names(h, token)).toEqual(["notes", "shop"]);
    expect(await names(h, token, "?deleted=true")).toEqual([]);
    const delta = await deltaSince(h.db, before);
    expect(delta?.upserts.map((u) => [u.hostname, u.deployment_hash, u.status])).toEqual([["shop.renox.app", hashes.shop as string, "active"]]);
    expect((await auditRows(h)).filter((r) => r.action === "restoreApp").map((r) => r.status)).toEqual([404, 200]);
    // Restoring a live app is 404; a second delete then works again.
    expect((await restore(h, "shop", { token })).status).toBe(404);
    expect((await del(h, "shop", { token })).status).toBe(200);
    h.clock.now += 7 * DAY;
    expect((await restore(h, "shop", { token })).status).toBe(404);
    expect(await names(h, token, "?deleted=true")).toEqual([]);
  });

  test("refused: a token without apps:delete, the viewer and developer roles, another tenant's app (404), a wrong confirm (400), delete twice (404); the admin and a token with apps:delete may", async () => {
    const { h, token } = await setup();
    const writer = await scopedToken(h, T, ["apps:read", "apps:write", "deploy"]);
    expect((await del(h, "shop", { token: writer })).status).toBe(403);
    expect((await restore(h, "shop", { token: writer })).status).toBe(403);
    for (const role of ["viewer", "developer"]) {
      await signup(h, `${role}@del.test`);
      await addMember(h, T, `${role}@del.test`, role);
      const session = await login(h, `${role}@del.test`, undefined, { tenant_id: T });
      const r = await del(h, "shop", { session });
      expect(r.status).toBe(403);
      expect(JSON.stringify(await r.json())).toContain(role);
      // A user's token holding `*` is capped by the user's role.
      const uid = (await h.db.query<{ id: string }>("select id from users where email = $1", [`${role}@del.test`]))[0]?.id as string;
      const userToken = (await createTenantToken(h.db, T, "cli", ["*"], 30, h.clock.now, uid)).token;
      expect((await del(h, "shop", { token: userToken })).status).toBe(403);
    }
    // Another tenant's app is "not found", never 403.
    const other = await tenant(h, "t_other");
    await createApp_(h, other, "theirs");
    expect((await del(h, "theirs", { token })).status).toBe(404);
    expect((await restore(h, "theirs", { token })).status).toBe(404);
    expect((await h.request("GET", "/v1/apps/theirs", { token: other })).status).toBe(200);
    // A wrong confirm is 400 and changes nothing.
    const wrong = await del(h, "shop", { token }, "notes");
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(await wrong.json())).toContain("confirm");
    expect(await names(h, token)).toEqual(["notes", "shop"]);
    // The admin (a session) deletes; a second delete is 404.
    await signup(h, "admin@del.test");
    await addMember(h, T, "admin@del.test", "admin");
    const admin = await login(h, "admin@del.test", undefined, { tenant_id: T });
    expect((await del(h, "shop", { session: admin })).status).toBe(200);
    expect((await del(h, "shop", { session: admin })).status).toBe(404);
    // A token with exactly the scope apps:delete restores and deletes.
    const deleter = await scopedToken(h, T, ["apps:delete"]);
    expect((await restore(h, "shop", { token: deleter })).status).toBe(200);
    expect((await del(h, "notes", { token: deleter })).status).toBe(200);
  });

  test("409 while a restore or an import involves the app, or the tenant moves", async () => {
    const { h, token } = await setup();
    let answered = 0;
    await holdingApps(h.deps, T, ["shop"], "restore in progress", async () => {
      const r = await del(h, "shop", { token });
      expect(r.status).toBe(409);
      expect(JSON.stringify(await r.json())).toContain("restore in progress");
      answered++;
    });
    await holdingApps(h.deps, T, ["shop"], "import in progress", async () => {
      expect((await del(h, "shop", { token })).status).toBe(409);
      answered++;
    });
    expect(answered).toBe(2);
    await h.db.query("update tenants set moving_since = $2 where id = $1", [T, h.clock.now]);
    expect((await del(h, "shop", { token })).status).toBe(409);
    await h.db.query("update tenants set moving_since = null where id = $1", [T]);
    expect((await del(h, "shop", { token })).status).toBe(200);
    await h.db.query("update tenants set moving_since = $2 where id = $1", [T, h.clock.now]);
    expect((await restore(h, "shop", { token })).status).toBe(409);
    expect(await names(h, token, "?deleted=true")).toEqual(["shop"]);
  });

  test("custom domains: detached at delete time, their Cloudflare custom hostnames deleted first, served no more; a restore does not re-add them", async () => {
    const { h, token, cf } = await setup();
    for (const hostname of ["www.shop.example", "new.shop.example"]) {
      expect((await h.request("POST", "/v1/apps/shop/domains", { token, json: { hostname } })).status).toBe(201);
    }
    cf.setStatus("www.shop.example", "active");
    await tick(h.deps);
    expect(await hostsOf(h, "shop")).toEqual(["shop.renox.app", "www.shop.example"]);
    const ids = ["www.shop.example", "new.shop.example"].map((x) => cf.of(x)?.id as string);
    const before = await currentVersion(h.db);
    expect((await del(h, "shop", { token })).status).toBe(200);
    expect(cf.calls.filter((c) => c.startsWith("delete "))).toEqual(ids.map((id) => `delete ${id}`).sort());
    expect(cf.of("www.shop.example")).toBeUndefined();
    const domains = await h.db.query<{ hostname: string; state: string; cf_hostname_id: string | null }>("select hostname, state, cf_hostname_id from domains where app = 'shop' order by hostname");
    expect(domains).toEqual([
      { hostname: "new.shop.example", state: "released", cf_hostname_id: null },
      { hostname: "www.shop.example", state: "detached", cf_hostname_id: null },
    ]);
    expect((await deltaSince(h.db, before))?.removals.map((r) => r.hostname).sort()).toEqual(["shop.renox.app", "www.shop.example"]);
    expect(await hostsOf(h, "shop")).toEqual([]);
    expect((await restore(h, "shop", { token })).status).toBe(200);
    expect(await hostsOf(h, "shop")).toEqual(["shop.renox.app"]);
    // The domain job does not bring a detached-by-delete hostname back.
    await tick(h.deps);
    expect(await hostsOf(h, "shop")).toEqual(["shop.renox.app"]);
  });

  test("the name stays reserved while the app is deleted: another tenant's createApp is 409 not available", async () => {
    const { h, token } = await setup();
    expect((await del(h, "shop", { token })).status).toBe(200);
    const other = await tenant(h, "t_other");
    const r = await h.request("POST", "/v1/apps", { token: other, json: { name: "shop" } });
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).toContain("not available");
    // The owner cannot create it again either while it is restorable: restore it instead.
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "shop" } })).status).toBe(409);
  });
});

describe("the purge (sweepAppDeletions)", () => {
  test("8 days later: 1 purged, no row of the app remains, an artifact no one else holds is deleted, a shared hash is kept, the name is quarantined; notes keeps working", async () => {
    const { h, token, hashes } = await setup();
    // A secret, a client error group with an event, an export row, and notes holding a copy of shop's hash.
    expect((await h.request("PUT", "/v1/apps/shop/secrets/API_KEY", { token, json: { value: "sk_live_000000" } })).status).toBe(200);
    await h.db.query("insert into client_error_groups (tenant_id, app, fingerprint, kind, message, first_seen, last_seen, count) values ($1, 'shop', '0123456789abcdef', 'error', 'boom', $2, $2, 1)", [T, h.clock.now]);
    await h.db.query(
      "insert into client_error_events (tenant_id, app, fingerprint, ts, client_ts, deployment_hash, message, url, ua, frames) values ($1, 'shop', '0123456789abcdef', $2, $2, $3, 'boom', 'https://shop.renox.app/', 'ua', '[]'::jsonb)",
      [T, h.clock.now, hashes.shop],
    );
    await h.store.put(`exports/${T}/${T}/1.db`, new TextEncoder().encode("SQLite format 3\u0000"));
    await h.db.query("insert into exports (id, tenant_id, app, object_key, sha256, size_bytes, created_at, expires_at) values ('exp_01JBQ40000000000000000DEL1', $1, 'shop', $2, $3, 16, $4, $5)", [T, `exports/${T}/${T}/1.db`, "0".repeat(64), h.clock.now, h.clock.now + DAY]);
    // 0.8 (#671): one export of each other kind.
    await h.store.put(`exports/${T}/${T}/2.files.tar.gz`, new TextEncoder().encode("files"));
    await h.store.put(`exports/${T}/${T}/3.artifact.tar.gz`, new TextEncoder().encode("artifact"));
    await h.db.query("insert into exports (id, tenant_id, app, object_key, sha256, size_bytes, created_at, expires_at, kind) values ('exp_01JBQ40000000000000000DEL2', $1, 'shop', $2, $3, 5, $4, $5, 'files')", [T, `exports/${T}/${T}/2.files.tar.gz`, "0".repeat(64), h.clock.now, h.clock.now + DAY]);
    await h.db.query("insert into exports (id, tenant_id, app, object_key, sha256, size_bytes, created_at, expires_at, kind, hash) values ('exp_01JBQ40000000000000000DEL3', $1, 'shop', $2, $3, 8, $4, $5, 'artifact', $6)", [T, `exports/${T}/${T}/3.artifact.tar.gz`, "0".repeat(64), h.clock.now, h.clock.now + DAY, hashes.shop]);
    // A second deployment of shop whose hash only shop holds, and notes with a copy of shop's active hash.
    const solo = named("shop", (_m, f) => f.set("code/solo.json", new TextEncoder().encode("1")));
    expect((await upload(h, token, "shop", solo)).status).toBe(201);
    const soloHash = contentHash(solo);
    await h.db.query("insert into deployments (tenant_id, app, hash, state, created_at, updated_at, size_bytes, manifest) values ($1, 'notes', $2, 'validated', $3, $3, 1, null)", [T, hashes.shop, h.clock.now]);
    expect(h.store.objects.has(`artifacts/${soloHash}.tar`)).toBe(true);
    expect(h.store.objects.has(`artifacts/${hashes.shop}.tar`)).toBe(true);

    expect((await del(h, "shop", { token })).status).toBe(200);
    // Inside the window nothing is purged.
    h.clock.now += 6 * DAY;
    expect(await sweepAppDeletions(h.deps)).toBe(0);
    h.clock.now += 2 * DAY;
    expect(await sweepAppDeletions(h.deps)).toBe(1);
    for (const table of ["deployments", "route_entries", "domains", "secret_sets", "secrets", "exports", "client_error_groups", "client_error_events", "client_error_deployments", "permissions"]) {
      expect([table, await rows(h, table, "shop")]).toEqual([table, 0]);
    }
    expect(await rows(h, "apps", "shop", "name")).toBe(0);
    expect(h.store.objects.has(`artifacts/${soloHash}.tar`)).toBe(false);
    expect(h.store.objects.has(`artifacts/${hashes.shop}.tar`)).toBe(true);
    expect(h.store.objects.has(`exports/${T}/${T}/1.db`)).toBe(false);
    expect(h.store.objects.has(`exports/${T}/${T}/2.files.tar.gz`)).toBe(false);
    expect(h.store.objects.has(`exports/${T}/${T}/3.artifact.tar.gz`)).toBe(false);
    // The shared file was never dropped: no node call for an app without a database of its own.
    // The name is quarantined: another tenant cannot take it; the tenant that deleted it can.
    expect(await slugState(h.db, "shop", "t_other", h.clock.now)).toBe("quarantined");
    const other = await tenant(h, "t_other");
    expect((await h.request("POST", "/v1/apps", { token: other, json: { name: "shop" } })).status).toBe(409);
    expect(await slugState(h.db, "shop", T, h.clock.now)).toBe("available");
    // notes keeps its routes, its deployment and its secret set; a second sweep has nothing to do.
    expect(await hostsOf(h, "notes")).toEqual(["notes.renox.app"]);
    expect((await h.request("GET", "/v1/apps/notes", { token })).status).toBe(200);
    expect(await sweepAppDeletions(h.deps)).toBe(0);
    // Meters stay for billing; audit rows stay.
    expect((await auditRows(h)).some((r) => r.action === "deleteApp")).toBe(true);
    // One platform line with fields.kind "purge".
    const { logIngest } = await import("../src/ingest/logs.ts");
    const lines = await logIngest(h.deps).store.read(T, "shop", { since: 0 });
    expect(lines.filter((l) => (l.fields as { kind?: string } | null)?.kind === "purge")).toHaveLength(1);
  });

  test("an app with its own database: the node drops that database with purge_replica; a node that is down keeps the app pending until the next tick", async () => {
    const { h, token, drops, nodeUp } = await setup();
    const created = await h.request("POST", "/v1/apps", { token, json: { name: "stage", staging: true } });
    expect(created.status).toBe(201);
    expect((await del(h, "stage", { token })).status).toBe(200);
    expect(drops).toEqual([]);
    h.clock.now += 8 * DAY;
    nodeUp.up = false;
    expect(await sweepAppDeletions(h.deps)).toBe(0);
    expect(await rows(h, "apps", "stage", "name")).toBe(1);
    nodeUp.up = true;
    expect(await sweepAppDeletions(h.deps)).toBe(1);
    expect(drops).toEqual([`DELETE /nodes/node-1/tenants/${T}?database=${T}.stage&purge_replica=true`]);
    expect(await rows(h, "apps", "stage", "name")).toBe(0);
    // The tenant's shared file and its apps are untouched.
    expect(await names(h, token)).toEqual(["notes", "shop"]);
  });

  test("a Cloudflare failure at purge time keeps the app pending; the next tick finishes", async () => {
    const { h, token, cf } = await setup();
    expect((await h.request("POST", "/v1/apps/shop/domains", { token, json: { hostname: "www.shop.example" } })).status).toBe(201);
    cf.failing = true;
    // The delete still stops serving; the custom hostname stays for the purge.
    expect((await del(h, "shop", { token })).status).toBe(200);
    expect((await h.db.query<{ cf_hostname_id: string | null }>("select cf_hostname_id from domains where app = 'shop'"))[0]?.cf_hostname_id).not.toBeNull();
    h.clock.now += 8 * DAY;
    expect(await sweepAppDeletions(h.deps)).toBe(0);
    cf.failing = false;
    expect(await sweepAppDeletions(h.deps)).toBe(1);
    expect(cf.of("www.shop.example")).toBeUndefined();
    expect(await rows(h, "domains", "shop")).toBe(0);
  });
});
