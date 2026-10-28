// Passwords (#113): argon2id through Bun.password. Parameters are the OWASP
// minimum for argon2id (19 MiB, 2 iterations, 1 lane). The `auth` module
// (build plan M1, F4) does not exist yet; it should use the same ones.

import { invalid } from "../errors.ts";

export const ARGON2 = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD_BYTES = 256;

export function checkPassword(password: unknown): string {
  if (typeof password !== "string") throw invalid("password", "must be a string");
  if ([...password].length < MIN_PASSWORD) throw invalid("password", `at least ${MIN_PASSWORD} characters`);
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) throw invalid("password", `at most ${MAX_PASSWORD_BYTES} bytes`);
  return password;
}

export const hashPassword = (password: string): Promise<string> => Bun.password.hash(password, ARGON2);

/** A hash of a random password: verified against when the user does not exist, so both cases take as long. */
let decoy: Promise<string> | undefined;

/** True when `password` matches `hash`; with `hash` null, spends the same time and returns false. */
export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (hash === null) {
    decoy ??= hashPassword(crypto.randomUUID());
    await Bun.password.verify(password, await decoy).catch(() => false);
    return false;
  }
  return Bun.password.verify(password, hash).catch(() => false);
}
