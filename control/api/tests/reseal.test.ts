// A master key rotation (#451; ops/security/keys.md, "Master key";
// src/secrets/master.ts and src/secrets/reseal.ts): values sealed under key A
// open with B current and A previous, the re-seal job moves them to B, and B
// alone then opens every one of them. A crash in the middle loses nothing,
// and no log line, error, report or metric carries a value, a key or a
// ciphertext.
//
// docs/24-threat-model.md G, "Key compromise": the master key can be rotated
// without losing a sealed value; docs/23-failure-modes.md "Control plane
// restart / crash" for the job's crash in the middle.

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { openTotp, totpKey } from "../src/auth/mfa.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { open as openMcp, seal as sealMcp } from "../src/mcp/seal.ts";
import { MasterKeyProvider } from "../src/secrets/crypto.ts";
import { keyIdOf, masterKeys } from "../src/secrets/master.ts";
import { reseal, summary } from "../src/secrets/reseal.ts";
import { latestVersion, valuesAt } from "../src/secrets/store.ts";
import { exportSignatureValid, signExport } from "../src/tenants/backups.ts";
import { nodeTarget } from "../src/workers/failover.ts";
import { totp } from "../../../sdk/src/totp.ts";
import { assertScoped, createApp_, harness, nodeToken, OPERATOR_TOKEN, signup, tenant, TEST_MASTER_KEY, type Harness, type Session } from "./helpers.ts";

afterEach(assertScoped);

/** Key A is the harness's; B is the new key of the rotation. */
const A = TEST_MASTER_KEY;
const B = Buffer.alloc(32, 11).toString("base64");
const idOf = (text: string) => keyIdOf(Buffer.from(text, "base64"));

const VALUES: Record<string, Record<string, string>> = {
  t_alpha: { STRIPE_KEY: "sk_test_alpha_value_0001", DB_PASSWORD: "alpha-password-0002" },
  t_beta: { STRIPE_KEY: "sk_test_beta_value_0003" },
};
const NODE = "node-rot";
/** App names are global: one per tenant. */
const appOf = (tenantId: string): string => `app-${tenantId.slice(2)}`;

interface Fixture {
  h: Harness;
  totpSecret: string;
  callbackToken: string;
}

async function enrolTotp(h: Harness, s: Session): Promise<string> {
  const start = await h.request("POST", "/v1/account/mfa/totp", { session: s, json: {} });
  expect(start.status).toBe(201);
  const { secret } = (await start.json()) as { secret: string };
  const ok = await h.request("POST", "/v1/account/mfa/totp/confirm", { session: s, json: { code: await totp(secret, h.clock.now / 1000) } });
  expect(ok.status).toBe(200);
  return secret;
}

/** Values of every kind sealed under the harness's key A. */
async function sealedUnderA(): Promise<Fixture> {
  const h = await harness();
  expect(masterKeys(h.deps)?.current.id).toBe(idOf(A));
  for (const [tenantId, secrets] of Object.entries(VALUES)) {
    const token = await tenant(h, tenantId);
    await createApp_(h, token, appOf(tenantId));
    for (const [name, value] of Object.entries(secrets)) {
      expect((await h.request("PUT", `/v1/apps/${appOf(tenantId)}/secrets/${name}`, { token, json: { value } })).status).toBe(200);
    }
  }
  const totpSecret = await enrolTotp(h, await signup(h, "owner@rotation.test", "t_rot"));
  const reg = await h.request("POST", "/v1/nodes/register", {
    token: await nodeToken(h, NODE),
    json: { type: "node_register", schema_version: 0, node_id: NODE, worker_version: "0.7.0", region: "me-central-1", max_cells: 100, listen_url: "http://10.0.0.20:8790" },
  });
  expect(reg.status).toBe(200);
  const callbackToken = ((await reg.json()) as { callback_token: string }).callback_token;
  expect(callbackToken).toMatch(/^renox_cb_/u);
  return { h, totpSecret, callbackToken };
}

const use = (h: Harness, current: string, previous: string | null): void => {
  h.deps.config.masterKey = current;
  h.deps.config.masterKeyPrevious = previous;
};

/** How many stored values open under the configured keys, out of how many there are. */
async function opened(f: Fixture): Promise<{ ok: number; of: number }> {
  const { h } = f;
  const keys = masterKeys(h.deps);
  if (keys === null) throw new Error("no master key");
  let ok = 0;
  let of = 0;
  const provider = new MasterKeyProvider(keys);
  for (const [tenantId, secrets] of Object.entries(VALUES)) {
    of += Object.keys(secrets).length;
    try {
      const got = await valuesAt(h.db, provider, tenantId, appOf(tenantId), await latestVersion(h.db, tenantId, appOf(tenantId)), Object.keys(secrets));
      ok += Object.entries(secrets).filter(([n, v]) => got[n] === v).length;
    } catch {
      // The data key does not unwrap under these keys.
    }
  }
  for (const r of await h.db.query<{ user_id: string; secret_sealed: string; secret_key_id: string | null }>("select user_id, secret_sealed, secret_key_id from account_mfa_totp")) {
    of++;
    if (keys.forId(r.secret_key_id).some((k) => openTotp(totpKey(k), r.user_id, r.secret_sealed) === f.totpSecret)) ok++;
  }
  of++;
  try {
    if ((await nodeTarget(h.deps, h.db, NODE)).token === f.callbackToken) ok++;
  } catch {
    // The callback token does not unwrap under these keys.
  }
  return { ok, of };
}

/** Every stored ciphertext as text, to look for in logs and answers. */
async function ciphertexts(h: Harness): Promise<string[]> {
  const out: string[] = [];
  for (const r of await h.db.query<{ w: Uint8Array }>("select wrapped_dek as w from tenant_keys")) out.push(Buffer.from(r.w).toString("hex"), Buffer.from(r.w).toString("base64"));
  for (const r of await h.db.query<{ s: string }>("select secret_sealed as s from account_mfa_totp")) out.push(r.s);
  for (const r of await h.db.query<{ w: Uint8Array }>("select callback_token_wrapped as w from workers where callback_token_wrapped is not null"))
    out.push(Buffer.from(r.w).toString("hex"), Buffer.from(r.w).toString("base64"));
  for (const r of await h.db.query<{ c: Uint8Array }>("select ciphertext as c from secrets")) out.push(Buffer.from(r.c).toString("hex"), Buffer.from(r.c).toString("base64"));
  return out;
}

describe("master key rotation (#451)", () => {
  test("values sealed under A open under B with A previous; the job moves them all; B alone then opens them", async () => {
    const f = await sealedUnderA();
    const { h } = f;
    expect(await opened(f)).toEqual({ ok: 5, of: 5 });

    // B alone before the job: nothing sealed under A opens.
    use(h, B, null);
    expect(await opened(f)).toEqual({ ok: 0, of: 5 });

    use(h, B, A);
    expect(await opened(f)).toEqual({ ok: 5, of: 5 });
    const metrics = async () => (await (await h.request("GET", "/v1/ops/metrics", { token: OPERATOR_TOKEN })).text()).split("\n").filter((l) => l.startsWith("renox_cp_sealed_values_other_key{"));
    expect(await metrics()).toEqual(['renox_cp_sealed_values_other_key{kind="tenant_key"} 2', 'renox_cp_sealed_values_other_key{kind="totp"} 1', 'renox_cp_sealed_values_other_key{kind="callback_token"} 1']);

    const report = await reseal(h.deps);
    expect(report.tenant_key).toEqual({ resealed: 2, retagged: 0, raced: 0, unreadable: [], remaining: 0 });
    expect(report.totp).toEqual({ resealed: 1, retagged: 0, raced: 0, unreadable: [], remaining: 0 });
    expect(report.callback_token).toEqual({ resealed: 1, retagged: 0, raced: 0, unreadable: [], remaining: 0 });
    expect(summary(masterKeys(h.deps), report).exitCode).toBe(0);
    expect(await metrics()).toEqual(['renox_cp_sealed_values_other_key{kind="tenant_key"} 0', 'renox_cp_sealed_values_other_key{kind="totp"} 0', 'renox_cp_sealed_values_other_key{kind="callback_token"} 0']);
    // Every id is B's now.
    const ids = [
      ...(await h.db.query<{ id: string }>("select master_key_id as id from tenant_keys")),
      ...(await h.db.query<{ id: string }>("select secret_key_id as id from account_mfa_totp")),
      ...(await h.db.query<{ id: string }>("select callback_token_key_id as id from workers where callback_token_wrapped is not null")),
    ].map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set([idOf(B)]));

    // The operator unsets the previous key: B alone opens every value, A alone none.
    use(h, B, null);
    expect(await opened(f)).toEqual({ ok: 5, of: 5 });
    use(h, A, null);
    expect(await opened(f)).toEqual({ ok: 0, of: 5 });
    use(h, B, null);
    // A second run has nothing to do.
    expect((await reseal(h.deps)).tenant_key).toEqual({ resealed: 0, retagged: 0, raced: 0, unreadable: [], remaining: 0 });
  });

  test("a crash in the middle of the job loses nothing; the next run finishes", async () => {
    const f = await sealedUnderA();
    const { h } = f;
    use(h, B, A);
    let writes = 0;
    const crash = new Error("forced crash before the second write");
    await expect(
      reseal(h.deps, {
        batch: 1,
        beforeWrite: () => {
          if (++writes === 2) throw crash;
        },
      }),
    ).rejects.toBe(crash);
    // One tenant key moved, the rest not: all five still open, and the job's state is in the rows alone.
    const [moved] = await h.db.query<{ n: unknown }>("select count(*) as n from tenant_keys where master_key_id = $1", [idOf(B)]);
    expect(Number(moved?.n)).toBe(1);
    expect(await opened(f)).toEqual({ ok: 5, of: 5 });
    const report = await reseal(h.deps);
    expect(report.tenant_key.resealed + report.totp.resealed + report.callback_token.resealed).toBe(3);
    expect(report.tenant_key.remaining + report.totp.remaining + report.callback_token.remaining).toBe(0);
    use(h, B, null);
    expect(await opened(f)).toEqual({ ok: 5, of: 5 });
  });

  test("no log line, error, report or metric carries a value, a key or a ciphertext", async () => {
    const f = await sealedUnderA();
    const { h } = f;
    use(h, B, A);
    const before = await ciphertexts(h);
    // A row that opens under no key is named by its row key only.
    await h.db.query("update tenant_keys set wrapped_dek = $1 where tenant_id = 't_beta'", [new Uint8Array(randomBytes(48))]);
    const errors: string[] = [];
    try {
      await reseal(h.deps, { beforeWrite: (kind) => { if (kind === "callback_token") throw new Error("forced"); } });
    } catch (e) {
      errors.push(String(e), (e as Error).stack ?? "");
    }
    const report = await reseal(h.deps);
    expect(report.tenant_key.unreadable).toEqual(["t_beta"]);
    const { line, exitCode } = summary(masterKeys(h.deps), report);
    expect(exitCode).toBe(1);
    const metrics = await (await h.request("GET", "/v1/ops/metrics", { token: OPERATOR_TOKEN })).text();
    const everything = [...h.log.lines, ...errors, JSON.stringify(report), line, metrics].join("\n");
    expect(h.log.lines.some((l) => l.includes('"reseal"'))).toBe(true);
    const secrets = [...Object.values(VALUES).flatMap((v) => Object.values(v)), f.totpSecret, f.callbackToken, A, B, Buffer.from(A, "base64").toString("hex"), Buffer.from(B, "base64").toString("hex")];
    for (const s of [...secrets, ...before, ...(await ciphertexts(h))]) expect(everything).not.toContain(s);
  });

  test("values from before key ids (env-1, or no id) are re-tagged under the current key without a new ciphertext", async () => {
    const f = await sealedUnderA();
    const { h } = f;
    await h.db.query("update tenant_keys set master_key_id = 'env-1'");
    await h.db.query("update account_mfa_totp set secret_key_id = null");
    await h.db.query("update workers set callback_token_key_id = null");
    const before = await ciphertexts(h);
    // Still A alone, as on main before #451.
    expect(await opened(f)).toEqual({ ok: 5, of: 5 });
    const report = await reseal(h.deps);
    expect([report.tenant_key.retagged, report.totp.retagged, report.callback_token.retagged]).toEqual([2, 1, 1]);
    expect([report.tenant_key.resealed, report.totp.resealed, report.callback_token.resealed]).toEqual([0, 0, 0]);
    expect(await ciphertexts(h)).toEqual(before);
    expect(await opened(f)).toEqual({ ok: 5, of: 5 });

    // A rotation straight from pre-id values: they open with B current and A previous, then move.
    await h.db.query("update tenant_keys set master_key_id = 'env-1'");
    use(h, B, A);
    expect(await opened(f)).toEqual({ ok: 5, of: 5 });
    expect((await reseal(h.deps)).tenant_key.resealed).toBe(2);
    use(h, B, null);
    expect(await opened(f)).toEqual({ ok: 5, of: 5 });
  });

  test("MCP seals and signed export URLs (not stored) work under A with A previous, and not without it", async () => {
    const h = await harness();
    const sealed = sealMcp(h.deps, "code", "rnx_c_", { client: "x", n: 1 });
    const sig = signExport(h.deps, "exp_01JBQ40000000000000000EX01", 1_900_000_000_000);
    use(h, B, A);
    expect(openMcp(h.deps, "code", "rnx_c_", sealed)).toEqual({ client: "x", n: 1 });
    expect(exportSignatureValid(h.deps, "exp_01JBQ40000000000000000EX01", 1_900_000_000_000, sig)).toBe(true);
    // New ones are made under B.
    const fresh = sealMcp(h.deps, "code", "rnx_c_", { n: 2 });
    use(h, B, null);
    expect(openMcp(h.deps, "code", "rnx_c_", sealed)).toBeNull();
    expect(exportSignatureValid(h.deps, "exp_01JBQ40000000000000000EX01", 1_900_000_000_000, sig)).toBe(false);
    expect(openMcp(h.deps, "code", "rnx_c_", fresh)).toEqual({ n: 2 });
  });

  test("CONTROL_MASTER_KEY_PREVIOUS is refused alone, equal to the current key, or not 32 bytes; the message names no key", () => {
    const refused = (env: Record<string, string>): string => {
      try {
        loadConfig(env);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      throw new Error("accepted");
    };
    const short = Buffer.alloc(16, 3).toString("base64");
    const messages = [
      refused({ CONTROL_MASTER_KEY_PREVIOUS: A }),
      refused({ CONTROL_MASTER_KEY: A, CONTROL_MASTER_KEY_PREVIOUS: A }),
      refused({ CONTROL_MASTER_KEY: B, CONTROL_MASTER_KEY_PREVIOUS: short }),
      refused({ CONTROL_MASTER_KEY: short }),
    ];
    expect(messages[0]).toContain("without CONTROL_MASTER_KEY");
    expect(messages[1]).toContain("same key");
    expect(messages[2]).toContain("CONTROL_MASTER_KEY_PREVIOUS must be 32 bytes");
    for (const m of messages) for (const k of [A, B, short]) expect(m).not.toContain(k);
    const ok = loadConfig({ CONTROL_MASTER_KEY: B, CONTROL_MASTER_KEY_PREVIOUS: A });
    expect([ok.masterKey, ok.masterKeyPrevious]).toEqual([B, A]);
  });
});
