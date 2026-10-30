// #284: TOTP (RFC 6238) on Web Crypto. The RFC's appendix B vectors (8
// digits; the seeds are the ASCII "1234567890…" of 20, 32 and 64 bytes for
// SHA-1, SHA-256 and SHA-512), the ±1-step window, the replay refusal, and
// the base32 / otpauth helpers.

import { describe, expect, test } from "bun:test";

import { base32Decode, base32Encode, generateTotpSecret, totp, totpUri, verifyTotp } from "../src/index.ts";

const seed = (n: number): Uint8Array => new TextEncoder().encode("1234567890".repeat(7).slice(0, n));
const SEEDS = { "SHA-1": seed(20), "SHA-256": seed(32), "SHA-512": seed(64) } as const;

// RFC 6238 appendix B: time, then the code for SHA-1, SHA-256, SHA-512.
const VECTORS: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("RFC 6238 test vectors", () => {
  for (const [time, sha1, sha256, sha512] of VECTORS) {
    test(`T = ${time}`, async () => {
      expect(await totp(SEEDS["SHA-1"], time, { digits: 8 })).toBe(sha1);
      expect(await totp(SEEDS["SHA-256"], time, { digits: 8, algorithm: "SHA-256" })).toBe(sha256);
      expect(await totp(SEEDS["SHA-512"], time, { digits: 8, algorithm: "SHA-512" })).toBe(sha512);
    });
  }
});

test("verifyTotp accepts ±1 step, returns the step, and refuses a replay", async () => {
  const secret = generateTotpSecret();
  expect(base32Decode(secret)).toHaveLength(20);
  const t = 1_800_000_000;
  const code = await totp(secret, t);
  expect(await verifyTotp(secret, code, { time: t })).toBe(Math.floor(t / 30));
  expect(await verifyTotp(secret, code, { time: t + 30 })).toBe(Math.floor(t / 30));
  expect(await verifyTotp(secret, code, { time: t - 30 })).toBe(Math.floor(t / 30));
  expect(await verifyTotp(secret, code, { time: t + 90 })).toBeNull();
  // The step just used cannot be used again, nor an earlier one.
  const step = await verifyTotp(secret, code, { time: t });
  expect(await verifyTotp(secret, code, { time: t, lastStep: step })).toBeNull();
  expect(await verifyTotp(secret, await totp(secret, t + 30), { time: t + 30, lastStep: step })).toBe((step as number) + 1);
  // Malformed codes.
  expect(await verifyTotp(secret, "12345", { time: t })).toBeNull();
  expect(await verifyTotp(secret, "abcdef", { time: t })).toBeNull();
});

test("base32 round trip and the otpauth URI", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
  expect(base32Decode("mzxw 6ytb-oi")).toEqual(new TextEncoder().encode("foobar"));
  expect(() => base32Decode("M1")).toThrow(TypeError);
  expect(totpUri({ secret: "JBSWY3DPEHPK3PXP", issuer: "Shop", account: "alice@example.com" })).toBe(
    "otpauth://totp/Shop:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Shop",
  );
});
