// Official package (arctic). Google provider authorization URL with PKCE.
import { Google, generateCodeVerifier, generateState } from "arctic";
import { assert, assertEqual } from "./_lib/assert.ts";

export async function check(): Promise<void> {
  const google = new Google("renox-client-id", "renox-fake-client-secret", "https://example.com/auth/callback");
  const state = generateState();
  const verifier = generateCodeVerifier();
  const url = google.createAuthorizationURL(state, verifier, ["openid", "email"]);
  assertEqual(url.origin, "https://accounts.google.com", "origin");
  assertEqual(url.searchParams.get("state"), state, "state");
  assertEqual(url.searchParams.get("code_challenge_method"), "S256", "PKCE method");
  assert((url.searchParams.get("code_challenge") ?? "").length === 43, "S256 challenge is 43 chars");
}
