// OTP codes (#290): 6 digits, 5 minutes, 5 attempts, single use. The code
// is stored as an HMAC (keyed with WHATSAPP_APP_SECRET) and the queued
// message carries it sealed with AES-GCM under a key derived from the same
// secret, so a copy of the file reveals no code.

import { hmacHex, sameString } from "./cloud-api.ts";

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_ATTEMPTS = 5;
/** A new code for the same phone is not sent within this window (the answer is the same). */
export const OTP_RESEND_MS = 30_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function newCode(): string {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String((b[0] as number) % 1_000_000).padStart(6, "0");
}

export const codeHash = (secret: string, phone: string, code: string): Promise<string> => hmacHex(`otp:${secret}`, `${phone}:${code}`);

export async function codeMatches(secret: string, phone: string, code: string, hash: string): Promise<boolean> {
  return sameString(await codeHash(secret, phone, code), hash);
}

async function key(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`whatsapp-seal:${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** `seal:<iv>.<ciphertext>` */
export async function seal(secret: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), enc.encode(text)));
  return `seal:${b64(iv)}.${b64(ct)}`;
}

export async function unseal(secret: string, sealed: string): Promise<string | null> {
  const m = /^seal:([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/u.exec(sealed);
  if (!m) return null;
  try {
    const iv = unb64(m[1] as string);
    const ct = unb64(m[2] as string);
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> }, await key(secret), ct as Uint8Array<ArrayBuffer>));
  } catch {
    return null;
  }
}
