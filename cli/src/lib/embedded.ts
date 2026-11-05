// What a compiled `renox` carries inside the binary (#448). From source
// (`bun src/main.ts`) this is null and the CLI reads the repository: the
// official modules under modules/ and the test harness under src/lib/.
// `bun scripts/compile.ts` writes the real value into this file for the
// duration of `bun build --compile` and puts this placeholder back after,
// so the repository never holds the generated copy.

export interface Embedded {
  /** The CLI version the assets were built with. */
  version: string;
  /** sha256 of the module files (path and content), the name of their cache directory. */
  modulesDigest: string;
  /** Every file of every official module, path under modules/ → base64 content. */
  modules: Record<string, string>;
  /** cli/src/lib/test-harness.ts bundled into one ES module (Bun.build, target bun). */
  harness: string;
}

export const EMBEDDED = null as Embedded | null;
