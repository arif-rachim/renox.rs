// A deployed app, exported, runs on its own (#674; docs/self-host.md). The CLI as
// a process, the real control API (control/api, PGlite unless RENOX_TEST_PG), a
// `renox-worker` in controlled mode with one node, as in deploy.e2e.test.ts.
// examples/hello (no pages, no file storage of its own) is copied to a temp
// folder with two test-only additions: a page and a POST action that stores one
// file. It is deployed, a file is stored, `renox export --out <tmp>` runs, and
// `renox-worker --config <tmp>/worker.toml` (only `listen` rewritten to a free
// port) answers 200 on the app's hostname with the stored file in the export.
// Needs RENOX_WORKER_PATH (skips locally without it, fails in CI: worker-env.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freePort } from "./free-port.ts";
import { testWorker } from "./worker-env.ts";

const repo = join(import.meta.dir, "../..");
const main = join(import.meta.dir, "../src/main.ts");
const worker = testWorker();

const b32 = (n: number): string => [...randomBytes(n)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

async function until<T>(what: string, ms: number, f: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** A request with a Host header (fetch does not let one through). */
function send(port: number, host: string, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
      });
      res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

const PAGE = "Hello from the export";
const KEY = "app/notes/e2e.txt"; // the app's own prefix is app/ (ops.md section 21)
const BYTES = "stored before the export\n";

/** examples/hello in a temp folder with a page and a test-only action that stores one file. */
function hello(): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-e2e-selfhost-app-"));
  const src = join(repo, "examples/hello");
  cpSync(src, dir, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(".renox") });
  mkdirSync(join(dir, "node_modules"));
  for (const name of readdirSync(join(src, "node_modules"))) {
    symlinkSync(realpathSync(join(src, "node_modules", name)), join(dir, "node_modules", name));
  }
  mkdirSync(join(dir, "pages"), { recursive: true });
  writeFileSync(join(dir, "pages/index.html"), `<!doctype html>\n<html><head><title>${PAGE}</title></head><body><h1>${PAGE}</h1></body></html>\n`);
  writeFileSync(
    join(dir, "functions/api/e2e-store.ts"),
    `import type { Handler } from "@renoxium/sdk";\n\nexport const POST: Handler = async ({ storage }) => {\n  const f = await storage.put(${JSON.stringify(KEY)}, new TextEncoder().encode(${JSON.stringify(BYTES)}), { contentType: "text/plain" });\n  return Response.json({ key: f.key });\n};\n`,
  );
  return dir;
}

const procs: { kill: () => void }[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
});

describe.skipIf(worker === undefined)("renox export, then renox-worker on the export directory", () => {
  test(
    "the exported app answers 200 and the stored file is in the export with the same bytes",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "renox-e2e-selfhost-"));
      const apiPort = freePort();
      const api = `http://127.0.0.1:${apiPort}`;
      const nodePort = freePort();
      const operator = `renox_op_${b32(32)}`;
      const apiProc = Bun.spawn(["bun", join(repo, "control/api/src/main.ts")], {
        env: {
          ...process.env,
          CONTROL_DATABASE_URL: process.env.RENOX_TEST_PG ?? "pglite:memory",
          CONTROL_LISTEN_PORT: String(apiPort),
          CONTROL_NODE_LISTEN_HOST: "127.0.0.1",
          CONTROL_NODE_LISTEN_PORT: String(nodePort),
          CONTROL_OPERATOR_TOKEN_SHA256: sha256(operator),
          CONTROL_MASTER_KEY: randomBytes(32).toString("base64"),
          CONTROL_PLATFORM_DOMAIN: "renox.test",
        },
        stdout: "ignore",
        stderr: Bun.file(join(root, "api.log")),
      });
      procs.push(apiProc);
      await until("the control API", 60_000, async () => ((await fetch(`${api}/v1/healthz`)).ok ? true : undefined));

      const op = (path: string, body: unknown) => fetch(`${api}${path}`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const tenantId = "t-hello";
      const tenant = await op("/v1/admin/tenants", { tenant_id: tenantId, name: "hello", tier: "paid" });
      expect(tenant.status).toBe(201);
      const t = (await tenant.json()) as { token: string | { token: string } };
      const token = typeof t.token === "string" ? t.token : t.token.token;
      const node = await op("/v1/admin/nodes", { node_id: "node-selfhost-1" });
      expect(node.status).toBe(201);
      const tokenFile = join(root, "node.token");
      writeFileSync(tokenFile, ((await node.json()) as { token: string }).token, { mode: 0o600 });

      const port = freePort();
      const health = freePort();
      const listen = freePort();
      const w = join(root, "worker");
      writeFileSync(
        join(root, "worker.toml"),
        `mode = "controlled"
listen = "127.0.0.1:${port}"
node_id = "node-selfhost-1"
data_dir = "${w}/data"
artifacts_dir = "${w}/artifacts"
meters_dir = "${w}/meters"
logs_dir = "${w}/logs"
fetch_blocked_addresses = ["203.0.113.250"]
[gateway]
rate_limit_per_ip = 100000.0
rate_limit_burst = 100000
max_connections_per_ip = 1000
[control]
url = "http://127.0.0.1:${nodePort}"
node_token_file = "${tokenFile}"
health_listen = "127.0.0.1:${health}"
node_listen = "127.0.0.1:${listen}"
[sandbox]
allow_unsandboxed = true
`,
      );
      const nodeProc = Bun.spawn([worker as string, "--config", join(root, "worker.toml")], { stdout: "ignore", stderr: Bun.file(join(root, "worker.log")) });
      procs.push(nodeProc);
      await until("the node worker", 60_000, async () => {
        const res = await fetch(`http://127.0.0.1:${health}/healthz`);
        return res.ok ? true : undefined;
      });

      const env = { ...process.env, RENOX_TOKEN: token, RENOX_API_URL: api, XDG_CONFIG_HOME: root };
      // The test API has no object store that can presign, so the export URLs it signs
      // are `https://api.renox.test/v1/exports/...` (CONTROL_PLATFORM_DOMAIN): a preload
      // sends those to the API on loopback. Nothing else of the CLI changes.
      const preload = join(root, "export-url-preload.ts");
      writeFileSync(preload, `const realFetch = globalThis.fetch;\nglobalThis.fetch = ((input: any, init?: any) => {\n  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;\n  return realFetch(u.replace("https://api.renox.test/", ${JSON.stringify(`${api}/`)}), init);\n}) as typeof fetch;\n`);
      const cli = (args: string[], cwd: string) => {
        const p = Bun.spawnSync(["bun", "--preload", preload, main, ...args], { cwd, env });
        return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
      };
      const host = "hello.renox.test";

      // Deploy, then store one file through the test-only action.
      const dep = cli(["deploy", "--json"], hello());
      expect(dep.code, dep.err).toBe(0);
      await until("the page on the node", 10_000, async () => {
        const r = await send(port, host, "GET", "/");
        return r.status === 200 ? r : undefined;
      });
      const stored = await until("the file stored", 10_000, async () => {
        const r = await send(port, host, "POST", "/api/e2e-store");
        return r.status === 200 ? r : undefined;
      });
      expect(JSON.parse(stored.body)).toEqual({ key: KEY });

      // Export (read through the API and the node's export listener).
      const out = join(root, "export");
      const exp = cli(["export", "--app", "hello", "--out", out, "--json"], root);
      expect(exp.code, exp.err).toBe(0);
      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { tenant_id: string; hostnames: string[] };
      expect(manifest.tenant_id).toBe(tenantId);
      expect(manifest.hostnames).toContain(host);
      const filePath = join(out, "data/files/tenants", tenantId, "files", KEY);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe(BYTES);

      // Run the export directory on its own worker: only `listen` changes.
      const own = freePort();
      const tomlPath = join(out, "worker.toml");
      const toml = readFileSync(tomlPath, "utf8");
      expect(toml).toContain('listen = "127.0.0.1:8080"');
      writeFileSync(tomlPath, toml.replace('listen = "127.0.0.1:8080"', `listen = "127.0.0.1:${own}"`));
      const ownProc = Bun.spawn([worker as string, "--config", tomlPath], { cwd: out, stdout: "ignore", stderr: Bun.file(join(root, "own-worker.log")) });
      procs.push(ownProc);
      const page = await until("the exported app", 60_000, async () => {
        const r = await send(own, host, "GET", "/");
        return r.status === 200 ? r : undefined;
      });
      expect(page.body).toContain(`<title>${PAGE}</title>`);
      expect(readFileSync(filePath, "utf8")).toBe(BYTES);

      // Stop it: the process is gone.
      ownProc.kill();
      await Promise.race([ownProc.exited, Bun.sleep(10_000)]);
      expect(ownProc.exitCode !== null || ownProc.signalCode !== null).toBe(true);
      expect(() => process.kill(ownProc.pid, 0)).toThrow();
    },
    240_000,
  );
});
