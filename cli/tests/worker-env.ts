// The renox-worker binary for the tests that need one (template transpile
// since #43, `renox dev` end to end). Locally they skip when
// RENOX_WORKER_PATH is unset; in CI (`CI` set) a missing worker is an error,
// so those tests cannot turn into silent skips again (#186).

/** RENOX_WORKER_PATH, or undefined (tests skip) outside CI. Throws in CI when it is unset. */
export function testWorker(env: Record<string, string | undefined> = process.env): string | undefined {
  const worker = env.RENOX_WORKER_PATH || undefined;
  if (!worker && env.CI) {
    throw new Error(
      "CI is set and RENOX_WORKER_PATH is not: the template, shop build and dev end-to-end tests must run in CI, not skip (#186)",
    );
  }
  return worker;
}
