// Constant-time comparison (docs/24-threat-model.md, "Timing attacks on
// signature or token comparison"; #111). Use it for every comparison of a
// secret value: signatures (`webhook.verify` uses it when built), tokens,
// API keys. `===` on strings returns at the first differing character.

const encoder = new TextEncoder();

function bytes(v: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof v === "string") return encoder.encode(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * `true` when `a` and `b` hold the same bytes (strings compare as UTF-8).
 * The time taken depends only on the longer input's length, never on where
 * the inputs differ; inputs of different lengths are not equal.
 */
export function timingSafeEqual(a: string | ArrayBuffer | ArrayBufferView, b: string | ArrayBuffer | ArrayBufferView): boolean {
  const x = bytes(a);
  const y = bytes(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
