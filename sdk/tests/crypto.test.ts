// docs/24-threat-model.md, "Timing attacks on signature or token
// comparison" (#111).
import { expect, test } from "bun:test";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { timingSafeEqual } from "../src/index.ts";

test("equal inputs of the same length", () => {
  expect(timingSafeEqual("abc", "abc")).toBe(true);
  expect(timingSafeEqual("", "")).toBe(true);
  expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  expect(timingSafeEqual("é", new Uint8Array([0xc3, 0xa9]))).toBe(true);
  expect(timingSafeEqual(new Uint8Array([9, 1, 2]).subarray(1), new Uint8Array([1, 2]).buffer)).toBe(true);
});

test("different inputs of the same length", () => {
  expect(timingSafeEqual("abc", "abd")).toBe(false);
  expect(timingSafeEqual("xbc", "abc")).toBe(false);
  expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
});

test("inputs of different lengths are never equal", () => {
  expect(timingSafeEqual("abc", "ab")).toBe(false);
  expect(timingSafeEqual("ab", "abc")).toBe(false);
  expect(timingSafeEqual("", "a")).toBe(false);
  // A prefix padded with zero bytes is still a different input.
  expect(timingSafeEqual(new Uint8Array([1, 0]), new Uint8Array([1]))).toBe(false);
});

/**
 * Grep test (#111): every secret comparison uses a constant-time compare.
 * The SDK: any module that verifies a signature or token imports
 * timingSafeEqual. `webhook.verify` (ops 1.7.0) is only the type of
 * `op_webhook_verify`, which compares in Rust (#322 tests it there).
 * The cell's CSRF check (Rust) compares with `session::same` (subtle's
 * `ct_eq`), never `==`.
 */
test("signature and token checks use a constant-time compare", () => {
  const src = join(import.meta.dir, "../src");
  for (const f of readdirSync(src)) {
    // `Password.verify` (ctx.ts) is only the type of the argon2id op, which
    // compares in constant time in Rust (ops.md section 16).
    // `Webhook.verify` (ctx.ts, ops 1.7.0) is likewise the type of `op_webhook_verify`, with its doc comment.
    const text = readFileSync(join(src, f), "utf8")
      .replace(/^\s*verify\(password: string, hash: string\): Promise<boolean>;$/gmu, "")
      .replace(/^\s*\/\*\* Rejects with 401 `RENOX_WEBHOOK_SIGNATURE`.*\*\/\n\s*verify\(req: Request, .*$/gmu, "");
    if (/\b(verify|signature|hmac)\b/iu.test(text) && f !== "crypto.ts") expect([f, text.includes("timingSafeEqual")]).toEqual([f, true]);
  }
  const pages = join(import.meta.dir, "../../crates/renox-cell/src/pages");
  const guard = readFileSync(join(pages, "mod.rs"), "utf8");
  const check = guard.slice(guard.indexOf("pub fn check("), guard.indexOf("#[cfg(test)]"));
  expect(check).toContain("session::same(");
  expect(check).not.toMatch(/(token|expected|submitted)\w*\s*[!=]=/u);
  const session = readFileSync(join(pages, "session.rs"), "utf8");
  expect(session).toContain("ct_eq");
});
