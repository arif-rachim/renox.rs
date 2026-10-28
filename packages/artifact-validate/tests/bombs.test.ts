// The generated-bomb suite (#95) against the reader itself, and the corpus
// files written for the worker's Rust loader (#55). Proves
// docs/23-failure-modes.md section 3, "Tarball decompression bomb / too many
// files". control/api/tests/extract.test.ts runs the same bombs through the
// upload endpoint.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allBombs, writeCorpus } from "../src/bombs.ts";
import { extractTar, TarRejected, UPLOAD_LIMITS } from "../src/index.ts";

const MiB = 1024 * 1024;

describe("generated bombs", () => {
  for (const bomb of allBombs()) {
    test(`${bomb.rule} ${bomb.name} is rejected with ${bomb.rule}, holding at most the cap`, async () => {
      const err = await extractTar(bomb.body(), { gzip: bomb.gzip }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TarRejected);
      expect((err as TarRejected).violation.rule).toBe(bomb.rule);
      // What was pulled from the body bounds what the reader held.
      expect(bomb.produced()).toBeLessThanOrEqual(UPLOAD_LIMITS.maxTotalBytes + MiB);
      if (bomb.streamed) expect(bomb.produced()).toBeLessThan(bomb.fullSize);
    }, 60_000);
  }

  test("the corpus holds the small bombs as plain tar files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bombs-"));
    const written = await writeCorpus(dir);
    expect(readdirSync(dir).sort()).toEqual(written.map((f) => f.slice(dir.length + 1)).sort());
    expect(readdirSync(dir)).toContain("T1-symlink.tar");
    // Small by construction: nothing over 16 MiB is written, so the corpus never needs a bomb's full size on disk.
    for (const f of written) expect(statSync(f).size).toBeLessThanOrEqual(16 * MiB);
  });
});
