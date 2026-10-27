// The TypeScript content hash against the cross-language vectors shared
// with crates/renox-cell (docs/contracts/examples/hash-vectors.json).
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import vectors from "../../docs/contracts/examples/hash-vectors.json";
import { canonicalListing, hashDir, hashFiles } from "../src/lib/hash.ts";

test("every hash vector matches in memory and on disk", () => {
  expect(vectors.vectors.length).toBeGreaterThanOrEqual(3);
  for (const v of vectors.vectors) {
    const files = new Map(v.files.map((f) => [f.path, new Uint8Array(Buffer.from(f.content_base64, "base64"))] as const));
    expect(canonicalListing(files)).toBe(v.listing);
    expect(hashFiles(files)).toBe(v.hash);
    const dir = mkdtempSync(join(tmpdir(), "renox-hash-"));
    for (const [p, bytes] of files) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), bytes);
    }
    expect(hashDir(dir)).toBe(v.hash);
  }
});

test("the hello worked example hashes to its directory name", () => {
  const hash = "802957869194e4c16e462dfcb50bfa6b3e435fca606b96a1223e2b7e21271d7a";
  expect(hashDir(join(import.meta.dir, "../../docs/contracts/examples/hello-artifact", hash))).toBe(hash);
});

test("fetch-worker reads .sha256 assets and names assets per platform", async () => {
  const { assetName, parseSha256File, releaseUrl } = await import("../scripts/fetch-worker.ts");
  const hex = "a".repeat(64);
  expect(parseSha256File(`${hex}  renox-worker-linux-x64\n`)).toBe(hex);
  expect(() => parseSha256File("nope")).toThrow();
  expect(assetName("linux", "x64")).toBe("renox-worker-linux-x64");
  expect(releaseUrl("0.1.0", "renox-worker-linux-x64")).toBe(
    "https://github.com/arif-rachim/renox.rs/releases/download/v0.1.0/renox-worker-linux-x64",
  );
});
