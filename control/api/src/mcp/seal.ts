// Stateless values of the remote MCP (src/mcp/README.md): client ids,
// consent requests, authorization codes and confirmation tokens are sealed
// with keys derived from the master key (deploy-api.md section 9), so the
// platform MCP needs no table of its own. Sealed = AES-256-GCM with a purpose
// string as associated data: a value made for one purpose never opens as
// another, and nothing in it is readable or forgeable without the key.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { ApiError } from "../errors.ts";
import type { Deps } from "../context.ts";

export type Purpose = "client" | "consent" | "code" | "confirm";

const keys = new WeakMap<Deps, Buffer>();

/** The MCP key: HKDF-SHA256 of the master key; 503 when no master key is configured. */
function keyOf(deps: Deps): Buffer {
  let k = keys.get(deps);
  if (k === undefined) {
    const master = deps.config.masterKey === null ? null : Buffer.from(deps.config.masterKey, "base64");
    if (master === null || master.length !== 32) throw new ApiError("RENOX_UNAVAILABLE", undefined, { retryAfter: 60 });
    k = Buffer.from(hkdfSync("sha256", master, "renox-mcp", "renox-mcp-seal-v1", 32));
    keys.set(deps, k);
  }
  return k;
}

const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

/** `<prefix><base64url(nonce | ciphertext | tag)>` of the JSON of `value`. */
export function seal(deps: Deps, purpose: Purpose, prefix: string, value: unknown): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(deps), nonce);
  c.setAAD(Buffer.from(`renox-mcp:${purpose}`));
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return `${prefix}${b64url(Buffer.concat([nonce, body, c.getAuthTag()]))}`;
}

/** The value sealed by `seal` with the same purpose and prefix, or null for anything else. */
export function open<T>(deps: Deps, purpose: Purpose, prefix: string, sealed: string | undefined | null): T | null {
  if (typeof sealed !== "string" || !sealed.startsWith(prefix) || sealed.length > 8192) return null;
  const raw = Buffer.from(sealed.slice(prefix.length), "base64url");
  if (raw.length < 12 + 16 + 2) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", keyOf(deps), raw.subarray(0, 12));
    d.setAAD(Buffer.from(`renox-mcp:${purpose}`));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const text = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
    return JSON.parse(text) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return null;
  }
}
