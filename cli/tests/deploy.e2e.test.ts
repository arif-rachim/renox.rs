// `renox deploy` end to end (#58): the CLI as a process, the real control API
// (`control/api`, on RENOX_TEST_PG when set, else its in-process PGlite and
// in-memory artifact store), and a `renox-worker` in controlled mode.
// examples/shop is deployed and answers 200 on its hostname; a second version
// goes live; `renox deploy --rollback` brings the first one back. Needs
// RENOX_WORKER_PATH (skips locally without it, fails in CI: tests/worker-env.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { testWorker } from "./worker-env.ts";

const repo = join(import.meta.dir, "../..");
const main = join(import.meta.dir, "../src/main.ts");
const worker = testWorker();

const b32 = (n: number): string => [...randomBytes(n)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

async function until<T>(what: string, ms: number, f: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** GET `path` on the worker with a Host header (fetch does not let a Host header through). */
function get(port: number, host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
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

/** examples/shop in a temp folder, its node_modules links made absolute, plus a version route. */
function shop(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), `renox-e2e-shop-${version}-`));
  const src = join(repo, "examples/shop");
  cpSync(src, dir, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(".renox") && !p.includes("screenshots") });
  mkdirSync(join(dir, "node_modules"));
  for (const name of readdirSync(join(src, "node_modules"))) {
    const link = join(src, "node_modules", name);
    symlinkSync(realpathSync(resolve(dirname(link), readlinkSync(link))), join(dir, "node_modules", name));
  }
  writeFileSync(join(dir, "functions/api/e2e-version.ts"), `export const GET = () => new Response(${JSON.stringify(version)});\n`);
  return dir;
}

const procs: { kill: () => void }[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
});

describe.skipIf(worker === undefined)("renox deploy against the control API and a worker", () => {
  test(
    "examples/shop goes live, a new version replaces it, --rollback brings it back",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "renox-e2e-"));
      const apiPort = await freePort();
      const api = `http://127.0.0.1:${apiPort}`;
      const operator = `renox_op_${b32(32)}`;
      const apiProc = Bun.spawn(["bun", join(repo, "control/api/src/main.ts")], {
        env: {
          ...process.env,
          CONTROL_DATABASE_URL: process.env.RENOX_TEST_PG ?? "pglite:memory",
          CONTROL_LISTEN_PORT: String(apiPort),
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
      const tenant = await op("/v1/admin/tenants", { tenant_id: "t-shop", name: "shop", tier: "paid" });
      expect(tenant.status).toBe(201);
      const t = (await tenant.json()) as { token: string | { token: string } };
      const token = typeof t.token === "string" ? t.token : t.token.token;
      const node = await op("/v1/admin/nodes", { node_id: "node-cli-1" });
      expect(node.status).toBe(201);
      const tokenFile = join(root, "node.token");
      writeFileSync(tokenFile, ((await node.json()) as { token: string }).token, { mode: 0o600 });

      const port = await freePort();
      const health = await freePort();
      const w = join(root, "worker");
      writeFileSync(
        join(root, "worker.toml"),
        `mode = "controlled"
listen = "127.0.0.1:${port}"
node_id = "node-cli-1"
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
url = "${api}"
node_token_file = "${tokenFile}"
health_listen = "127.0.0.1:${health}"
`,
      );
      const workerProc = Bun.spawn([worker as string, "--config", join(root, "worker.toml")], { stdout: "ignore", stderr: Bun.file(join(root, "worker.log")) });
      procs.push(workerProc);
      await until("the worker", 60_000, async () => ((await fetch(`http://127.0.0.1:${health}/healthz`)).ok ? true : undefined));

      const env = { ...process.env, RENOX_TOKEN: token, RENOX_API_URL: api, XDG_CONFIG_HOME: root };
      const cli = (args: string[], cwd: string) => {
        const p = Bun.spawnSync(["bun", main, ...args], { cwd, env });
        return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
      };
      const host = "shop.renox.test";

      // v1: first deploy creates the app and goes live.
      const v1 = cli(["deploy", "--json"], shop("v1"));
      expect(v1.code, v1.err).toBe(0);
      const s1 = JSON.parse(v1.out) as { hash: string; previous: string | null; url: string; stages: Record<string, number>; total_ms: number };
      expect(s1.previous).toBeNull();
      expect(s1.url).toBe(`https://${host}`);
      console.log(`deploy v1: ${JSON.stringify(s1.stages)} total ${s1.total_ms} ms`);
      expect((await until("v1 on the worker", 10_000, async () => {
        const r = await get(port, host, "/api/e2e-version");
        return r.body === "v1" ? r : undefined;
      })).status).toBe(200);
      expect((await get(port, host, "/")).status).toBe(200);

      // v2 replaces it; the human output names the rollback command.
      const v2 = cli(["deploy"], shop("v2"));
      expect(v2.code, v2.err).toBe(0);
      expect(v2.out).toContain(`Live: https://${host}`);
      expect(v2.out).toContain(`Rollback: renox deploy --rollback ${s1.hash.slice(0, 12)}`);
      await until("v2 on the worker", 10_000, async () => ((await get(port, host, "/api/e2e-version")).body === "v2" ? true : undefined));

      // --rollback (no hash): v1 serves again.
      const rb = cli(["deploy", "--rollback", "--app", "shop", "--json"], root);
      expect(rb.code, rb.err).toBe(0);
      const r = JSON.parse(rb.out) as { hash: string; total_ms: number };
      expect(r.hash).toBe(s1.hash);
      console.log(`rollback: total ${r.total_ms} ms`);
      await until("v1 again on the worker", 5_000, async () => ((await get(port, host, "/api/e2e-version")).body === "v1" ? true : undefined));

      // Secrets: set and list never print the value.
      const value = `e2e-${b32(24)}`;
      const set = Bun.spawnSync(["bun", main, "secrets", "set", "E2E_KEY", "--app", "shop"], { cwd: root, env, stdin: new TextEncoder().encode(`${value}\n`) });
      expect(set.exitCode, set.stderr.toString()).toBe(0);
      const list = cli(["secrets", "list", "--app", "shop"], root);
      expect(list.code).toBe(0);
      expect(list.out).toContain("E2E_KEY");
      for (const o of [set.stdout.toString(), set.stderr.toString(), list.out, list.err]) expect(o).not.toContain(value);

      // A bad token is exit 1 and says what to do.
      const bad = Bun.spawnSync(["bun", main, "deploy", "--rollback", "--app", "shop"], { cwd: root, env: { ...env, RENOX_TOKEN: `renox_pat_${b32(32)}` } });
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr.toString()).toContain("renox login");
    },
    240_000,
  );
});
