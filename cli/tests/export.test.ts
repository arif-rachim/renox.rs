// renox export (#673) against a fake control plane (docs/contracts/deploy-api.md 0.8 section 14).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentHash, writeTar } from "@renox/artifact-validate";

import { helloArtifact } from "../../control/api/tests/artifacts.ts";
import type { Io } from "../src/commands/login.ts";
import { run as exportApp } from "../src/commands/export.ts";
import { CliError, EXIT } from "../src/errors.ts";
import { PINNED_WORKER } from "../src/worker/verify.ts";

const TOKEN = `renox_pat_${"a".repeat(32)}`;
const API = "https://api.test";
const TENANT = "t_acme";
const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const signed = (kind: string) => `https://exports.test/v1/exports/${kind}?expires=1793318700000&sig=${"f".repeat(64)}`;

const ART = helloArtifact((m) => ((m.app as Record<string, string>).name = "shop"));
const HASH = contentHash(ART);
const ART_TAR = new Uint8Array(Bun.gzipSync(writeTar(ART)));

function sqliteBytes(): Uint8Array<ArrayBuffer> {
  const dir = mkdtempSync(join(tmpdir(), "renox-exp-db-"));
  const db = new Database(join(dir, "x.db"));
  db.exec("CREATE TABLE app__notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO app__notes (body) VALUES ('hello');");
  db.close();
  return new Uint8Array(readFileSync(join(dir, "x.db")));
}
const DB = sqliteBytes();

const KEYS = new Map([
  ["a.txt", "alpha"],
  ["img/b.png", "bravo"],
  ["img/c/d.png", "charlie"],
]);
const filesTar = (entries: Map<string, string>): Uint8Array<ArrayBuffer> => new Uint8Array(Bun.gzipSync(writeTar(new Map([...entries].map(([k, v]) => [k, enc.encode(v)])))));
const GOOD_FILES = filesTar(new Map([...KEYS].map(([k, v]) => [`tenants/${TENANT}/files/${k}`, v])));

interface Call {
  method: string;
  url: string;
  headers: Headers;
}

interface Plane {
  files?: Uint8Array<ArrayBuffer>;
  filesSha?: string;
}

function fake(plane: Plane = {}): Io & { lines: string[]; calls: Call[] } {
  const lines: string[] = [];
  const calls: Call[] = [];
  const files = plane.files ?? GOOD_FILES;
  const answer = (kind: string, bytes: Uint8Array<ArrayBuffer>, extra: object, sha256 = sha(bytes)) =>
    new Response(JSON.stringify({ url: signed(kind), expires_at: 1793318700000, created_at: 1793318400000, size_bytes: bytes.length, sha256, kind, ...extra }), { status: 201, headers: { "content-type": "application/json" } });
  return {
    lines,
    calls,
    env: { RENOX_TOKEN: TOKEN, RENOX_API_URL: API, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cfg-")) },
    out: (l) => lines.push(l),
    sleep: async () => {},
    readStdin: async () => "",
    fetch: async (url, init) => {
      const call = { method: init?.method ?? "GET", url, headers: new Headers(init?.headers) };
      calls.push(call);
      const r = (): Response | undefined => {
        if (url === `${API}/v1/apps/shop`) return Response.json({ name: "shop", tenant_id: TENANT, created_at: 1, active_deployment: HASH, hostnames: ["shop.renoxium.app", "shop.example.com"] });
        if (url === `${API}/v1/apps/shop/backups/export`) return answer("database", DB, { masking: "none" });
        if (url === `${API}/v1/apps/shop/files/export`) return answer("files", files, { files: KEYS.size }, plane.filesSha);
        if (url === `${API}/v1/apps/shop/deployments/${HASH}/export`) return answer("artifact", ART_TAR, { hash: HASH });
        if (url === `${API}/v1/apps/shop/secrets`) return Response.json({ version: 2, secrets: [{ name: "STRIPE_KEY", updated_at: 1 }, { name: "SMTP_PASSWORD", updated_at: 2 }] });
        if (url === signed("database")) return new Response(DB);
        if (url === signed("files")) return new Response(files);
        if (url === signed("artifact")) return new Response(ART_TAR);
        return undefined;
      };
      const res = r();
      if (res === undefined) throw new Error(`unexpected ${call.method} ${url}`);
      return res;
    },
  };
}

async function failure(p: Promise<unknown>): Promise<CliError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CliError);
  return e as CliError;
}

const listing = (dir: string, prefix = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listing(join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`]));
const cwd = () => mkdtempSync(join(tmpdir(), "renox-exp-"));

describe("renox export", () => {
  test("writes the directory the worker runs, every file checked", async () => {
    const dir = cwd();
    const t = fake();
    expect(await exportApp(["--out", "out", "--app", "shop"], t, dir)).toBe(EXIT.OK);
    const out = join(dir, "out");
    const artifactFiles = [...ART.keys()].map((k) => `artifact/${HASH}/${k}`);
    expect(listing(out).sort()).toEqual(
      [
        "manifest.json",
        "routes.json",
        "worker.toml",
        "platform.key",
        "secrets.txt",
        ...artifactFiles,
        `data/${TENANT}/app.db`,
        `data/${TENANT}/secrets.json`,
        ...[...KEYS.keys()].map((k) => `data/files/tenants/${TENANT}/files/${k}`),
      ].sort(),
    );
    expect(new Uint8Array(readFileSync(join(out, "data", TENANT, "app.db")))).toEqual(DB);
    expect(readFileSync(join(out, "data", TENANT, "secrets.json"), "utf8")).toBe("{}");
    expect(statSync(join(out, "data", TENANT, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(out, "platform.key")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(out, "platform.key"), "utf8")).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(join(out, "data/files/tenants", TENANT, "files/img/c/d.png"), "utf8")).toBe("charlie");
    expect(readFileSync(join(out, "secrets.txt"), "utf8")).toBe(`# values are not exported; set them in data/${TENANT}/secrets.json before starting\nSTRIPE_KEY\nSMTP_PASSWORD\n`);
    const toml = readFileSync(join(out, "worker.toml"), "utf8");
    for (const line of ['listen = "127.0.0.1:8080"', 'data_dir = "data"', 'artifacts_dir = "artifact"', 'routes_file = "routes.json"', 'meters_dir = "meters"', 'logs_dir = "logs"', 'platform_key_file = "platform.key"', "idle_timeout_secs = 600", "[jobs]", "enabled = true"]) expect(toml).toContain(line);
    const routes = JSON.parse(readFileSync(join(out, "routes.json"), "utf8")) as { version: number; entries: { hostname: string; tenant_id: string; deployment_hash: string; status: string }[] };
    expect(routes.version).toBe(0);
    expect(routes.entries.map((e) => e.hostname)).toEqual(["shop.renoxium.app", "shop.example.com", "127.0.0.1"]);
    for (const e of routes.entries) expect([e.tenant_id, e.deployment_hash, e.status]).toEqual([TENANT, HASH, "active"]);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      renox_export: 1,
      app: "shop",
      tenant_id: TENANT,
      hostnames: ["shop.renoxium.app", "shop.example.com"],
      hash: HASH,
      worker_version: PINNED_WORKER.version,
      files: { count: 3, sha256: sha(GOOD_FILES) },
      database: { size_bytes: DB.length, sha256: sha(DB) },
      artifact: { sha256: sha(ART_TAR) },
    });
    expect(Array.isArray(manifest.modules)).toBe(true);
    // The signed URLs are fetched without the API token.
    for (const c of t.calls.filter((c) => c.url.startsWith("https://exports.test/"))) expect(c.headers.get("authorization")).toBeNull();
    for (const c of t.calls.filter((c) => c.url.startsWith(API))) expect(c.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(t.lines.some((l) => l.includes("Files: 3 files"))).toBe(true);
  });

  test("--json prints one object", async () => {
    const dir = cwd();
    const t = fake();
    expect(await exportApp(["--out", "out", "--app", "shop", "--json"], t, dir)).toBe(EXIT.OK);
    expect(t.lines).toHaveLength(1);
    expect(JSON.parse(t.lines[0] as string)).toEqual({ out: "out", hash: HASH, database: { sha256: sha(DB) }, files: { sha256: sha(GOOD_FILES) }, artifact: { sha256: sha(ART_TAR) } });
  });

  test("the default --out carries the app and the UTC time", async () => {
    const dir = cwd();
    expect(await exportApp(["--app", "shop"], fake(), dir)).toBe(EXIT.OK);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readdirSync(dir)[0]).toMatch(/^shop-export-\d{8}T\d{6}Z$/u);
  });

  test("a files tar whose sha256 differs is exit 3 and out/ is removed", async () => {
    const dir = cwd();
    const e = await failure(exportApp(["--out", "out", "--app", "shop"], fake({ filesSha: "0".repeat(64) }), dir));
    expect(e.exitCode).toBe(EXIT.ENVIRONMENT);
    expect(e.message).toContain("does not match");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("an existing empty --out is emptied again, not removed", async () => {
    const dir = cwd();
    mkdirSync(join(dir, "out"));
    const e = await failure(exportApp(["--out", "out", "--app", "shop"], fake({ filesSha: "0".repeat(64) }), dir));
    expect(e.exitCode).toBe(EXIT.ENVIRONMENT);
    expect(readdirSync(join(dir, "out"))).toEqual([]);
  });

  for (const name of ["../x", "tenants/other/files/x", `tenants/${TENANT}/files/../../x`, `/tenants/${TENANT}/files/x`]) {
    test(`a tar entry named ${name} is exit 3 and nothing is kept`, async () => {
      const dir = cwd();
      const tar = filesTar(new Map([[`tenants/${TENANT}/files/ok.txt`, "ok"], [name, "evil"]]));
      const e = await failure(exportApp(["--out", "out", "--app", "shop"], fake({ files: tar }), dir));
      expect(e.exitCode).toBe(EXIT.ENVIRONMENT);
      expect(existsSync(join(dir, "out"))).toBe(false);
      expect(existsSync(join(dir, "x"))).toBe(false);
    });
  }

  test("a key over 100 bytes (a pax path header) is unpacked", async () => {
    const dir = cwd();
    const key = `${"long-".repeat(30)}.txt`;
    const tar = filesTar(new Map([[`tenants/${TENANT}/files/${key}`, "long"]]));
    const t = fake({ files: tar });
    const orig = t.fetch;
    t.fetch = async (url, init) => {
      const res = await orig(url, init);
      if (url !== `${API}/v1/apps/shop/files/export`) return res;
      return Response.json({ ...((await res.json()) as object), files: 1 }, { status: 201 });
    };
    expect(await exportApp(["--out", "out", "--app", "shop"], t, dir)).toBe(EXIT.OK);
    expect(readFileSync(join(dir, "out/data/files/tenants", TENANT, "files", key), "utf8")).toBe("long");
  });

  test("a non-empty --out is refused before any request", async () => {
    const dir = cwd();
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "keep.txt"), "x");
    const t = fake();
    const e = await failure(exportApp(["--out", "out", "--app", "shop"], t, dir));
    expect(e.exitCode).toBe(EXIT.USER);
    expect(t.calls).toEqual([]);
    expect(readFileSync(join(dir, "out", "keep.txt"), "utf8")).toBe("x");
  });

  test("bad arguments are user errors", async () => {
    const t = fake();
    for (const args of [["--bogus"], ["extra"], ["--out"], ["--app", "Bad_Name"]]) expect((await failure(exportApp(args, t, cwd()))).exitCode).toBe(EXIT.USER);
    expect(t.calls).toEqual([]);
  });
});
