// docs/24-threat-model.md F4, "OAuth state / code injection": a callback
// whose `state` does not match the flow cookie (or with no flow cookie) is
// refused before the code is exchanged; a code exchanged with another PKCE
// verifier is refused by the provider (a fake Google in this process: tenant
// fetch cannot reach a local server).

import { describe, expect, test } from "bun:test";

import { base64url, checkCallback, exchange, OAuthError, PROVIDERS, startFlow } from "../../lib/oauth.ts";
import { authCookie, start, worker } from "./helpers.ts";

const google = PROVIDERS.google;
const enc = new TextEncoder();

describe("PKCE", () => {
  test("a verifier that does not hash to the authorize request's challenge is refused", async () => {
    const { url } = await startFlow(google, "client", "https://app.example/cb", "/");
    const challenge = new URL(url).searchParams.get("code_challenge");
    const provider = async (_u: string, init?: RequestInit) => {
      const v = new URLSearchParams(String(init?.body)).get("code_verifier") ?? "";
      const ok = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(v)))) === challenge;
      return ok ? Response.json({ access_token: "x", id_token: "y" }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    };
    const attacker = await startFlow(google, "client", "https://app.example/cb", "/");
    await expect(exchange(provider, google, { clientId: "client", clientSecret: "s", code: "c", redirectUri: "r", verifier: attacker.flow.verifier })).rejects.toThrow(new OAuthError("token_refused"));
  });

  test("state: missing, foreign or forged is refused", async () => {
    const { flow } = await startFlow(google, "client", "x", "/");
    expect(() => checkCallback(flow, "google", "forged", "code")).toThrow(new OAuthError("state_mismatch"));
    expect(() => checkCallback(flow, "google", null, "code")).toThrow(new OAuthError("state_mismatch"));
    expect(() => checkCallback(null, "google", flow.state, "code")).toThrow(new OAuthError("no_flow"));
  });
});

const t = await start();

describe.skipIf(!worker)("state on the worker", () => {
  test("a callback without the flow cookie, or with another flow's state, is refused with no session", async () => {
    const attacker = t.as("attacker");
    await attacker.request("GET", "/auth/oauth/google/start");
    const theirs = new URL(String((await t.as("victim").request("GET", "/auth/oauth/google/start")).headers.get("location"))).searchParams.get("state");
    // The victim's state with the attacker's flow cookie (login CSRF), and no cookie at all.
    for (const [who, state] of [[attacker, theirs], [t.as("nobody"), theirs]] as const) {
      const r = await who.request("GET", `/auth/oauth/google/callback?code=stolen&state=${state}`);
      expect(r.status).toBe(400);
      expect(authCookie(r)).toBeUndefined();
    }
  });
});
