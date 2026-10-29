// UAE PASS as an OAuth provider (#291) against a fake IdP in the test
// process (tenant fetch blocks private addresses): the authorize URL of the
// staging and production environments, the code exchange, the user-info
// mapping (SOP1 unverified, SOP3 a verified identity), and the user it
// signs in, on an in-memory copy of auth's schema.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type AuthCtx } from "../lib/core.ts";
import { exchange, finishSignIn, OAuthError, profileOf, providerFor, startFlow, uaepassProfile, userOfProfile } from "../lib/oauth.ts";

const MODULE = join(import.meta.dir, "..");
const staging = providerFor({ config: {} }, "uaepass");

function fakeIdp(userType: string) {
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input === "https://stg-id.uaepass.ae/idshub/token") {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("code") !== "good-code" || body.get("client_secret") !== "secret") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "uaepass-access-token", token_type: "Bearer" });
    }
    if (input === "https://stg-id.uaepass.ae/idshub/userinfo") {
      if (new Headers(init?.headers).get("authorization") !== "Bearer uaepass-access-token") return new Response("", { status: 401 });
      return Response.json({ sub: "u-1", uuid: "7a1c-uuid", email: "Mariam@Example.AE", fullnameEN: "Mariam Al Mansoori", userType, mobile: "971501234567" });
    }
    return new Response("not found", { status: 404 });
  };
  return fetch;
}

/** A ctx over an in-memory copy of auth's migrations. */
function memoryCtx(): AuthCtx & { sqlite: Database } {
  const sqlite = new Database(":memory:");
  for (const f of readdirSync(join(MODULE, "migrations")).sort()) sqlite.exec(readFileSync(join(MODULE, "migrations", f), "utf8"));
  const p = (x: unknown[] = []) => x as (string | number | null)[];
  return {
    sqlite,
    db: {
      query: async (sql: string, x?: unknown[]) => sqlite.query(sql).all(...p(x)),
      queryOne: async (sql: string, x?: unknown[]) => sqlite.query(sql).get(...p(x)) ?? null,
      execute: async (sql: string, x?: unknown[]) => ({ changes: sqlite.query(sql).run(...p(x)).changes, lastInsertRowid: 0 }),
    } as unknown as AuthCtx["db"],
    headers: new Headers(),
    config: {},
    password: { hash: async () => "x", verify: async () => false },
    events: { emit: async () => "e" },
    hooks: { run: async () => ({ halt: false as const }) },
  };
}

describe("UAE PASS", () => {
  test("the authorize URL: staging by default, production by config; acr_values, no PKCE", async () => {
    const { url } = await startFlow(staging!, "client-1", "https://shop.example/auth/oauth/uaepass/callback", "/");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://stg-id.uaepass.ae/idshub/authorize");
    expect(u.searchParams.get("acr_values")).toBe("urn:safelayer:tws:policies:authentication:level:low");
    expect(u.searchParams.get("scope")).toBe("urn:uae:digitalid:profile:general");
    expect(u.searchParams.get("code_challenge")).toBeNull();
    expect(providerFor({ config: { uaepass_env: "production" } }, "uaepass")?.token).toBe("https://id.uaepass.ae/idshub/token");
  });

  test("code exchange and user info against a fake IdP; a bad code is refused", async () => {
    const fetch = fakeIdp("SOP3");
    const tokens = await exchange(fetch, staging!, { clientId: "client-1", clientSecret: "secret", code: "good-code", redirectUri: "x", verifier: "v" });
    expect(await profileOf(fetch, staging!, tokens, { clientId: "client-1", nonce: "n" })).toEqual({ subject: "7a1c-uuid", email: "mariam@example.ae", emailVerified: true, name: "Mariam Al Mansoori", uaepass: { uuid: "7a1c-uuid", verifiedIdentity: true } });
    await expect(exchange(fetch, staging!, { clientId: "client-1", clientSecret: "secret", code: "bad", redirectUri: "x", verifier: "v" })).rejects.toThrow(new OAuthError("token_refused"));
  });

  test("SOP1: the email is not verified; SOP3: a verified identity on the user", async () => {
    expect(uaepassProfile({ uuid: "u", email: "a@b.ae", userType: "SOP1" })).toMatchObject({ emailVerified: false, uaepass: { verifiedIdentity: false } });
    expect(() => uaepassProfile({ email: "a@b.ae" })).toThrow(new OAuthError("profile_unavailable"));
    const ctx = memoryCtx();
    const r = await userOfProfile(ctx, "uaepass", uaepassProfile({ uuid: "7a1c-uuid", email: "mariam@example.ae", fullnameEN: "Mariam", userType: "SOP3" }));
    expect(r.ok).toBe(true);
    expect(ctx.sqlite.query("select email, uaepass_uuid, verified_identity, email_verified_at is not null as verified from auth__users").all()).toEqual([{ email: "mariam@example.ae", uaepass_uuid: "7a1c-uuid", verified_identity: 1, verified: 1 }]);
    // Signing in again finds the same user through auth__identities.
    const again = await userOfProfile(ctx, "uaepass", uaepassProfile({ uuid: "7a1c-uuid", email: "mariam@example.ae", userType: "SOP3" }));
    expect(again.ok && !again.created).toBe(true);
  });

  test("the halt of auth.after_login stops a UAE PASS sign-in: no session", async () => {
    const ctx = memoryCtx();
    const r = await userOfProfile(ctx, "uaepass", uaepassProfile({ uuid: "u-halt", email: "halt@example.ae", userType: "SOP2" }));
    if (!r.ok) throw new Error("expected a user");
    const halting = { ...ctx, hooks: { run: async () => ({ halt: true as const, response: new Response("second factor", { status: 401 }), module: "twofa" }) } };
    const done = await finishSignIn(halting, r.user);
    expect(done.cookie).toBe("");
    expect(done.halt?.status).toBe(401);
    expect(ctx.sqlite.query("select count(*) as n from auth__sessions").get()).toEqual({ n: 0 });
  });
});
