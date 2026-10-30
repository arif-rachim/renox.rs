// #323: `renox publish` signs the module tree (module.sig, manifest.md 1.2)
// and uploads it; `renox add registry:…` downloads, verifies (MF15) and
// locks it with its key and signature; a tampered tree is refused; and
// `renox approve` shows the permission diff and writes the approval.

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractTar, writeTar } from "@renox/artifact-validate";

import { addModule } from "../src/commands/add.ts";
import { approve, diffPermissions } from "../src/commands/approve.ts";
import { type Io } from "../src/commands/login.ts";
import { publish } from "../src/commands/publish.ts";
import { readTree } from "../src/lib/hash.ts";
import { readLock } from "../src/lib/modules/lock.ts";
import { keyIdOf, signedTreeHash, verifySig, type ModuleSig } from "../src/lib/sign.ts";

const TOKEN = "renox_pat_abcdefghijklmnopqrstuvwxyz234567";
const { privateKey } = generateKeyPairSync("ed25519");
const PEM = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
const KEY_ID = keyIdOf(privateKey);

function moduleTree(version: string, network: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-pub-"));
  writeFileSync(
    join(dir, "module.toml"),
    `[module]\nname = "tax_gcc"\nversion = "${version}"\nisolation = "isolate"\n\n[publisher]\nname = "gulfsoft"\nkey_id = "${KEY_ID}"\n\n[permissions]\ntables = "tax_gcc__*"\nnetwork = ${JSON.stringify(network)}\n`,
  );
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "migrations/001_lines.sql"), "create table tax_gcc__lines (id text primary key);\n");
  writeFileSync(join(dir, "services.ts"), "export function rate() { return 5; }\n");
  return dir;
}

/** A registry stand-in: PUT stores the tar, GET answers the metadata, the list and the tree. */
function registry() {
  const store = new Map<string, { tar: Uint8Array; sig: ModuleSig }>();
  const io: Io = {
    env: { RENOX_TOKEN: TOKEN, RENOX_API_URL: "https://api.renox.test", XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cfg-")) },
    sleep: async () => {},
    out: () => {},
    readStdin: async () => "",
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const m = /^\/v1\/registry\/([^/]+)\/([^/]+)\/([^/]+)(\/tree)?$/u.exec(path);
      if (init?.method === "PUT" && m) {
        const key = `${m[1]}/${m[2]}@${m[3]}`;
        if (store.has(key)) return new Response("{}", { status: 409 });
        const tar = new Uint8Array(init.body as ArrayBuffer);
        const files = await extractTar(tar, { gzip: false });
        const sig = JSON.parse(new TextDecoder().decode(files.get("module.sig"))) as ModuleSig;
        store.set(key, { tar, sig });
        return new Response("{}", { status: 201 });
      }
      if (path === "/v1/registry") {
        // The newest version of each module, as listRegistryModules answers.
        const items = [...store.values()].map((v) => ({ publisher: v.sig.publisher, name: v.sig.name, version: v.sig.module_version })).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
        return Response.json({ items, next_cursor: null });
      }
      if (m) {
        const v = store.get(`${m[1]}/${m[2]}@${m[3]}`);
        if (!v) return new Response("{}", { status: 404 });
        if (m[4]) return new Response(new Blob([v.tar as BlobPart]));
        return Response.json({ publisher: m[1], name: m[2], version: m[3], hash: v.sig.hash, key_id: v.sig.key_id, disabled: null });
      }
      return new Response("{}", { status: 404 });
    },
  };
  return { io, store };
}

function appDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-app-"));
  writeFileSync(join(dir, "renox.toml"), `[app]\nname = "shop"\ntimezone = "Asia/Dubai"\n\n[modules]\n`);
  return dir;
}

test("publish signs the tree without module.sig and uploads it once", async () => {
  const tree = moduleTree("2.0.0");
  const { io, store } = registry();
  const r = await publish(tree, { io, key: PEM });
  expect(r.uploaded).toBe(true);
  const sig = JSON.parse(readFileSync(join(tree, "module.sig"), "utf8")) as ModuleSig;
  expect(sig).toMatchObject({ version: 1, publisher: "gulfsoft", name: "tax_gcc", module_version: "2.0.0", key_id: KEY_ID });
  expect(sig.hash).toBe(signedTreeHash(tree));
  expect(verifySig(sig, sig.hash)).toBe(true);
  expect(r.summary).toContain("tables: tax_gcc__*");
  expect(store.size).toBe(1);
  await expect(publish(tree, { io, key: PEM })).rejects.toThrow("already published");
  // A key that is not [publisher] key_id is refused before anything is signed.
  const other = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  await expect(publish(moduleTree("2.0.1"), { io, key: other, dryRun: true })).rejects.toThrow("is not [publisher] key_id");
  rmSync(tree, { recursive: true, force: true });
});

test("add registry: downloads, verifies and locks key_id and signature; a tampered tree is refused (MF15)", async () => {
  const { io, store } = registry();
  await publish(moduleTree("2.0.0"), { io, key: PEM });
  const project = appDir();
  expect(await addModule(project, "tax_gcc", { source: "registry:gulfsoft/tax_gcc", yes: true, io }, async () => true)).toBe(0);
  const entry = readLock(project).entries?.find((e) => e.name === "tax_gcc");
  expect(entry).toMatchObject({ source: "registry:gulfsoft/tax_gcc", key_id: KEY_ID, isolation: "isolate" });
  expect(entry?.signature).toHaveLength(86);
  // Tamper with the stored tree: the signature no longer covers it.
  const [key, v] = [...store.entries()][0] as [string, { tar: Uint8Array; sig: ModuleSig }];
  const files = await extractTar(v.tar, { gzip: false });
  files.set("services.ts", new TextEncoder().encode("export function rate() { return 0; }\n"));
  store.set(key, { ...v, tar: writeTar(files) });
  const project2 = appDir();
  await expect(addModule(project2, "tax_gcc", { source: "registry:gulfsoft/tax_gcc", yes: true, io }, async () => true)).rejects.toThrow("MF15");
  expect(readTree(project2).has("renox.lock")).toBe(false);
});

test("approve shows the permission diff of an upgrade and writes approved_version", async () => {
  expect(diffPermissions({ network: [], secrets: [], slots: [], hooks: [] }, { network: ["api.zatca.gov.sa"], secrets: [], slots: [], hooks: [] })).toEqual({ added: { network: ["api.zatca.gov.sa"] }, removed: {} });
  const { io } = registry();
  await publish(moduleTree("2.0.0"), { io, key: PEM });
  const project = appDir();
  await addModule(project, "tax_gcc", { source: "registry:gulfsoft/tax_gcc", yes: true, io }, async () => true);
  await publish(moduleTree("2.1.0", ["api.zatca.gov.sa"]), { io, key: PEM });
  // The new version reaches the cache (renox install would do the same).
  await addModule(project, "tax_gcc", { source: "registry:gulfsoft/tax_gcc", version: "^2.0", io }, async () => false).catch(() => 1);
  let shown: string[] = [];
  const r = await approve(project, "tax_gcc", async (lines) => ((shown = lines), true));
  expect(r.written).toBe(true);
  expect(shown[0]).toBe("tax_gcc 2.0.0 -> 2.1.0");
  expect(shown).toContain("  + network: api.zatca.gov.sa");
  const entry = readLock(project).entries?.find((e) => e.name === "tax_gcc");
  expect(entry).toMatchObject({ version: "2.1.0", approved_version: "2.1.0" });
  expect(entry?.approved.network).toEqual(["api.zatca.gov.sa"]);
});
