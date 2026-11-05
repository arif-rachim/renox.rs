// Stateless values of the remote MCP (src/mcp/README.md): client ids,
// consent requests, authorization codes and confirmation tokens are sealed
// with keys derived from the master key (deploy-api.md section 9), so the
// platform MCP needs no table of its own. Sealed = AES-256-GCM with a purpose
// string as associated data: a value made for one purpose never opens as
// another, and nothing in it is readable or forgeable without the key.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { ApiError } from "../errors.ts";
import type { Deps } from "../context.ts";
import { masterKeys, type MasterKey } from "../secrets/master.ts";

export type Purpose = "client" | "consent" | "code" | "confirm";

const mcpKey = (master: MasterKey): Buffer => Buffer.from(hkdfSync("sha256", master.key, "renox-mcp", "renox-mcp-seal-v1", 32));

/**
 * The MCP keys: HKDF-SHA256 of each master key, current first; 503 when no
 * master key is configured. These values are not stored, so a rotation
 * (#451) has nothing to re-seal: while the previous key is set, a value
 * sealed under it still opens, and it expires on its own.
 */
function keysOf(deps: Deps): Buffer[] {
  const keys = masterKeys(deps);
  if (keys === null) throw new ApiError("RENOX_UNAVAILABLE", undefined, { retryAfter: 60 });
  return keys.all().map(mcpKey);
}

const b64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

/** `<prefix><base64url(nonce | ciphertext | tag)>` of the JSON of `value`. */
export function seal(deps: Deps, purpose: Purpose, prefix: string, value: unknown): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keysOf(deps)[0] as Buffer, nonce);
  c.setAAD(Buffer.from(`renox-mcp:${purpose}`));
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return `${prefix}${b64url(Buffer.concat([nonce, body, c.getAuthTag()]))}`;
}

/** The value sealed by `seal` with the same purpose and prefix, or null for anything else. */
export function open<T>(deps: Deps, purpose: Purpose, prefix: string, sealed: string | undefined | null): T | null {
  if (typeof sealed !== "string" || !sealed.startsWith(prefix) || sealed.length > 8192) return null;
  const raw = Buffer.from(sealed.slice(prefix.length), "base64url");
  if (raw.length < 12 + 16 + 2) return null;
  for (const key of keysOf(deps)) {
    try {
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(`renox-mcp:${purpose}`));
      d.setAuthTag(raw.subarray(raw.length - 16));
      const text = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
      return JSON.parse(text) as T;
    } catch {
      // Not this key (or not JSON): try the next one.
    }
  }
  return null;
}
