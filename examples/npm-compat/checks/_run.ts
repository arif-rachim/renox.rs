// Runs every check with a 2 s timeout each and reports one result per package.
import { checks, type Entry } from "./_registry.ts";

export const CHECK_TIMEOUT_MS = 2000;

export interface Result {
  package: string;
  version: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export async function runOne(entry: Entry, timeoutMs = CHECK_TIMEOUT_MS): Promise<Result> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entry.run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { package: entry.package, version: entry.version, ok: true, ms: performance.now() - start };
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { package: entry.package, version: entry.version, ok: false, error, ms: performance.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/** Sequential, so one package's timing is not polluted by another's. */
export async function runAll(list: readonly Entry[] = checks): Promise<Result[]> {
  const results: Result[] = [];
  for (const entry of list) results.push(await runOne(entry));
  return results;
}
