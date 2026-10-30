// The module registry (#324; deploy-api.md 0.5 section 19): publish a
// signed version, a bad signature or a revoked key refused, versions
// immutable, the upgrade diff, disable by hash with the owners told, the
// install record, and other tenants' publishers not reachable (IDOR).
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { contentHash, writeTar } from "@renox/artifact-validate";

import { assertScoped, createApp_, harness, OPERATOR_TOKEN, scopedToken, tenant, type Harness } from "./helpers.ts";

afterEach(assertScoped);

const enc = new TextEncoder();

function keyPair(): { key: KeyObject; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { key: privateKey, pub: (publicKey.export({ format: "jwk" }) as { x: string }).x };
}

/** A module tree as a tar, signed by `key` (manifest.md 1.2 section 5). */
function tree(version: string, key: KeyObject, pub: string, opts: { network?: string[]; tamper?: boolean; migrations?: string[] } = {}): Uint8Array<ArrayBuffer> {
  const files = new Map<string, Uint8Array>([
    ["module.toml", enc.encode(`[module]\nname = "tax_gcc"\nversion = "${version}"\nisolation = "isolate"\ndescription = "UAE VAT invoices"\nprice = { amount = "49.00", currency = "AED", period = "month" }\n\n[publisher]\nname = "gulfsoft"\nkey_id = "ed25519:${pub}"\n\n[permissions]\ntables = "tax_gcc__*"\nnetwork = ${JSON.stringify(opts.network ?? [])}\n`)],
    ["services.ts", enc.encode("export function rate() { return 5; }\n")],
    ["pages/invoice.html", enc.encode("<h1>Invoice</h1>\n")],
  ]);
  for (const m of opts.migrations ?? ["001_lines.sql"]) files.set(`migrations/${m}`, enc.encode("create table tax_gcc__lines (id text);\n"));
  const hash = contentHash(files);
  const signature = sign(null, enc.encode(`renox-module-v1\ngulfsoft/tax_gcc@${version}\n${hash}\n`), key).toString("base64url");
  if (opts.tamper) files.set("services.ts", enc.encode("export function rate() { return 0; }\n"));
  files.set("module.sig", enc.encode(JSON.stringify({ version: 1, publisher: "gulfsoft", key_id: `ed25519:${pub}`, name: "tax_gcc", module_version: version, hash, signature })));
  return writeTar(files);
}

async function publisherSetup(h: Harness) {
  const owner = await tenant(h, "t_gulf");
  const { key, pub } = keyPair();
  const created = await h.request("POST", "/v1/publishers", { token: owner, json: { name: "gulfsoft", public_key: pub } });
  expect(created.status).toBe(201);
  return { owner, key, pub, publisher: (await created.json()) as { keys: { key_id: string }[] } };
}

const put = (h: Harness, token: string, version: string, body: Uint8Array<ArrayBuffer>) =>
  h.request("PUT", `/v1/registry/gulfsoft/tax_gcc/${version}`, { token, body, headers: { "content-type": "application/x-tar" } });

describe("registry (section 19)", () => {
  test("publish a signed version once; a tampered tree, an unknown or revoked key refused", async () => {
    const h = await harness();
    const { owner, key, pub } = await publisherSetup(h);
    const ok = await put(h, owner, "2.0.0", tree("2.0.0", key, pub));
    expect(ok.status).toBe(201);
    const v = (await ok.json()) as Record<string, unknown>;
    expect(v).toMatchObject({ publisher: "gulfsoft", name: "tax_gcc", version: "2.0.0", isolation: "isolate", migrations: 1, disabled: null, price: { amount: "49.00", currency: "AED", period: "month" } });
    expect(v.permissions).toEqual({ tables: "tax_gcc__*", network: [], secrets: [], slots: [], hooks: [] });
    // Immutable.
    expect((await put(h, owner, "2.0.0", tree("2.0.0", key, pub))).status).toBe(409);
    // A tree that is not the signed one.
    const tampered = await put(h, owner, "2.0.1", tree("2.0.1", key, pub, { tamper: true }));
    expect(tampered.status).toBe(422);
    expect(JSON.stringify(await tampered.json())).toContain("MF15");
    // A key the publisher does not have.
    const stranger = keyPair();
    expect((await put(h, owner, "2.0.2", tree("2.0.2", stranger.key, stranger.pub))).status).toBe(422);
    // Rotate: the old key revoked, a version signed with it refused.
    const next = keyPair();
    const rotated = await h.request("POST", "/v1/publishers/gulfsoft/keys", { token: owner, json: { public_key: next.pub, revoke: [`ed25519:${pub}`] } });
    expect(rotated.status).toBe(200);
    expect(((await rotated.json()) as { keys: { revoked_at: number | null }[] }).keys.filter((k) => k.revoked_at !== null)).toHaveLength(1);
    expect((await put(h, owner, "2.0.3", tree("2.0.3", key, pub))).status).toBe(422);
    expect((await put(h, owner, "2.0.3", tree("2.0.3", next.key, next.pub))).status).toBe(201);
  });

  test("another tenant reaches neither the publisher's keys nor its uploads (IDOR: 404)", async () => {
    const h = await harness();
    const { key, pub } = await publisherSetup(h);
    const other = await tenant(h, "t_other");
    expect((await h.request("POST", "/v1/publishers/gulfsoft/keys", { token: other, json: { public_key: keyPair().pub } })).status).toBe(404);
    expect((await put(h, other, "9.0.0", tree("9.0.0", key, pub))).status).toBe(404);
    expect((await h.request("POST", "/v1/publishers", { token: other, json: { name: "gulfsoft", public_key: keyPair().pub } })).status).toBe(409);
    expect((await h.request("POST", "/v1/publishers", { token: other, json: { name: "renox", public_key: keyPair().pub } })).status).toBe(409);
    // registry:read without registry:publish cannot publish.
    const reader = await scopedToken(h, "t_other", ["registry:read"]);
    expect((await h.request("POST", "/v1/publishers", { token: reader, json: { name: "readers", public_key: keyPair().pub } })).status).toBe(403);
  });

  test("list, get, the tree, and the diff of an upgrade", async () => {
    const h = await harness();
    const { owner, key, pub } = await publisherSetup(h);
    await put(h, owner, "2.0.0", tree("2.0.0", key, pub));
    await put(h, owner, "2.1.0", tree("2.1.0", key, pub, { network: ["api.zatca.gov.sa"], migrations: ["001_lines.sql", "002_zatca.sql"] }));
    const reader = await tenant(h, "t_shop");
    const list = (await (await h.request("GET", "/v1/registry?q=vat", { token: reader })).json()) as { items: { version: string }[] };
    expect(list.items.map((i) => i.version)).toEqual(["2.1.0"]);
    const got = await h.request("GET", "/v1/registry/gulfsoft/tax_gcc/2.0.0", { token: reader });
    expect(got.status).toBe(200);
    const t = await h.request("GET", "/v1/registry/gulfsoft/tax_gcc/2.0.0/tree", { token: reader });
    expect(t.headers.get("content-type")).toBe("application/x-tar");
    expect((await t.arrayBuffer()).byteLength).toBeGreaterThan(512);
    const diff = (await (await h.request("GET", "/v1/registry/gulfsoft/tax_gcc/diff?from=2.0.0&to=2.1.0", { token: reader })).json()) as Record<string, any>;
    expect(diff.permissions.added.network).toEqual(["api.zatca.gov.sa"]);
    expect(diff.permissions.removed.network).toEqual([]);
    expect(diff.migrations).toEqual(["002_zatca.sql"]);
  });

  test("install records the approval; disable by hash refuses downloads, marks installs and emails owners", async () => {
    const h = await harness();
    const { owner, key, pub } = await publisherSetup(h);
    const v = (await (await put(h, owner, "2.0.0", tree("2.0.0", key, pub))).json()) as { hash: string; permissions: unknown };
    const shop = await tenant(h, "t_shop");
    await createApp_(h, shop, "shop");
    await h.db.query("insert into users (id, email, password_hash, created_at) values ('usr_0000000000000000SH', 'owner@shop.ae', 'x', 0)");
    await h.db.query("insert into memberships (tenant_id, user_id, role, created_at) values ('t_shop', 'usr_0000000000000000SH', 'owner', 0)");
    const wrong = await h.request("POST", "/v1/apps/shop/modules", { token: shop, json: { source: "registry:gulfsoft/tax_gcc", version: "2.0.0", hash: v.hash, approved: { network: ["evil.example"], secrets: [], slots: [], hooks: [] } } });
    expect(wrong.status).toBe(409);
    const ok = await h.request("POST", "/v1/apps/shop/modules", { token: shop, json: { source: "registry:gulfsoft/tax_gcc", version: "2.0.0", hash: v.hash, approved: v.permissions } });
    expect(ok.status).toBe(201);
    expect((await h.request("GET", "/v1/apps/shop/modules", { token: await tenant(h, "t_x") })).status).toBe(404);
    // Operator disable.
    const tenantToken = await h.request("POST", "/v1/registry/disable", { token: shop, json: { hash: v.hash, reason: "exfiltrates TRNs to a third party" } });
    // A tenant token on an operator endpoint (opsAuth answers 403, as for the other ops endpoints).
    expect(tenantToken.status).toBe(403);
    const disabled = await h.request("POST", "/v1/registry/disable", { token: OPERATOR_TOKEN, json: { hash: v.hash, reason: "exfiltrates TRNs to a third party" } });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ hash: v.hash, tenants_notified: 1 });
    expect(h.mailer.last("owner@shop.ae", "module_disabled")?.text).toContain("exfiltrates TRNs");
    expect((await h.request("GET", "/v1/registry/gulfsoft/tax_gcc/2.0.0/tree", { token: shop })).status).toBe(409);
    const mods = (await (await h.request("GET", "/v1/apps/shop/modules", { token: shop })).json()) as { items: { disabled: unknown }[] };
    expect(mods.items[0]?.disabled).toMatchObject({ reason: "exfiltrates TRNs to a third party" });
    const audit = await h.db.query<{ action: string }>("select action from audit where action in ('publishModuleVersion', 'installModule', 'disableModuleVersion') order by at");
    expect(audit.map((a) => a.action).sort()).toEqual(["disableModuleVersion", "disableModuleVersion", "installModule", "installModule", "publishModuleVersion"]);
  });
});
