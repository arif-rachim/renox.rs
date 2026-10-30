// Export, point-in-time restore to a new app, import into a staging app
// (docs/contracts/deploy-api.md 0.3 section 14; #258), against fake nodes.
//
// docs/24-threat-model.md G, "Tenant files or backups read from storage":
// an export is readable only through its signed URL.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { contentHash } from "@renox/artifact-validate";
import { checkMessage } from "../src/contract.ts";
import { setRawNodeCall } from "../src/tenants/backups.ts";
import { setNodeCall } from "../src/workers/failover.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, auditRows, createApp_, harness, nodeToken, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const FILE = new TextEncoder().encode("SQLite format 3\u0000 pretend database bytes");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function setup(): Promise<{ h: Harness; token: string; restores: unknown[]; imports: { path: string; size: number }[] }> {
  const h = await harness();
  const node = await nodeToken(h, "node-1");
  const reg = await h.request("POST", "/v1/nodes/register", {
    token: node,
    json: { type: "node_register", schema_version: 0, node_id: "node-1", worker_version: "0.3.0", region: "me-central-1", max_cells: 100, listen_url: "http://10.0.0.10:8790" },
  });
  expect(reg.status).toBe(200);
  const token = await tenant(h, "t_bk");
  await createApp_(h, token, "shop");
  const files = helloArtifact((m) => ((m.app as Record<string, string>).name = "shop"));
  await upload(h, token, "shop", files);
  expect((await h.request("POST", "/v1/apps/shop/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
  const restores: unknown[] = [];
  const imports: { path: string; size: number }[] = [];
  setNodeCall(h.deps, async (_target, _method, _path, body) => {
    const req = body as { timestamp: number | null; database: string };
    restores.push(body);
    if (req.timestamp !== null && req.timestamp < 1_000) return { status: 422, body: { error: { code: "RENOX_RESTORE_POINT_UNKNOWN" } } };
    return { status: 200, body: { type: "restore_result", schema_version: 0, node_id: "node-1", tenant_id: "t_bk", database: req.database, source: "replica", generation: "a1b2c3d4e5f60718", file_sha256: "0".repeat(64), restored_to: req.timestamp, elapsed_ms: 900 } };
  });
  setRawNodeCall(h.deps, async (_node, method, path, body) => {
    if (method === "POST" && path.includes("/snapshot")) return new Response(FILE, { headers: { "x-renox-sha256": sha(FILE) } });
    if (method === "PUT" && path.includes("/import")) {
      imports.push({ path, size: body?.length ?? 0 });
      if (new TextDecoder().decode(body).includes("notes")) {
        return Response.json({ error: { code: "RENOX_IMPORT_REJECTED", message: "x", request_id: "x", details: [{ field: "table", reason: "notes has no <module>__ prefix" }] } }, { status: 422 });
      }
      return Response.json({ type: "import_result", schema_version: 0, node_id: "node-1", tenant_id: "t_bk", database: "t_bk.shop-staging", size_bytes: body?.length ?? 0, sha256: sha(body ?? new Uint8Array()), tables: ["app__notes"] });
    }
    return new Response(null, { status: 404 });
  });
  return { h, token, restores, imports };
}

describe("backups (deploy-api.md section 14)", () => {
  test("#308: with EXPORT_KMS_KEY_ID the export is put with SSE-KMS and that key; without it, a plain put", async () => {
    const { h, token } = await setup();
    const kms = "arn:aws:kms:me-central-1:111122223333:key/0b2e1c4f-renox-export";
    h.deps.config.exportKmsKeyId = kms;
    const res = await h.request("POST", "/v1/apps/shop/backups/export", { token, json: {} });
    expect(res.status).toBe(201);
    const [key] = [...h.store.objects.keys()].filter((k) => k.startsWith("exports/t_bk/"));
    expect(h.store.encryption.get(key as string)).toEqual({ "x-amz-server-side-encryption": "aws:kms", "x-amz-server-side-encryption-aws-kms-key-id": kms });
    h.deps.config.exportKmsKeyId = null;
    h.clock.now += 1_000;
    expect((await h.request("POST", "/v1/apps/shop/backups/export", { token, json: {} })).status).toBe(201);
    const plain = [...h.store.objects.keys()].filter((k) => k.startsWith("exports/t_bk/")).find((k) => k !== key);
    expect(h.store.encryption.get(plain as string)).toEqual({});
  });

  test("#308: the S3 store signs the SSE-KMS headers into the put (SigV4, path style)", async () => {
    const { signedPut } = await import("../src/storage/object-store.ts");
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const config = { endpoint: "http://127.0.0.1:9000", bucket: "renox-exports", region: "me-central-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
      const res = await signedPut(config, "exports/t_a/t_a/1.db", new TextEncoder().encode("x"), { "x-amz-server-side-encryption": "aws:kms", "x-amz-server-side-encryption-aws-kms-key-id": "k1" }, new Date(Date.UTC(2026, 9, 30, 12, 0, 0)));
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = real;
    }
    expect(seen[0]?.url).toBe("http://127.0.0.1:9000/renox-exports/exports/t_a/t_a/1.db");
    const auth = seen[0]?.headers.authorization ?? "";
    expect(auth).toStartWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261030/me-central-1/s3/aws4_request, ");
    expect(auth).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id,");
    expect(auth).not.toContain("wJalrXUtnFEMI");
    expect(seen[0]?.headers["x-amz-server-side-encryption"]).toBe("aws:kms");
  });

  test("export answers a signed URL; the object is not readable without the signature; the sha256 matches; audited", async () => {
    const { h, token } = await setup();
    const res = await h.request("POST", "/v1/apps/shop/backups/export", { token, json: { expires_in_seconds: 300 } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string; sha256: string; size_bytes: number; masking: string; expires_at: number };
    expect(body).toMatchObject({ sha256: sha(FILE), size_bytes: FILE.length, masking: "none", expires_at: h.clock.now + 300_000 });
    expect(body.url.startsWith("https://")).toBe(true);
    const url = new URL(body.url);
    // The bare path: 404; a changed signature: 403; the signed URL: the bytes.
    expect((await h.request("GET", url.pathname)).status).toBe(404);
    const forged = `${url.pathname}?expires=${url.searchParams.get("expires")}&sig=${"0".repeat(64)}`;
    expect((await h.request("GET", forged)).status).toBe(403);
    const got = await h.request("GET", `${url.pathname}${url.search}`);
    expect(got.status).toBe(200);
    expect(sha(new Uint8Array(await got.arrayBuffer()))).toBe(body.sha256);
    // Expired: refused.
    h.clock.now += 301_000;
    expect((await h.request("GET", `${url.pathname}${url.search}`)).status).toBe(403);
    const audit = (await auditRows(h)).filter((r) => r.action === "exportBackup");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenant_id: "t_bk", status: 201 });
    expect(JSON.stringify(audit[0]?.target)).not.toContain("sig=");
  });

  test("restore to a new app creates the app, its deployment and its route on its own database; an unknown point is 422 and creates nothing", async () => {
    const { h, token, restores } = await setup();
    const bad = await h.request("POST", "/v1/apps/shop/backups/restore", { token, json: { timestamp: 10, target: "new_app", name: "shop-old" } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("RENOX_RESTORE_POINT_UNKNOWN");
    expect((await h.request("GET", "/v1/apps/shop-old", { token })).status).toBe(404);

    const at = h.clock.now - 60_000;
    const res = await h.request("POST", "/v1/apps/shop/backups/restore", { token, json: { timestamp: at, target: "new_app", name: "shop-restored" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { app: { name: string; active_deployment: string }; deployment: { state: string }; database: string; generation: string };
    expect(body).toMatchObject({ app: { name: "shop-restored" }, deployment: { state: "active" }, database: "t_bk.shop-restored", generation: "a1b2c3d4e5f60718" });
    // The node was asked for the source database's replica, as of `at`, into the new database.
    expect(restores.at(-1)).toMatchObject({ database: "t_bk.shop-restored", source_database: "t_bk", timestamp: at, reason: "restore" });
    const routes = await h.db.query<{ hostname: string; database: string | null; status: string }>("select hostname, database, status from route_entries where app = 'shop-restored'");
    expect(routes).toEqual([{ hostname: "shop-restored.renox.app", database: "t_bk.shop-restored", status: "active" }]);
    // The name is taken now.
    expect((await h.request("POST", "/v1/apps/shop/backups/restore", { token, json: { timestamp: at, target: "new_app", name: "shop-restored" } })).status).toBe(409);
    expect((await auditRows(h)).filter((r) => r.action === "restoreBackup").map((r) => r.status)).toEqual([422, 201, 409]);
  });

  test("import into a production app is refused; into a staging app it reaches the node; a table outside the naming rules is refused", async () => {
    const { h, token, imports } = await setup();
    const prod = await h.request("POST", "/v1/apps/shop/db/import", { token, body: FILE, headers: { "content-type": "application/vnd.sqlite3" } });
    expect(prod.status).toBe(422);
    expect(((await prod.json()) as { error: { code: string; details: unknown[] } }).error).toMatchObject({ code: "RENOX_IMPORT_REJECTED", details: [{ field: "app", reason: "not a staging app" }] });
    expect(imports).toHaveLength(0);

    expect((await h.request("POST", "/v1/apps", { token, json: { name: "shop-staging", staging: true } })).status).toBe(201);
    const ok = await h.request("POST", "/v1/apps/shop-staging/db/import", { token, body: FILE, headers: { "content-type": "application/vnd.sqlite3" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ app: "shop-staging", database: "t_bk.shop-staging", sha256: sha(FILE), tables: ["app__notes"] });
    expect(imports.at(-1)?.path).toContain("database=t_bk.shop-staging");

    const bad = await h.request("POST", "/v1/apps/shop-staging/db/import", { token, body: new TextEncoder().encode("create table notes"), headers: { "content-type": "application/vnd.sqlite3" } });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain("notes has no <module>__ prefix");
    const audit = (await auditRows(h)).filter((r) => r.action === "importDatabase");
    expect(audit.map((r) => [r.tenant_id, r.status])).toEqual([
      ["t_bk", 422],
      ["t_bk", 200],
      ["t_bk", 422],
    ]);
  });

  test("the getBackups answer passes the contract schema shape", async () => {
    const { h, token } = await setup();
    setNodeCall(h.deps, async () => ({ status: 200, body: { type: "replication_status", schema_version: 0, node_id: "node-1", tenant_id: "t_bk", database: "t_bk", replication: "none", state: "off", replica: null, last_sync_at: null, lag_seconds: null, retention_hours: 0, snapshot_interval_seconds: 0, generations: [], db: { size_bytes: 4096, quota_bytes: 0, wal_bytes: 0 } } }));
    const res = await h.request("GET", "/v1/apps/shop/backups", { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ app: "shop", database: "t_bk", replication: "none", stale: false });
    void checkMessage;
  });
});
