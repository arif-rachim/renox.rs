// Shared by the negative tests: a worker on a fresh tenant file per test
// file (renox/test), and the page flows an attacker drives.
import { join } from "node:path";

import { app, type Reply, type TestApp } from "../../../../sdk/src/test.ts";

export const MODULE = join(import.meta.dir, "../..");
export const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
export const start = async (): Promise<TestApp> => (worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp));

export const PASSWORD = "correct horse battery";

/** The text of `<p class="error" id="error">` or `<p class="notice" id="notice">`. */
export const messageOf = (html: string): string | undefined => /<p class="(?:error|notice)" id="(?:error|notice)"[^>]*>([^<]*)<\/p>/u.exec(html)?.[1];

export const authCookie = (r: Reply): string | undefined => r.headers.getSetCookie().find((c) => c.startsWith("__Host-renox_auth="));

/** A user that exists: registered, then signed in once (the cookie stays in `as`'s jar). */
export async function account(t: TestApp, as: string, email: string): Promise<void> {
  await t.as(as).action("/auth/register", "default", { email, password: PASSWORD, display_name: as });
  const r = await t.as(as).action("/auth/login", "default", { email, password: PASSWORD });
  if (r.status !== 303) throw new Error(`sign-in of ${email} failed: ${r.status}`);
}

export const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

/** Median wall time of `n` runs of `f`. */
export async function timed(n: number, f: (i: number) => Promise<unknown>): Promise<number> {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await f(i);
    ms.push(performance.now() - t0);
  }
  return median(ms);
}
