// Artifacts for tests: the contract's examples/hello artifact, changed as a
// test needs, and an upload helper.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash, writeTar } from "@renox/artifact-validate";
import type { Harness } from "./helpers.ts";

const EXAMPLES = new URL("../../../docs/contracts/examples/", import.meta.url).pathname;
const enc = new TextEncoder();

function readTree(dir: string, prefix = ""): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const d of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? d.name : `${prefix}/${d.name}`;
    if (d.isDirectory()) for (const [k, v] of readTree(dir, rel)) out.set(k, v);
    else out.set(rel, new Uint8Array(readFileSync(join(dir, rel))));
  }
  return out;
}

/** The examples/hello artifact, optionally changed; `name` sets app.name. */
export function helloArtifact(edit?: (manifest: Record<string, unknown>, files: Map<string, Uint8Array>) => void): Map<string, Uint8Array> {
  const group = join(EXAMPLES, "hello-artifact");
  const dir = readdirSync(group).find((n) => /^[0-9a-f]{64}$/u.test(n)) as string;
  const files = readTree(join(group, dir));
  if (edit !== undefined) {
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as Record<string, unknown>;
    edit(manifest, files);
    files.set("manifest.json", enc.encode(JSON.stringify(manifest)));
  }
  return files;
}

export const named = (app: string, extra?: (m: Record<string, unknown>, f: Map<string, Uint8Array>) => void) =>
  helloArtifact((m, f) => {
    (m.app as Record<string, unknown>).name = app;
    extra?.(m, f);
  });

export async function upload(h: Harness, token: string, app: string, files: Map<string, Uint8Array>, opts: { gzip?: boolean; hash?: string } = {}): Promise<Response> {
  const tar = writeTar(files);
  return h.request("POST", `/v1/apps/${app}/deployments`, {
    token,
    body: opts.gzip === true ? new Uint8Array(Bun.gzipSync(tar)) : tar,
    headers: { "content-type": opts.gzip === true ? "application/gzip" : "application/x-tar", "x-renox-artifact-hash": opts.hash ?? contentHash(files) },
  });
}

