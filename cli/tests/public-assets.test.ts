// Content-hashed names for the public/ files a template links (#406): the
// gateway serves a hashed name `immutable`, every other public path
// `max-age=0, must-revalidate` (crates/renox-gateway/src/static_files.rs).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newApp } from "../src/commands/new.ts";
import { buildArtifact } from "../src/lib/build.ts";
import { sha256Hex } from "../src/lib/hash.ts";
import { hashedName, isHashedPath, rewriteAssetRefs } from "../src/lib/public-assets.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
const A = "3f2a9c1b5d6e7f80".padEnd(64, "0");
const B = "0123456789abcdef".padEnd(64, "1");

describe("hashed names", () => {
  test("the hash goes before the extension; the gateway's rule sees it as hashed", () => {
    expect(hashedName("/site.css", A)).toBe("/site.3f2a9c1b5d6e7f80.css");
    expect(hashedName("/js/app.min.js", B)).toBe("/js/app.min.0123456789abcdef.js");
    expect(isHashedPath(hashedName("/site.css", A))).toBe(true);
    // The rule of is_hashed_path in renox-gateway, case by case.
    expect(isHashedPath("/assets/app.3f2a9c1b.js")).toBe(true);
    expect(isHashedPath("/logo-5d41402abc4b2a76.png")).toBe(true);
    expect(isHashedPath("/robots.txt")).toBe(false);
    expect(isHashedPath("/deadbeef12.txt")).toBe(false);
    expect(isHashedPath("/app.abc.js")).toBe(false);
    expect(isHashedPath("/noext")).toBe(false);
  });
});

describe("rewriteAssetRefs", () => {
  const hashes = new Map([
    ["/site.css", A],
    ["/js/app.js", B],
    ["/logo-5d41402abc4b2a76.png", A],
    ["/LICENSE", B],
  ]);

  test("literal href and src of a public file point at its hashed name", () => {
    const r = rewriteAssetRefs(
      {
        "pages/_layouts/main.html": `<link rel="stylesheet" href="/site.css">\n<script src='/js/app.js' defer></script>\n<x-script src="/js/app.js"></x-script>`,
      },
      hashes,
    );
    expect(r.sources["pages/_layouts/main.html"]).toBe(
      `<link rel="stylesheet" href="/site.3f2a9c1b5d6e7f80.css">\n<script src='/js/app.0123456789abcdef.js' defer></script>\n<x-script src="/js/app.0123456789abcdef.js"></x-script>`,
    );
    expect([...r.aliases]).toEqual([
      ["/site.css", "/site.3f2a9c1b5d6e7f80.css"],
      ["/js/app.js", "/js/app.0123456789abcdef.js"],
    ]);
  });

  test("bound values, interpolations, queries, other paths and hashed names are left alone", () => {
    const text = [
      `<link :href="css" href2="/site.css">`,
      `<a href="/docs">docs</a>`,
      `<a href="https://example.com/site.css">x</a>`,
      `<link rel="stylesheet" href="/site.css?v=1">`,
      `<link rel="stylesheet" href="/site.css#x">`,
      `<img src="/logo-5d41402abc4b2a76.png">`,
      `<a href="/LICENSE">licence</a>`,
      `<a href="{{ base }}/site.css">x</a>`,
      `<a data-href="/site.css">x</a>`,
    ].join("\n");
    const r = rewriteAssetRefs({ "pages/index.html": text }, hashes);
    expect(r.sources["pages/index.html"]).toBe(text);
    expect(r.aliases.size).toBe(0);
  });

  test("a hashed name that is already a file of public/ is not reused", () => {
    const withClash = new Map([...hashes, ["/site.3f2a9c1b5d6e7f80.css", B]]);
    const r = rewriteAssetRefs({ "p.html": `<link href="/site.css">` }, withClash);
    expect(r.sources["p.html"]).toBe(`<link href="/site.css">`);
  });
});

describe("renox build", () => {
  test.skipIf(!worker)("a linked stylesheet ships under its hashed name too, and the page links that name", async () => {
    const parent = mkdtempSync(join(tmpdir(), "renox-assets-"));
    const dir = newApp("assets", "hello", parent);
    mkdirSync(join(dir, "public"));
    const css = "body { color: #222 }\n";
    writeFileSync(join(dir, "public/site.css"), css);
    writeFileSync(join(dir, "public/robots.txt"), "User-agent: *\n");
    const layout = join(dir, "pages/_layouts/main.html");
    writeFileSync(layout, readFileSync(layout, "utf8").replace("</head>", `  <link rel="stylesheet" href="/site.css">\n</head>`));

    const r = await buildArtifact(dir, join(dir, ".renox/artifact"));
    const hashed = `/site.${sha256Hex(new TextEncoder().encode(css)).slice(0, 16)}.css`;
    const index = JSON.parse(readFileSync(join(r.dir, "public.json"), "utf8")) as { files: Record<string, { sha256: string; size: number; content_type: string }> };
    // Both names, one content; the unlinked file keeps its one name.
    expect(Object.keys(index.files).sort()).toEqual([hashed, "/robots.txt", "/site.css"].sort());
    expect(index.files[hashed]).toEqual(index.files["/site.css"] as { sha256: string; size: number; content_type: string });
    expect(readFileSync(join(r.dir, `public${hashed}`), "utf8")).toBe(css);
    // The compiled layout links the hashed name, not the plain one.
    const templates = readdirSync(join(r.dir, "templates"), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => readFileSync(join(d.parentPath, d.name), "utf8"))
      .join("\n");
    expect(templates).toContain(`href="${hashed}"`);
    expect(templates).not.toContain(`href="/site.css"`);
    // A new stylesheet is a new name: the cached one can never be served for it.
    writeFileSync(join(dir, "public/site.css"), "body { color: #000 }\n");
    const r2 = await buildArtifact(dir, join(dir, ".renox/artifact2"));
    const index2 = JSON.parse(readFileSync(join(r2.dir, "public.json"), "utf8")) as { files: Record<string, unknown> };
    expect(index2.files[hashed]).toBeUndefined();
    expect(existsSync(join(r2.dir, `public${hashed}`))).toBe(false);
  });
});
