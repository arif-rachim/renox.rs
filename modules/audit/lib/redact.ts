// The redaction rule (#288; docs/24-threat-model.md "Secrets in logs"): a
// key that looks like it holds a secret keeps its name and loses its
// value, at any depth. A key is split into words (`apiKey`, `api_key`,
// `API-KEY` are `api key`); it is secret when one word is in WORDS, or
// when its words run together into one of JOINED. Values are never
// inspected: a secret under an innocent key is the caller's mistake.

export const REDACTED = "[redacted]";

const WORDS = new Set(["password", "passwd", "pass", "passphrase", "pwd", "secret", "secrets", "token", "tokens", "authorization", "cookie", "cookies", "credential", "credentials", "otp", "pin", "cvv", "cvc", "iban", "signature", "salt", "hash"]);
const JOINED = ["apikey", "privatekey", "accesskey", "cardnumber", "sessionid", "clientsecret"];

const MAX_DEPTH = 8;

export function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w !== "");
}

export function isSecretKey(key: string): boolean {
  const w = words(key);
  if (w.some((x) => WORDS.has(x))) return true;
  const joined = w.join("");
  return JOINED.some((j) => joined.includes(j));
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = isSecretKey(k) ? REDACTED : redact(v, depth + 1);
  return out;
}
