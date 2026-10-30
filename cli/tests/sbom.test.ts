// The build's SBOM (#123; artifact.md 1.4, V29): only the npm packages a
// bundled module's source map names, with version, purl and the lockfile's
// SHA-512; none for an app that bundles no package.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkArtifactFiles } from "@renox/artifact-validate";

import { bundledPackages, cyclonedx, lockIntegrity, packageDirOf } from "../src/build/sbom.ts";
import { buildFiles } from "../src/lib/build.ts";

test("the package of a bundled source path, scoped or not, behind .bun's store", () => {
  expect(packageDirOf("/r/node_modules/.bun/stripe@23.0.1+x/node_modules/stripe/esm/utils.js")).toBe("/r/node_modules/.bun/stripe@23.0.1+x/node_modules/stripe");
  expect(packageDirOf("/r/node_modules/@scope/pkg/index.js")).toBe("/r/node_modules/@scope/pkg");
  expect(packageDirOf("/r/functions/api/x.ts")).toBeNull();
  expect(lockIntegrity('    "stripe": ["stripe@23.0.1", "", {}, "sha512-AAAA"],\n').get("stripe@23.0.1")).toBe("sha512-AAAA");
});

test("the shop's build: stripe (bundled into checkout) is in the SBOM with its lockfile hash; the artifact validates", async () => {
  const shop = join(import.meta.dir, "../../examples/shop");
  const { files } = await buildFiles(shop);
  const raw = files.get("sbom.cdx.json");
  expect(raw).toBeDefined();
  const doc = JSON.parse(new TextDecoder().decode(raw)) as { bomFormat: string; specVersion: string; components: { name: string; version: string; purl: string; hashes?: { alg: string }[] }[] };
  expect([doc.bomFormat, doc.specVersion]).toEqual(["CycloneDX", "1.5"]);
  const stripe = doc.components.find((c) => c.name === "stripe");
  expect(stripe?.purl).toBe(`pkg:npm/stripe@${stripe?.version}`);
  expect(stripe?.hashes?.[0]?.alg).toBe("SHA-512");
  expect(checkArtifactFiles(files, {}).violations.filter((v) => v.rule === "V29")).toEqual([]);
});

test("no bundled package, no SBOM", () => {
  expect(bundledPackages(mkdtempSync(join(tmpdir(), "sbom-")), new Map([["a.js.map", JSON.stringify({ sources: ["functions/a.ts"] })]]))).toEqual([]);
  expect(JSON.parse(cyclonedx("x", [])).components).toEqual([]);
});
