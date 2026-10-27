// Web Crypto helpers shared by the hand-written payment helpers. Only
// `crypto.subtle` is used, the API the Edge Runtime isolate exposes.
const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", k, encoder.encode(message)));
}

export async function digestHex(algorithm: "SHA-1" | "SHA-256", message: string): Promise<string> {
  return toHex(await crypto.subtle.digest(algorithm, encoder.encode(message)));
}

/** Constant-time string comparison: HMAC both sides with a random key, compare the MACs. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const key = toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const [ha, hb] = await Promise.all([hmacSha256Hex(key, a), hmacSha256Hex(key, b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0 && a.length === b.length;
}
