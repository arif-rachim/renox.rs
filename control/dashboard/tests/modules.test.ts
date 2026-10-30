// The Modules page (#324; docs/19-platform-wireframes.md 3.7) and the
// operator's registry moderation page against the real control API (in
// process): the registry cards and search, the permission review before an
// install, the approval of exactly the reviewed tree, the upgrade review with
// its four sections, and a disable by hash that reaches the owner's banner.
//
// docs/24-threat-model.md section D, "Marketplace module unsigned or
// permission diff on upgrade"; docs/23-failure-modes.md row "Marketplace
// module unsigned or permission diff on upgrade".
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { contentHash, writeTar } from "@renox/artifact-validate";

import { assertScoped, createApp_, OPERATOR_TOKEN, tenant } from "../../api/tests/helpers.ts";
import { actions, load, permissionLines } from "../pages/apps/[app]/modules/index.ts";
import { actions as opsActions, load as opsLoad } from "../pages/ops/registry/index.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, dash, devWithData, loaderCtx, SECRETS, type Dash } from "./helpers.ts";

setDefaultTimeout(60_000);
const worker = process.env.RENOX_WORKER_PATH;
afterEach(assertScoped);

const enc = new TextEncoder();
const P = { app: "shop" };
type Data = Record<string, any>;
const data = (v: unknown): Data => {
  expect(v).not.toBeInstanceOf(Response);
  return v as Data;
};

/** A signed module tree (manifest.md 1.2 section 5), as control/api/tests/registry.test.ts builds it. */
function tree(version: string, key: KeyObject, pub: string, opts: { network?: string[]; migrations?: string[]; page?: string } = {}): Uint8Array<ArrayBuffer> {
  const files = new Map<string, Uint8Array>([
    ["module.toml", enc.encode(`[module]\nname = "tax_gcc"\nversion = "${version}"\nisolation = "isolate"\ndescription = "UAE VAT invoices"\nprice = { amount = "49.00", currency = "AED", period = "month" }\n\n[publisher]\nname = "gulfsoft"\nkey_id = "ed25519:${pub}"\n\n[permissions]\ntables = "tax_gcc__*"\nnetwork = ${JSON.stringify(opts.network ?? [])}\n`)],
    ["services.ts", enc.encode("export function rate() { return 5; }\n")],
    ["pages/invoice.html", enc.encode(opts.page ?? "<h1>Invoice</h1>\n")],
  ]);
  for (const m of opts.migrations ?? ["001_lines.sql"]) files.set(`migrations/${m}`, enc.encode("create table tax_gcc__lines (id text);\n"));
  const hash = contentHash(files);
  const signature = sign(null, enc.encode(`renox-module-v1\ngulfsoft/tax_gcc@${version}\n${hash}\n`), key).toString("base64url");
  files.set("module.sig", enc.encode(JSON.stringify({ version: 1, publisher: "gulfsoft", key_id: `ed25519:${pub}`, name: "tax_gcc", module_version: version, hash, signature })));
  return writeTar(files);
}

async function setup(secrets: Readonly<Record<string, string>> = SECRETS): Promise<{ d: Dash; publish: (v: string, o?: Parameters<typeof tree>[3]) => Promise<{ hash: string }> }> {
  const d = await dash({ secrets });
  const publisher = await tenant(d.h, "t_gulf");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  expect((await d.h.request("POST", "/v1/publishers", { token: publisher, json: { name: "gulfsoft", public_key: pub } })).status).toBe(201);
  const publish = async (v: string, o: Parameters<typeof tree>[3] = {}) => {
    const r = await d.h.request("PUT", `/v1/registry/gulfsoft/tax_gcc/${v}`, { token: publisher, body: tree(v, privateKey, pub, o), headers: { "content-type": "application/x-tar" } });
    expect(r.status).toBe(201);
    return (await r.json()) as { hash: string };
  };
  const owner = await tenant(d.h, "t_shop");
  await createApp_(d.h, owner, "shop");
  await d.h.db.query("insert into users (id, email, password_hash, created_at) values ('usr_0000000000000000SH', 'owner@shop.ae', 'x', 0)");
  await d.h.db.query("insert into memberships (tenant_id, user_id, role, created_at) values ('t_shop', 'usr_0000000000000000SH', 'owner', 0)");
  expect(await signinActions.default(actionCtx(d, "/signin", "default", { token: owner, next: "/apps" }))).toBeInstanceOf(Response);
  return { d, publish };
}

const form = (v: string, hash?: string) => ({ publisher: "gulfsoft", name: "tax_gcc", version: v, ...(hash === undefined ? {} : { hash }) });

describe("Modules page (3.7)", () => {
  test("registry cards and search; the permission review before an install; approve exactly the reviewed tree", async () => {
    const { d, publish } = await setup();
    const v1 = await publish("2.0.0");
    const page = data(await load(loaderCtx(d, "/apps/shop/modules", { params: P })));
    expect(page.installed).toEqual([]);
    expect(page.disabled).toBeNull();
    expect(page.cards).toEqual([{ publisher: "gulfsoft", name: "tax_gcc", version: "2.0.0", description: "UAE VAT invoices", isolation: "isolate", price: "49.00 AED / month", signed: expect.stringMatching(/^ed25519:/u) }]);
    expect(data(await load(loaderCtx(d, "/apps/shop/modules?q=nothing-like-it", { params: P }))).cards).toEqual([]);
    // The review lists what the version asks for; nothing is written yet.
    const review = data(await actions.review(actionCtx(d, "/apps/shop/modules", "review", form("2.0.0"), { params: P })));
    expect(review.review).toMatchObject({ from: null, hash: v1.hash, asks: ["tables tax_gcc__*"], migration_count: 1, price: "49.00 AED / month" });
    expect(data(await load(loaderCtx(d, "/apps/shop/modules", { params: P }))).installed).toEqual([]);
    // A hash that is not the reviewed version's is refused before the API.
    const before = d.calls.sent.filter((c) => c.method === "POST" && c.url.endsWith("/modules")).length;
    const wrong = data(await actions.install(actionCtx(d, "/apps/shop/modules", "install", form("2.0.0", "0".repeat(64)), { params: P })));
    expect(wrong.form_error).toContain("not the one you reviewed");
    expect(d.calls.sent.filter((c) => c.method === "POST" && c.url.endsWith("/modules")).length).toBe(before);
    // The reviewed hash installs, with the version's own request as the approval.
    const ok = data(await actions.install(actionCtx(d, "/apps/shop/modules", "install", form("2.0.0", v1.hash), { params: P })));
    expect(ok.action_problem).toBeNull();
    expect(ok.notice).toContain("registry:gulfsoft/tax_gcc");
    const sent = d.calls.sent.filter((c) => c.method === "POST" && c.url.endsWith("/v1/apps/shop/modules"));
    expect(JSON.parse(sent.at(-1)?.body ?? "{}")).toMatchObject({ source: "registry:gulfsoft/tax_gcc", version: "2.0.0", hash: v1.hash, approved: { tables: "tax_gcc__*", network: [] } });
    const after = data(await load(loaderCtx(d, "/apps/shop/modules", { params: P })));
    expect(after.installed).toMatchObject([{ name: "tax_gcc", version: "2.0.0", status: "up to date", upgrade: null, approved: ["tables tax_gcc__*"] }]);
  });

  test("an upgrade shows the four sections: a new network host, the new migration, the contract, the changed template", async () => {
    const { d, publish } = await setup();
    const v1 = await publish("2.0.0");
    data(await actions.install(actionCtx(d, "/apps/shop/modules", "install", form("2.0.0", v1.hash), { params: P })));
    const v2 = await publish("2.1.0", { network: ["api.fta.gov.ae"], migrations: ["001_lines.sql", "002_rates.sql"], page: "<h1>Tax invoice</h1>\n" });
    const page = data(await load(loaderCtx(d, "/apps/shop/modules", { params: P })));
    expect(page.installed[0]).toMatchObject({ version: "2.0.0", upgrade: "2.1.0", status: "2.1.0 available" });
    const r = data(await actions.review(actionCtx(d, "/apps/shop/modules", "review", form("2.1.0"), { params: P }))).review;
    expect(r).toMatchObject({ from: "2.0.0", version: "2.1.0", hash: v2.hash, added: ["network api.fta.gov.ae"], removed: [], migrations: ["002_rates.sql"], contract: null, no_change: false });
    expect(r.templates).toContain("pages/invoice.html");
    const up = data(await actions.install(actionCtx(d, "/apps/shop/modules", "install", form("2.1.0", v2.hash), { params: P })));
    expect(up.action_problem).toBeNull();
    expect(data(await load(loaderCtx(d, "/apps/shop/modules", { params: P }))).installed[0]).toMatchObject({ version: "2.1.0", status: "up to date", approved: ["tables tax_gcc__*", "network api.fta.gov.ae"] });
  });

  test("bad form fields and another tenant's app are refused", async () => {
    const { d } = await setup();
    expect(data(await actions.review(actionCtx(d, "/apps/shop/modules", "review", { publisher: "Bad Name", name: "tax_gcc", version: "1" }, { params: P }))).form_error).toBe("No such module version.");
    const other = data(await load(loaderCtx(d, "/apps/nope/modules", { params: { app: "nope" } })));
    expect(other.problem).toMatchObject({ status: 404 });
    expect(permissionLines({ network: ["a.example"], secrets: ["KEY"], slots: [], hooks: ["auth.login"] })).toEqual(["network a.example", "secret KEY", "hook auth.login"]);
  });
});

describe("registry moderation (operator console)", () => {
  test("403 unless the console is on; bad input refused before the API; disable by hash reaches the owner's banner and mail; enable again", async () => {
    const off = await setup();
    expect(((await opsLoad(loaderCtx(off.d, "/ops/registry"))) as Response).status).toBe(403);
    expect(((await opsActions.disable(actionCtx(off.d, "/ops/registry", "disable", { hash: "a".repeat(64), reason: "malware found in it", token: OPERATOR_TOKEN }))) as Response).status).toBe(403);

    const { d, publish } = await setup({ ...SECRETS, OPS_CONSOLE: "operators" });
    const v1 = await publish("2.0.0");
    data(await actions.install(actionCtx(d, "/apps/shop/modules", "install", form("2.0.0", v1.hash), { params: P })));
    expect(data(await opsLoad(loaderCtx(d, "/ops/registry")))).toMatchObject({ reason_min: 10, result: null });
    const before = d.calls.sent.length;
    for (const fields of [
      { hash: v1.hash, reason: "exfiltrates TRNs", token: "renox_pat_" + "a".repeat(32) },
      { hash: "XYZ", reason: "exfiltrates TRNs to a third party", token: OPERATOR_TOKEN },
      { hash: v1.hash, reason: "short", token: OPERATOR_TOKEN },
    ]) {
      expect(data(await opsActions.disable(actionCtx(d, "/ops/registry", "disable", fields))).form_error).not.toBeNull();
    }
    expect(d.calls.sent.length).toBe(before);
    // A well-formed token the API does not know is its 401.
    const unknown = `renox_op_${"z".repeat(32)}`;
    expect(unknown).not.toBe(OPERATOR_TOKEN);
    const refused = data(await opsActions.disable(actionCtx(d, "/ops/registry", "disable", { hash: v1.hash, reason: "exfiltrates TRNs to a third party", token: unknown })));
    expect(refused.action_problem).toMatchObject({ status: 401 });
    const ok = data(await opsActions.disable(actionCtx(d, "/ops/registry", "disable", { hash: v1.hash, reason: "exfiltrates TRNs to a third party", token: OPERATOR_TOKEN })));
    expect(ok.action_problem).toBeNull();
    expect(ok.result.notice).toContain("1 tenant owner(s) were emailed");
    expect(JSON.stringify(ok)).not.toContain(OPERATOR_TOKEN);
    expect(d.h.mailer.last("owner@shop.ae", "module_disabled")?.text).toContain("exfiltrates TRNs");
    const page = data(await load(loaderCtx(d, "/apps/shop/modules", { params: P })));
    expect(page.disabled).toEqual(["tax_gcc 2.0.0 (disabled by Renox: exfiltrates TRNs to a third party)"]);
    expect(page.cards).toEqual([]);
    // A disabled version cannot be reviewed for install.
    expect(data(await actions.review(actionCtx(d, "/apps/shop/modules", "review", form("2.0.0"), { params: P }))).form_error).toContain("was disabled by Renox");
    const again = data(await opsActions.enable(actionCtx(d, "/ops/registry", "enable", { hash: v1.hash, reason: "false positive, reviewed again", token: OPERATOR_TOKEN })));
    expect(again.result.notice).toContain("Enabled again");
    expect(data(await load(loaderCtx(d, "/apps/shop/modules", { params: P }))).disabled).toBeNull();
  });
});

// The templates rendered by the worker (`renox dev`) with the data of a real
// upgrade review and a disabled installation.
test.skipIf(!worker)("the worker renders the Modules page with the upgrade review and the banner, and the moderation page", async () => {
  const { d, publish } = await setup({ ...SECRETS, OPS_CONSOLE: "operators" });
  const v1 = await publish("2.0.0");
  data(await actions.install(actionCtx(d, "/apps/shop/modules", "install", form("2.0.0", v1.hash), { params: P })));
  await publish("2.1.0", { network: ["api.fta.gov.ae"], migrations: ["001_lines.sql", "002_rates.sql"] });
  const page = data(await load(loaderCtx(d, "/apps/shop/modules", { params: P })));
  const review = data(await actions.review(actionCtx(d, "/apps/shop/modules", "review", form("2.1.0"), { params: P })));
  const disabled = ["tax_gcc 2.0.0 (disabled by Renox: exfiltrates TRNs to a third party)"];
  const ops = data(await opsLoad(loaderCtx(d, "/ops/registry")));
  const dev = await devWithData({ "pages/apps/[app]/modules/index.ts": { ...page, ...review, disabled }, "pages/ops/registry/index.ts": ops });
  try {
    const res = await fetch(`${dev.base}/apps/shop/modules`);
    expect(res.status).toBe(200);
    const html = (await res.text()).replaceAll(' dir="auto"', "");
    expect(html).toContain("A module of this app was disabled by Renox.");
    expect(html).toContain("Review upgrade: tax_gcc 2.0.0 → 2.1.0");
    expect(html).toContain("<code>+ network api.fta.gov.ae</code> (new)");
    expect(html).toContain("<code>002_rates.sql</code>");
    expect(html).toContain("Not recorded by this version.");
    expect(html).toContain(`name="hash" value="${review.review.hash}"`);
    expect(html).toContain("<button type=\"submit\">Approve</button>");
    expect(html).toContain("<h3>tax_gcc</h3>");
    expect(html).toContain("49.00 AED / month");
    const mod = await fetch(`${dev.base}/ops/registry`);
    expect(mod.status).toBe(200);
    const m = (await mod.text()).replaceAll(' dir="auto"', "");
    expect(m.match(/name="token"/gu)?.length).toBe(2);
    expect(m).toContain("<button type=\"submit\">Disable</button>");
  } finally {
    await dev.stop();
  }
});
