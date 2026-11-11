// The platform's one-time setup token (deploy-api.md section 21, #689, #711):
// `v1.<app>.<hash>.<exp_ms>.<mac>`, `<mac>` = base64url(HMAC-SHA256(key,
// "v1.<app>.<hash>.<exp_ms>")) with the UTF-8 bytes of the `SETUP_KEY` secret
// as the key. The app checks the signature (in constant time), then its own
// name and the expiry. It does not compare `<hash>`: tenant code cannot read
// the hash of the deployment it runs, the key is per app and the setup runs
// once; the hash is recorded (`setup_hash`) instead.
//
// No import of the runtime's modules: control/api's tests check this verifier
// against the API's `mintSetupToken`.

export type SetupToken = { ok: true; app: string; hash: string; exp: number } | { ok: false };

const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Same length and same characters, in a time that depends only on the lengths. */
function sameText(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** base64url(HMAC-SHA256(key, text)), the key being the UTF-8 bytes of the secret's text. */
export async function setupMac(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(text))));
}

/**
 * The token's parts when it is a `v1` token signed with `key`, names `app`
 * and has not expired at `now` (Unix ms); `{ ok: false }` otherwise, whatever
 * the reason (the caller answers 401 alike). An empty key accepts nothing.
 */
export async function verifySetupToken(key: string, token: string, app: string, now: number): Promise<SetupToken> {
  const parts = token.split(".");
  if (key === "" || parts.length !== 5 || parts[0] !== "v1") return { ok: false };
  const [, tokenApp, hash, exp, mac] = parts as [string, string, string, string, string];
  // The signature first: nothing of an unsigned token is looked at.
  if (!sameText(mac, await setupMac(key, parts.slice(0, 4).join(".")))) return { ok: false };
  if (tokenApp !== app || !/^[0-9]{1,16}$/u.test(exp) || Number(exp) <= now || !/^[0-9a-f]{64}$/u.test(hash)) return { ok: false };
  return { ok: true, app: tokenApp, hash, exp: Number(exp) };
}

/** The app's own name: the first label of its host (`<app>.<platform domain>`, `<app>.localhost` under `renox dev`). */
export const appNameOf = (url: URL): string => url.hostname.split(".")[0] ?? "";
