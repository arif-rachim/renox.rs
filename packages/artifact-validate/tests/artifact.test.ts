// Parity with the contract examples: the package must accept and reject
// exactly what docs/contracts/validate.ts does (artifact.md section 6).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkArtifactFiles, checkManifest, checkRouteTable, contentHash, formatViolation, TIERS } from "../src/index.ts";
import type { Json } from "../src/index.ts";

const EXAMPLES = new URL("../../../docs/contracts/examples/", import.meta.url).pathname;

function readTree(dir: string, prefix = ""): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const d of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? d.name : `${prefix}/${d.name}`;
    if (d.isDirectory()) for (const [k, v] of readTree(dir, rel)) out.set(k, v);
    else out.set(rel, new Uint8Array(readFileSync(join(dir, rel))));
  }
  return out;
}

const artifactDir = (group: string): string => {
  const name = readdirSync(join(EXAMPLES, group)).find((n) => /^[0-9a-f]{64}$/u.test(n)) as string;
  return join(EXAMPLES, group, name);
};

describe("contract example artifacts", () => {
  for (const group of ["hello-artifact", "artifact/notes-artifact", "artifact/shop-artifact", "artifact/modules-artifact"]) {
    test(`${group} is valid and its directory name is its hash`, () => {
      const dir = artifactDir(group);
      const result = checkArtifactFiles(readTree(dir), { expectedHash: dir.split("/").pop() as string, tier: TIERS.free });
      expect(result.violations.map(formatViolation)).toEqual([]);
      expect(result.manifest).not.toBeNull();
    });
  }

  test("broken-artifact is rejected for V2", () => {
    const dir = artifactDir("artifact/broken-artifact");
    const result = checkArtifactFiles(readTree(dir), { expectedHash: dir.split("/").pop() as string });
    expect(result.violations.map((v) => v.rule)).toContain("V2");
  });

  test("broken-templates-artifact is rejected for V14", () => {
    const dir = artifactDir("artifact/broken-templates-artifact");
    const result = checkArtifactFiles(readTree(dir), { expectedHash: dir.split("/").pop() as string });
    expect(result.violations.map((v) => v.rule)).toContain("V14");
  });

  // Artifact 1.1 (#227): rules on the files of an artifact with modules.
  for (const [group, rule] of [
    ["artifact/broken-module-migrations-artifact", "V19"],
    ["artifact/broken-override-artifact", "V20"],
  ] as const) {
    test(`${group} is rejected for ${rule}`, () => {
      const dir = artifactDir(group);
      const result = checkArtifactFiles(readTree(dir), { expectedHash: dir.split("/").pop() as string });
      expect(result.violations.map((v) => v.rule)).toEqual([rule]);
    });
  }

  test("hash vectors", () => {
    const vectors = JSON.parse(readFileSync(join(EXAMPLES, "hash-vectors.json"), "utf8")) as {
      vectors: { name: string; files: { path: string; content_base64: string }[]; hash: string }[];
    };
    for (const v of vectors.vectors) {
      const files = new Map(v.files.map((f) => [f.path, new Uint8Array(Buffer.from(f.content_base64, "base64"))]));
      expect(contentHash(files), v.name).toBe(v.hash);
    }
  });
});

describe("single-file examples", () => {
  const dir = join(EXAMPLES, "artifact");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const kind = file.split(".")[0] as string;
    if (kind !== "manifest" && kind !== "route-table") continue;
    test(file, () => {
      const doc = JSON.parse(readFileSync(join(dir, file), "utf8")) as Json & { $comment?: string };
      const violations = (kind === "manifest" ? checkManifest(doc) : checkRouteTable(doc)).map(formatViolation);
      if (file.endsWith(".valid.json")) expect(violations).toEqual([]);
      else {
        expect(violations.length).toBeGreaterThan(0);
        const expected = /\[expect: ([^\]]+)\]/u.exec((doc as { $comment?: string }).$comment ?? "")?.[1];
        if (expected !== undefined) expect(violations.join("\n")).toContain(expected);
      }
    });
  }
  test("the worked route table passes V13", () => {
    const table = JSON.parse(readFileSync(join(EXAMPLES, "hello-artifact/route-table.json"), "utf8")) as Json;
    expect(checkRouteTable(table)).toEqual([]);
  });
});

describe("modules (artifact 1.1)", () => {
  const modules = (): Map<string, Uint8Array> => readTree(artifactDir("artifact/modules-artifact"));

  test("V1: policies/ and overrides/ stay reserved in an artifact without modules", () => {
    const files = readTree(artifactDir("artifact/shop-artifact"));
    files.set("policies/auth/default.cedar", new Uint8Array(1));
    files.set("overrides.json", new TextEncoder().encode("{}"));
    const v1 = checkArtifactFiles(files).violations.filter((v) => v.rule === "V1").map((v) => v.path);
    expect(v1).toEqual(["policies/auth/default.cedar", "overrides.json"]);
  });

  test("V18: a policy file of a module that is not installed", () => {
    const files = modules();
    files.set("policies/billing/default.cedar", new Uint8Array(1));
    expect(checkArtifactFiles(files).violations.map(formatViolation)).toEqual(['V18: policies/billing/default.cedar: module "billing" is not in modules']);
  });

  test("V19: migrations of a module that is not installed", () => {
    const files = modules();
    files.set("migrations/billing/001_init.sql", new TextEncoder().encode("select 1;\n"));
    const rules = checkArtifactFiles(files).violations.map((v) => v.rule);
    expect(rules).toContain("V19");
  });
});

describe("upload-only rules", () => {
  const hello = (): Map<string, Uint8Array> => readTree(artifactDir("hello-artifact"));
  const withManifest = (files: Map<string, Uint8Array>, edit: (m: Record<string, unknown>) => void): Map<string, Uint8Array> => {
    const m = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as Record<string, unknown>;
    edit(m);
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(m)));
    return files;
  };

  test("V10: a limit above the tenant's tier is rejected, within it accepted", () => {
    const files = withManifest(hello(), (m) => (m.limits = { cpu_ms: 200 }));
    expect(checkArtifactFiles(files, { tier: TIERS.free }).violations.map((v) => v.rule)).toEqual(["V10"]);
    expect(checkArtifactFiles(files, { tier: TIERS.paid }).violations).toEqual([]);
  });

  test("V3: the manifest's app must be the upload's app", () => {
    const v = checkArtifactFiles(hello(), { app: "other" }).violations;
    expect(v).toEqual([{ rule: "V3", field: "app.name", reason: '"hello" is not the app "other"' }]);
  });

  test("V1: reserved and unknown top-level entries, case clashes, bad paths", () => {
    const files = hello();
    files.set("templates/x.html", new Uint8Array(1));
    files.set(".env", new Uint8Array(1));
    files.set("code/A.js", new Uint8Array(1));
    files.set("code/a.js", new Uint8Array(1));
    const rules = checkArtifactFiles(files).violations.filter((v) => v.rule === "V1").map((v) => v.path);
    expect(rules).toContain("templates/x.html");
    expect(rules).toContain(".env");
    expect(rules).toContain("code/a.js");
  });
});
