// Secrets (docs/contracts/deploy-api.md section 9; docs/04-isolation-
// security.md "Secrets"; docs/24-threat-model.md B "Secrets in logs, errors,
// bundle, responses" and rule 5: no secret value leaves the process that
// needs it).

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash } from "@renox/artifact-validate";
import { checkMessage } from "../src/contract.ts";
import { decryptValue, encryptValue, EnvMasterKey, MasterKeyError, valueAad } from "../src/secrets/crypto.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, auditRows, createApp_, harness, registeredNode, scopedToken, sseReader, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const STRIPE = "sk_test_51NzQe2SecretValueStripe";
const ROTATED = "sk_test_51NzQe2RotatedValueStripe";
const OTHER = "undeclared-secret-value-xyz";

/** Every response body of a test, to grep for plaintext afterwards. */
async function recorded(h: Harness): Promise<{ texts: string[]; req: Harness["request"] }> {
  const texts: string[] = [];
  const req: Harness["request"] = async (method, path, init) => {
    const res = await h.request(method, path, init);
    const text = await res.clone().text();
    texts.push(text);
    return res;
  };
  return { texts, req };
}

const put = (req: Harness["request"], token: string, name: string, value: unknown) => req("PUT", `/v1/apps/hello/secrets/${name}`, { token, json: { value } });

describe("secrets API", () => {
  test("PUT creates versions; list returns names only; values never appear in logs, audit, or responses", async () => {
    const h = await harness();
    const token = await tenant(h, "t_hello");
    await createApp_(h, token, "hello");
    const { texts, req } = await recorded(h);
    const r1 = await put(req, token, "STRIPE_KEY", STRIPE);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ name: "STRIPE_KEY", version: 1 });
    expect(await (await put(req, token, "OTHER_KEY", OTHER)).json()).toEqual({ name: "OTHER_KEY", version: 2 });
    const list = await req("GET", "/v1/apps/hello/secrets", { token });
    const body = (await list.json()) as { version: number; secrets: { name: string }[] };
    expect(body.version).toBe(2);
    expect(body.secrets.map((s) => s.name)).toEqual(["OTHER_KEY", "STRIPE_KEY"]);

    const everything = [
      ...texts,
      ...h.log.lines,
      JSON.stringify(await auditRows(h)),
      JSON.stringify(await h.db.query("select tenant_id, app, name, version_from, version_to, encode(ciphertext, 'escape') as c from secrets")),
    ].join("\n");
    for (const value of [STRIPE, OTHER]) expect(everything).not.toContain(value);
    const keys = await h.db.query<{ master_key_id: string }>("select master_key_id from tenant_keys");
    expect(keys).toEqual([{ master_key_id: "env-1" }]);
  });

  test("value and name rules", async () => {
    const h = await harness();
    const token = await tenant(h, "t_hello");
    await createApp_(h, token, "hello");
    const code = async (res: Promise<Response>) => {
      const r = await res;
      return [r.status, ((await r.json()) as { error?: { code: string } }).error?.code];
    };
    expect(await code(put(h.request, token, "PIN", "1234"))).toEqual([400, "RENOX_VALIDATION"]);
    expect(await code(put(h.request, token, "PIN", "1234567"))).toEqual([400, "RENOX_VALIDATION"]);
    expect((await put(h.request, token, "PIN", "12345678")).status).toBe(200);
    expect(await code(put(h.request, token, "BIG", "é".repeat(40_000)))).toEqual([400, "RENOX_VALIDATION"]);
    expect(await code(put(h.request, token, "lower_case", "12345678"))).toEqual([400, "RENOX_VALIDATION"]);
    expect(await code(h.request("PUT", "/v1/apps/hello/secrets/X", { token, json: { value: "12345678", echo: true } }))).toEqual([400, "RENOX_VALIDATION"]);
    for (let i = 1; i < 100; i++) expect((await put(h.request, token, `K${i}`, "12345678")).status).toBe(200);
    expect(await code(put(h.request, token, "K100", "12345678"))).toEqual([400, "RENOX_VALIDATION"]);
    expect((await put(h.request, token, "K1", "87654321")).status).toBe(200);
  });

  test("delete creates a version; unknown names are 404; scopes and tenants are enforced", async () => {
    const h = await harness();
    const token = await tenant(h, "t_hello");
    await createApp_(h, token, "hello");
    await put(h.request, token, "STRIPE_KEY", STRIPE);
    const del = await h.request("DELETE", "/v1/apps/hello/secrets/STRIPE_KEY", { token });
    expect(await del.json()).toEqual({ name: "STRIPE_KEY", version: 2 });
    expect((await h.request("DELETE", "/v1/apps/hello/secrets/STRIPE_KEY", { token })).status).toBe(404);
    const reader = await scopedToken(h, "t_hello", ["secrets:read"]);
    expect((await h.request("GET", "/v1/apps/hello/secrets", { token: reader })).status).toBe(200);
    expect((await put(h.request, reader, "X_KEY", "12345678")).status).toBe(403);
    const other = await tenant(h, "t_other");
    expect((await h.request("GET", "/v1/apps/hello/secrets", { token: other })).status).toBe(404);
    expect((await put(h.request, other, "X_KEY", "12345678")).status).toBe(404);
  });

  test("without a master key the secret endpoints answer 503", async () => {
    const h = await harness();
    h.deps.config.masterKey = null;
    const token = await tenant(h, "t_hello");
    await createApp_(h, token, "hello");
    expect((await put(h.request, token, "STRIPE_KEY", STRIPE)).status).toBe(503);
  });
});

describe("rotation, pinning, and delivery to the node", () => {
  async function live(): Promise<{ h: Harness; token: string; node: string; hash: string }> {
    const h = await harness();
    const token = await tenant(h, "t_hello");
    await createApp_(h, token, "hello");
    const node = await registeredNode(h, "node-1");
    await put(h.request, token, "STRIPE_KEY", STRIPE);
    await put(h.request, token, "OTHER_KEY", OTHER);
    const files = helloArtifact((m) => {
      m.permissions = { network: [], secrets: ["STRIPE_KEY", "MISSING_KEY"] };
    });
    await upload(h, token, "hello", files);
    const hash = contentHash(files);
    const res = await h.request("POST", "/v1/apps/hello/activate", { token, json: { hash } });
    expect(((await res.json()) as { secrets_version: number }).secrets_version).toBe(2);
    return { h, token, node, hash };
  }
  const bundle = (h: Harness, node: string, hash: string, version: number, nodeId = "node-1") =>
    h.request("GET", `/v1/nodes/${nodeId}/secrets/hello/${hash}?version=${version}`, { token: node });

  test("the owning node gets the pinned version, filtered to declared names, not cached", async () => {
    const { h, node, hash } = await live();
    const res = await bundle(h, node, hash, 2);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const b = checkMessage<{ secrets: Record<string, string> }>("secrets_bundle", await res.json());
    expect(b.secrets).toEqual({ STRIPE_KEY: STRIPE });
    expect(h.log.lines.join("\n")).not.toContain(STRIPE);
  });

  test("rotation keeps the active deployment on its version until bump; bump publishes the new version", async () => {
    const { h, token, node, hash } = await live();
    expect(((await (await put(h.request, token, "STRIPE_KEY", ROTATED)).json()) as { version: number }).version).toBe(3);
    const d = (await (await h.request("GET", `/v1/apps/hello/deployments/${hash}`, { token })).json()) as { secrets_version: number };
    expect(d.secrets_version).toBe(2);
    expect(((await (await bundle(h, node, hash, 2)).json()) as { secrets: Record<string, string> }).secrets.STRIPE_KEY).toBe(STRIPE);
    expect((await bundle(h, node, hash, 3)).status).toBe(404);

    const stream = sseReader(await h.request("GET", "/v1/nodes/node-1/stream", { token: node }));
    await stream.next();
    const bumped = await h.request("POST", "/v1/apps/hello/secrets/bump", { token });
    expect(((await bumped.json()) as { secrets_version: number }).secrets_version).toBe(3);
    const delta = checkMessage<{ upserts: { secrets_version: number; status: string }[] }>("route_delta", (await stream.next()).data);
    expect(delta.upserts.map((u) => [u.status, u.secrets_version])).toEqual([["active", 3]]);
    expect(((await (await bundle(h, node, hash, 3)).json()) as { secrets: Record<string, string> }).secrets.STRIPE_KEY).toBe(ROTATED);
    expect((await bundle(h, node, hash, 2)).status).toBe(404);
    await stream.close();
  });

  test("a deleted secret is gone from the next version but stays in the pinned one", async () => {
    const { h, token, node, hash } = await live();
    await h.request("DELETE", "/v1/apps/hello/secrets/STRIPE_KEY", { token });
    expect(((await (await bundle(h, node, hash, 2)).json()) as { secrets: Record<string, string> }).secrets).toEqual({ STRIPE_KEY: STRIPE });
    await h.request("POST", "/v1/apps/hello/secrets/bump", { token });
    expect(((await (await bundle(h, node, hash, 3)).json()) as { secrets: Record<string, string> }).secrets).toEqual({});
  });

  test("only the assigned node, only active deployments, only node tokens", async () => {
    const { h, token, node, hash } = await live();
    const other = await registeredNode(h, "node-2");
    const owner = (await h.db.query<{ node_id: string }>("select node_id from route_entries"))[0]?.node_id;
    // Registration of node-2 may have moved the tenant; the non-owner is refused.
    const [ownerToken, notOwner, notOwnerToken] = owner === "node-1" ? [node, "node-2", other] : [other, "node-1", node];
    expect((await bundle(h, ownerToken, hash, 2, owner)).status).toBe(200);
    expect((await bundle(h, notOwnerToken, hash, 2, notOwner)).status).toBe(404);
    expect((await bundle(h, token, hash, 2, owner)).status).toBe(401);
    expect((await bundle(h, ownerToken, "0".repeat(64), 2, owner)).status).toBe(404);
  });
});

describe("crypto", () => {
  test("a ciphertext is bound to its tenant, app, name and version", () => {
    const dek = new Uint8Array(32).fill(3);
    const aad = valueAad("t_a", "hello", "STRIPE_KEY", 1);
    const { ciphertext, nonce } = encryptValue(dek, STRIPE, aad);
    expect(decryptValue(dek, ciphertext, nonce, aad)).toBe(STRIPE);
    expect(() => decryptValue(dek, ciphertext, nonce, valueAad("t_a", "hello", "OTHER_KEY", 1))).toThrow();
    expect(() => decryptValue(dek, ciphertext, nonce, valueAad("t_b", "hello", "STRIPE_KEY", 1))).toThrow();
    expect(Buffer.from(ciphertext).toString("latin1")).not.toContain("sk_test");
  });

  test("the master key wraps data keys per tenant and must be 32 bytes", async () => {
    const keys = new EnvMasterKey(Buffer.alloc(32, 9).toString("base64"));
    const dek = new Uint8Array(32).fill(5);
    const { wrapped, nonce } = await keys.wrap(dek, "t_a");
    expect(await keys.unwrap(wrapped, nonce, "t_a")).toEqual(dek);
    await expect(keys.unwrap(wrapped, nonce, "t_b")).rejects.toThrow();
    expect(() => new EnvMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(MasterKeyError);
  });
});
