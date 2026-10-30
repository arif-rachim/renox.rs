// TOTP (RFC 6238, over HOTP RFC 4226) for the `2fa` module (#287), the
// `auth` module's step-up (#291) and control-plane MFA (#293); one
// implementation, on Web Crypto (crypto.subtle), so it runs in an isolate,
// in Bun and in a browser alike (#284).
//
//   const secret = generateTotpSecret();                       // base32, 160 bits
//   const uri = totpUri({ secret, issuer: "Shop", account: "alice@example.com" });
//   const step = await verifyTotp(secret, "123456", { lastStep }); // null, or the step to store

import { timingSafeEqual } from "./crypto.ts";

/** Web Crypto takes ArrayBuffer-backed views; ours always are. */
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => u as Uint8Array<ArrayBuffer>;

/** RFC 4648 base32 alphabet (no padding in the secret). */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface TotpOptions {
  /** Seconds per step (RFC 6238 X); 30. */
  period?: number;
  /** Code length; 6 (8 for the RFC test vectors). */
  digits?: number;
  /** HMAC hash; SHA-1, what every authenticator app implements. */
  algorithm?: TotpAlgorithm;
}

export interface VerifyOptions extends TotpOptions {
  /** Unix seconds; now. */
  time?: number;
  /** Steps accepted before and after the current one; 1 (±30 s of clock drift). */
  window?: number;
  /**
   * The step of the last code accepted for this secret: a code of that step
   * or an earlier one is refused, so a code works once (RFC 6238 section 5.2).
   */
  lastStep?: number | null;
}

/** Base32 (RFC 4648) without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 to bytes; spaces, dashes and lowercase are accepted, padding ignored. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/gu, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const v = B32.indexOf(c);
    if (v < 0) throw new TypeError(`base32: invalid character ${JSON.stringify(c)}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A random secret: `bytes` (20, 160 bits as RFC 4226 recommends) in base32. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The `otpauth://totp/...` URI an authenticator app scans (as a QR code). */
export function totpUri(o: { secret: string; issuer: string; account: string } & TotpOptions): string {
  const label = `${encodeURIComponent(o.issuer)}:${encodeURIComponent(o.account)}`;
  const q = new URLSearchParams({ secret: o.secret, issuer: o.issuer });
  if (o.algorithm && o.algorithm !== "SHA-1") q.set("algorithm", o.algorithm.replace("-", ""));
  if (o.digits && o.digits !== 6) q.set("digits", String(o.digits));
  if (o.period && o.period !== 30) q.set("period", String(o.period));
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** HOTP (RFC 4226) of `counter` with the raw key. */
async function hotp(key: Uint8Array, counter: number, digits: number, algorithm: TotpAlgorithm): Promise<string> {
  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: algorithm }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(msg)));
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const bin =
    (((mac[offset] as number) & 0x7f) << 24) | ((mac[offset + 1] as number) << 16) | ((mac[offset + 2] as number) << 8) | (mac[offset + 3] as number);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The code of `secret` (base32) at Unix second `time`, or of the raw key bytes. */
export async function totp(secret: string | Uint8Array, time = Date.now() / 1000, o: TotpOptions = {}): Promise<string> {
  const key = typeof secret === "string" ? base32Decode(secret) : secret;
  const step = Math.floor(time / (o.period ?? 30));
  return hotp(key, step, o.digits ?? 6, o.algorithm ?? "SHA-1");
}

/** Constant-time comparison of two digit strings (crypto.ts). */
const same = (a: string, b: string): boolean => timingSafeEqual(a, b);

/**
 * Checks `code` against the steps around `time`. Resolves with the matched
 * step (store it as the next `lastStep`), or null when no step matches or
 * the matched step is not after `lastStep` (a replay).
 */
export async function verifyTotp(secret: string | Uint8Array, code: string, o: VerifyOptions = {}): Promise<number | null> {
  const digits = o.digits ?? 6;
  if (typeof code !== "string" || !new RegExp(`^[0-9]{${digits}}$`, "u").test(code.trim())) return null;
  const key = typeof secret === "string" ? base32Decode(secret) : secret;
  const period = o.period ?? 30;
  const now = Math.floor((o.time ?? Date.now() / 1000) / period);
  const window = Math.max(0, Math.min(o.window ?? 1, 10));
  let found: number | null = null;
  // Every candidate is computed, so the time taken does not say which matched.
  for (let s = now - window; s <= now + window; s++) {
    const ok = same(await hotp(key, s, digits, o.algorithm ?? "SHA-1"), code.trim());
    if (ok && found === null) found = s;
  }
  if (found === null) return null;
  if (o.lastStep !== undefined && o.lastStep !== null && found <= o.lastStep) return null;
  return found;
}
