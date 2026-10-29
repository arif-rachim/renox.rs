// OAuth / OIDC sign-in (#240; docs/24-threat-model.md F4, "OAuth state /
// code injection"). Tenant fetch blocks private addresses, so the fake
// provider runs in this test process: lib/oauth.ts takes its `fetch`, and a
// fake Google (authorize, token with PKCE, signing keys, ID tokens) checks
// what a real one would. The worker part checks what happens before any
// network call: the start redirect and cookie, a callback whose `state`
// does not match, the provider buttons, and that a module not approved for
// the OAuth hosts is refused by `fetch`.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type AuthCtx } from "../lib/core.ts";
import { base64url, checkCallback, exchange, type FlowState, OAuthError, PROVIDERS, profileOf, readFlow, startFlow, userOfProfile, verifyIdToken } from "../lib/oauth.ts";
import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const enc = new TextEncoder();
const google = PROVIDERS.google;
const CLIENT = "test-google-client.apps.example";

/** A fake Google: the authorize request's PKCE challenge, the token endpoint, the keys. */
async function fakeGoogle() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const kid = crypto.randomUUID();
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  const codes = new Map<string, { challenge: string; nonce: string }>();
  const sign = async (claims: Record<string, unknown>, key = pair.privateKey): Promise<string> => {
    const h = base64url(enc.encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
    const c = base64url(enc.encode(JSON.stringify(claims)));
    return `${h}.${c}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${h}.${c}`))))}`;
  };
  let claims: Record<string, unknown> = {};
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input === google.oidc?.jwks) return Response.json({ keys: [jwk] });
    if (input === google.token) {
      const body = new URLSearchParams(String(init?.body));
      const grant = codes.get(body.get("code") ?? "");
      const verifier = body.get("code_verifier") ?? "";
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
      // RFC 7636: the verifier must hash to the challenge of the authorize request.
      if (!grant || challenge !== grant.challenge || body.get("client_secret") !== "secret") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "at", id_token: await sign({ iss: "https://accounts.google.com", aud: CLIENT, sub: "g-123", email: "Lina@Example.com", email_verified: true, name: "Lina", nonce: grant.nonce, exp: Math.floor(Date.now() / 1000) + 600, ...claims }) });
    }
    return new Response("not found", { status: 404 });
  };
  /** The provider's side of the authorize redirect: a code bound to its challenge. */
  const authorize = (url: string): string => {
    const q = new URL(url).searchParams;
    const code = crypto.randomUUID();
    codes.set(code, { challenge: q.get("code_challenge") ?? "", nonce: q.get("nonce") ?? "" });
    return code;
  };
  return { fetch, authorize, sign, setClaims: (c: Record<string, unknown>) => (claims = c) };
}

describe("oauth with a fake provider", () => {
  test("the full flow: state, PKCE, a verified ID token, the profile", async () => {
    const g = await fakeGoogle();
    const { url, flow } = await startFlow(google, CLIENT, "https://shop.example/auth/oauth/google/callback", "/orders");
    const q = new URL(url).searchParams;
    expect(new URL(url).origin).toBe("https://accounts.google.com");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toBe(flow.state);
    expect(q.get("nonce")).toBe(flow.nonce);
    const code = g.authorize(url);
    checkCallback(flow, "google", flow.state, code);
    const tokens = await exchange(g.fetch, google, { clientId: CLIENT, clientSecret: "secret", code, redirectUri: "x", verifier: flow.verifier });
    const p = await profileOf(g.fetch, google, tokens, { clientId: CLIENT, nonce: flow.nonce });
    expect(p).toEqual({ subject: "g-123", email: "lina@example.com", emailVerified: true, name: "Lina" });
  });

  test("a state that does not match is refused before any call", async () => {
    const { flow } = await startFlow(google, CLIENT, "x", "/");
    expect(() => checkCallback(flow, "google", `${flow.state}x`, "code")).toThrow(new OAuthError("state_mismatch"));
    expect(() => checkCallback(null, "google", flow.state, "code")).toThrow(new OAuthError("no_flow"));
    expect(() => checkCallback(flow, "github", flow.state, "code")).toThrow(new OAuthError("provider_mismatch"));
  });

  test("a PKCE verifier that does not match the challenge is refused by the provider", async () => {
    const g = await fakeGoogle();
    const { url } = await startFlow(google, CLIENT, "x", "/");
    const code = g.authorize(url);
    const other = await startFlow(google, CLIENT, "x", "/");
    expect(exchange(g.fetch, google, { clientId: CLIENT, clientSecret: "secret", code, redirectUri: "x", verifier: other.flow.verifier })).rejects.toThrow(new OAuthError("token_refused"));
  });

  test("ID tokens: another key, audience, nonce, issuer, or an expired one are refused", async () => {
    const g = await fakeGoogle();
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: "https://accounts.google.com", aud: CLIENT, sub: "s", nonce: "n", exp: now + 60 };
    expect(await verifyIdToken(g.fetch, google, await g.sign(good), { clientId: CLIENT, nonce: "n" })).toMatchObject({ sub: "s" });
    const stranger = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])) as CryptoKeyPair;
    const cases: [Record<string, unknown>, string, CryptoKey?][] = [
      [good, "id_token_signature", stranger.privateKey],
      [{ ...good, aud: "someone-else" }, "id_token_audience"],
      [{ ...good, nonce: "other" }, "id_token_nonce"],
      [{ ...good, iss: "https://evil.example" }, "id_token_issuer"],
      [{ ...good, exp: now - 3600 }, "id_token_expired"],
    ];
    for (const [claims, reason, key] of cases) {
      await expect(verifyIdToken(g.fetch, google, await g.sign(claims, key), { clientId: CLIENT, nonce: "n" })).rejects.toThrow(new OAuthError(reason));
    }
  });

  test("the flow cookie round-trips and is __Host-, HttpOnly, Secure, SameSite=Lax, 10 minutes", async () => {
    const { flow } = await startFlow(google, CLIENT, "x", "/next");
    const { flowCookie } = await import("../lib/oauth.ts");
    const c = flowCookie(flow);
    expect(c).toMatch(/^__Host-renox_oauth=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/u);
    expect(readFlow(new Headers({ cookie: c.split(";")[0] as string })) as FlowState).toEqual(flow);
  });
});

/** auth's tables in memory, and a ctx over them (the identity rules need no worker). */
function memoryCtx(): { ctx: AuthCtx; db: Database; events: unknown[] } {
  const db = new Database(":memory:");
  for (const f of ["001_init.sql", "002_tokens_user_agent.sql"]) db.exec(readFileSync(join(MODULE, "migrations", f), "utf8"));
  const events: unknown[] = [];
  const ctx: AuthCtx = {
    db: {
      query: async (sql, p = []) => db.query(sql).all(...(p as never[])) as never,
      queryOne: async (sql, p = []) => (db.query(sql).get(...(p as never[])) ?? null) as never,
      execute: async (sql, p = []) => {
        const r = db.query(sql).run(...(p as never[]));
        return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
      },
    },
    headers: new Headers(),
    config: {},
    password: { hash: async () => "!", verify: async () => false },
    events: { emit: async (name, payload) => (events.push({ name, payload }), "01J") },
    hooks: { run: async () => ({ halt: false }) },
  };
  return { ctx, db, events };
}

describe("identity linking rules", () => {
  test("new: a user without a password, linked, auth.user_registered with source oauth", async () => {
    const { ctx, db, events } = memoryCtx();
    const r = await userOfProfile(ctx, "google", { subject: "g-1", email: "New@Example.com", emailVerified: true, name: "New" });
    expect(r.ok && r.created).toBe(true);
    expect(db.query("select provider, subject from auth__identities").all()).toEqual([{ provider: "google", subject: "g-1" }]);
    expect(db.query("select email, password_hash from auth__users").all()).toEqual([{ email: "new@example.com", password_hash: "!oauth" }]);
    expect(events).toEqual([{ name: "auth.user_registered", payload: expect.objectContaining({ source: "oauth" }) }]);
    // The same identity again: the same user, nothing new.
    const again = await userOfProfile(ctx, "google", { subject: "g-1", email: "changed@example.com", emailVerified: false, name: null });
    expect(again.ok && again.user.id).toBe(r.ok ? r.user.id : "");
  });

  test("an existing email is linked only when the provider verified it", async () => {
    const { ctx, db } = memoryCtx();
    db.exec("insert into auth__users (id, email, display_name, password_hash, created_at, updated_at) values ('u1', 'owner@example.com', 'Owner', 'x', 1, 1)");
    const unverified = await userOfProfile(ctx, "microsoft", { subject: "m-1", email: "owner@example.com", emailVerified: false, name: null });
    expect(unverified.ok).toBe(false);
    expect(db.query("select count(*) as n from auth__identities").get()).toEqual({ n: 0 });
    const verified = await userOfProfile(ctx, "github", { subject: "42", email: "OWNER@example.com", emailVerified: true, name: null });
    expect(verified.ok && verified.user.id).toBe("u1");
    expect(db.query("select provider, user_id from auth__identities").all()).toEqual([{ provider: "github", user_id: "u1" }]);
  });
});

describe("renox add shows the OAuth hosts and secrets for approval", () => {
  test("the approval prompt lists them; without approval nothing is installed", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { relative } = await import("node:path");
    const { addModule } = await import("../../../cli/src/commands/add.ts");
    const dir = mkdtempSync(join(tmpdir(), "renox-auth-add-"));
    writeFileSync(join(dir, "renox.toml"), '[app]\nname = "shop"\ntimezone = "Asia/Dubai"\n');
    let prompt = "";
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      const code = await addModule(dir, "auth", { source: `path:${relative(dir, MODULE)}` }, async (q) => ((prompt = q), false));
      expect(code).not.toBe(0);
    } finally {
      console.log = log;
    }
    const shown = `${lines.join("\n")}\n${prompt}`;
    for (const host of ["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com", "github.com", "api.github.com", "login.microsoftonline.com", "graph.microsoft.com"]) expect(shown).toContain(host);
    for (const secret of ["AUTH_GOOGLE_CLIENT_SECRET", "AUTH_GITHUB_CLIENT_SECRET", "AUTH_MICROSOFT_CLIENT_SECRET"]) expect(shown).toContain(secret);
    expect(Bun.file(join(dir, "renox.lock")).size).toBe(0);
  });
});

const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

describe.skipIf(!worker)("oauth on the worker", () => {
  test("start: a 302 to Google with state, PKCE, nonce; the flow cookie", async () => {
    const r = await t.as("lina").request("GET", "/auth/oauth/google/start?next=/orders");
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location") as string);
    expect(to.origin + to.pathname).toBe(google.authorize);
    expect(to.searchParams.get("client_id")).toBe(CLIENT);
    expect(to.searchParams.get("redirect_uri")).toBe("https://test.localhost/auth/oauth/google/callback");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(r.headers.getSetCookie().find((c) => c.startsWith("__Host-renox_oauth="))).toMatch(/HttpOnly; Secure; SameSite=Lax; Max-Age=600$/u);
  });

  test("a callback whose state does not match: the generic refusal, no session, no network call", async () => {
    const lina = t.as("lina");
    const r = await lina.request("GET", "/auth/oauth/google/callback?code=c&state=forged");
    expect(r.status).toBe(400);
    expect(r.headers.getSetCookie().some((c) => c.startsWith("__Host-renox_auth="))).toBe(false);
    const log = t.logs().find((l) => l.message === "oauth sign-in refused") as { fields?: Record<string, unknown> } | undefined;
    expect(log?.fields).toMatchObject({ provider: "google", reason: "state_mismatch" });
    expect(t.meters().some((m) => (m.fetch_sent_bytes as number) > 0)).toBe(false);
  });

  test("only set-up providers: Google has a button and a route, GitHub neither", async () => {
    const login = await t.as("btn").page("/auth/login");
    expect(login.html).toContain("Continue with Google");
    expect(login.html).not.toContain("GitHub");
    expect((await t.request("GET", "/auth/oauth/github/start")).status).toBe(404);
  });

  test("a module not approved for the OAuth hosts is refused by fetch; the secret is in no log", async () => {
    expect(await t.service("reader").probe()).toEqual({ blocked: true, reason: "not_allowlisted" });
    expect(JSON.stringify(t.logs())).not.toContain("test-google-secret-do-not-log-7f3a");
  });
});
