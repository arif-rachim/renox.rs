// `renox publish` (manifest.md 1.2, section 5; deploy-api.md 0.5 section 19;
// #323): in a module tree with `[publisher]`, sign the tree hash with the
// publisher's Ed25519 key, write `module.sig`, upload the tree, and print
// the permission summary a tenant sees at install.
//
//   renox publish [--dir <module tree>] [--dry-run]
//
// The key: `RENOX_PUBLISHER_KEY` (PEM or base64url PKCS#8), else
// `~/.renox/keys/<publisher>.pem`. It never leaves this machine.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { writeTar } from "@renox/artifact-validate";

import { UserError, ValidationError } from "../errors.ts";
import { readTree } from "../lib/hash.ts";
import { readManifest } from "../lib/modules/manifest.ts";
import { keyIdOf, privateKey, SIG_FILE, signTree, type ModuleSig } from "../lib/sign.ts";
import { apiRequest, defaultIo, type Io } from "./login.ts";

export interface PublishResult {
  sig: ModuleSig;
  summary: string[];
  uploaded: boolean;
}

/** The permission lines a tenant approves at install. */
export function permissionSummary(p: { tables?: string; network: string[]; secrets: string[]; slots: string[]; hooks: string[] }): string[] {
  const l = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
  return [`tables: ${p.tables ?? "none"}`, `network: ${l(p.network)}`, `secrets: ${l(p.secrets)}`, `slots: ${l(p.slots)}`, `hooks: ${l(p.hooks)}`];
}

export async function publish(dir: string, opts: { io?: Io; dryRun?: boolean; key?: string } = {}): Promise<PublishResult> {
  const io = opts.io ?? defaultIo();
  const { manifest, problems } = readManifest(dir, "module.toml");
  if (manifest === null || problems.length > 0) {
    throw new ValidationError(`module.toml is invalid:\n${problems.map((p) => `  ${p.rule}: ${p.message}`).join("\n")}`, { file: "module.toml" });
  }
  const publisher = (manifest.doc.publisher as { name?: string; key_id?: string } | undefined) ?? {};
  if (typeof publisher.name !== "string" || typeof publisher.key_id !== "string") {
    throw new UserError("module.toml has no [publisher] name and key_id", { hint: "add [publisher] name = \"<you>\" and key_id = \"ed25519:…\"" });
  }
  const keyText = opts.key ?? io.env.RENOX_PUBLISHER_KEY ?? (() => {
    const path = join(homedir(), ".renox", "keys", `${publisher.name}.pem`);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  })();
  if (keyText === undefined) throw new UserError(`no signing key for ${publisher.name}`, { hint: "set RENOX_PUBLISHER_KEY or put the key in ~/.renox/keys/<publisher>.pem" });
  const key = privateKey(keyText);
  if (keyIdOf(key) !== publisher.key_id) throw new UserError(`the signing key is not [publisher] key_id ${publisher.key_id}`);
  const sig = signTree(dir, publisher.name, manifest.name, manifest.version, key);
  writeFileSync(join(dir, SIG_FILE), `${JSON.stringify(sig, null, 2)}\n`);
  const summary = permissionSummary(manifest.permissions);
  if (opts.dryRun) return { sig, summary, uploaded: false };
  const res = await apiRequest(io, "PUT", `/v1/registry/${publisher.name}/${manifest.name}/${manifest.version}`, {
    body: writeTar(readTree(dir)),
    headers: { "content-type": "application/x-tar" },
  });
  if (res.status === 409) throw new UserError(`${publisher.name}/${manifest.name}@${manifest.version} is already published; versions are immutable`, { hint: "bump [module] version" });
  if (!res.ok) throw new UserError(`the registry refused the upload (${res.status}): ${await res.text()}`);
  return { sig, summary, uploaded: true };
}

export async function run(args: string[]): Promise<number> {
  let dir = process.cwd();
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--dir") dir = resolve(args[++i] ?? ".");
    else if (a === "--dry-run") dryRun = true;
    else throw new UserError(`unexpected argument ${JSON.stringify(a)}\nusage: renox publish [--dir <module tree>] [--dry-run]`);
  }
  const r = await publish(dir, { dryRun });
  console.log(`${r.uploaded ? "published" : "signed"} ${r.sig.publisher}/${r.sig.name}@${r.sig.module_version} (${r.sig.hash.slice(0, 12)})`);
  console.log("a tenant approves at install:");
  for (const l of r.summary) console.log(`  ${l}`);
  return 0;
}
