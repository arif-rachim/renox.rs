// The developer journey end to end (#587, epic #575): one test walks a new
// developer from sign-up to tenant erasure against the real control API (as a
// process, its mail in a file outbox), a renox-worker in controlled mode, the
// real CLI as a process and Chromium, so a break in any joint between sign-up,
// login, deploy, export, the dashboard, modules and deletion fails journey.yml.
//
// The dashboard runs under `renox dev` on the real worker. Its browser side
// (sign-up, the verification link, device approval: public/account.js) talks
// to the local API as in production. Its server side cannot: tenant `fetch`
// refuses loopback and private addresses for the dashboard as for every tenant
// (ADR D23), and trusts only public CAs. So the pages that read the API on the
// server (logs, client errors, the app list with its restorable apps) run
// their real loaders and the Restore action here, against the same API, and
// the browser checks what the real dashboard renders from that data
// (control/dashboard/tests/helpers.ts, devWithData).
//
// Runs under RENOX_JOURNEY=1 with RENOX_WORKER_PATH and PLAYWRIGHT_PATH
// (`make journey`, docs/12-developer-experience.md "Browser tests"); skipped
// otherwise, so `make ts-test` is unchanged.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { journeyMissing, loadPlaywright, type PwBrowser, type PwPage } from "../../control/dashboard/tests/playwright.ts";
import { actionCtx, dashDb, devWithData, loaderCtx, SECRETS, statements, type Dash } from "../../control/dashboard/tests/helpers.ts";
import { signIn } from "../../control/dashboard/lib/session.ts";
import { GRANTABLE_SCOPES, ROLE_GRANTABLE } from "../../control/dashboard/lib/scopes.ts";
import * as appsPage from "../../control/dashboard/pages/apps/index.ts";
import * as logsPage from "../../control/dashboard/pages/apps/[app]/logs.ts";
import * as errorsPage from "../../control/dashboard/pages/apps/[app]/client-errors.ts";
import { CSRF_HEADER, csrfOf, SESSION_COOKIE } from "../../control/api/src/auth/sessions.ts";
import { freePort } from "./free-port.ts";

const repo = join(import.meta.dir, "../..");
const main = join(import.meta.dir, "../src/main.ts");
const worker = process.env.RENOX_WORKER_PATH || undefined;
const journey = process.env.RENOX_JOURNEY === "1";
const pw = journey ? loadPlaywright() : null;

const DOMAIN = "renox.test";
const APP = "journey";
const HOST = `${APP}.${DOMAIN}`;
const PASSWORD = "correct horse battery journey";

const missing = journeyMissing(pw, worker);
if (missing !== null) {
  test("the developer journey can run (RENOX_JOURNEY=1)", () => {
    throw new Error(missing);
  });
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const b32 = (n: number): string => [...randomBytes(n)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");

/** Polls `f` until it returns a value; `ms` is a hang guard. */
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
function get(port: number, host: string, path: string): Promise<{ status: number; body: string; requestId: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
      });
      res.on("end", () => ok({ status: res.statusCode ?? 0, body, requestId: String(res.headers["x-renox-request-id"] ?? "") }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** Rejects after `ms`: a hang guard to race a promise against (no long sleep). */
function guard(what: string, ms: number): Promise<never> {
  return new Promise((_, fail) => {
    setTimeout(() => fail(new Error(`timed out waiting for ${what}`)), ms).unref();
  });
}

/** Reads a process's stdout until `re` matches the text so far. */
async function readUntil(stream: ReadableStream<Uint8Array>, re: RegExp, ms: number): Promise<{ match: RegExpExecArray; text: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const hang = guard(`${re}`, ms);
  try {
    for (;;) {
      const m = re.exec(text);
      if (m !== null) return { match: m, text };
      const chunk = await Promise.race([reader.read(), hang]);
      if (chunk.done) throw new Error(`no ${re} in: ${text}`);
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

const procs: { kill: () => void }[] = [];
const stops: (() => Promise<void>)[] = [];
let browser: PwBrowser | undefined;
afterAll(async () => {
  await browser?.close();
  for (const s of stops) await s().catch(() => {});
  for (const p of procs) p.kill();
});

describe.skipIf(!worker || !journey || pw === null)("the developer journey", () => {
  test(
    "sign-up, renox login, new, deploy, export, logs, client errors, add auth, delete and restore, tenant erasure",
    async () => {
      const t0 = Date.now();
      const step = (name: string) => console.log(`journey: ${name} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      const root = mkdtempSync(join(tmpdir(), "renox-journey-"));
      const outbox = join(root, "outbox");
      const apiPort = freePort();
      const api = `http://localhost:${apiPort}`;
      const nodePort = freePort();
      const dashPort = freePort();
      const operator = `renox_op_${b32(32)}`;

      // The control API, its emails in a file outbox; the dashboard's origin for links and CORS.
      const apiProc = Bun.spawn(["bun", join(repo, "control/api/src/main.ts")], {
        env: {
          ...process.env,
          CONTROL_DATABASE_URL: process.env.RENOX_TEST_PG ?? "pglite:memory",
          CONTROL_LISTEN_HOST: "127.0.0.1",
          CONTROL_LISTEN_PORT: String(apiPort),
          CONTROL_NODE_LISTEN_HOST: "127.0.0.1",
          CONTROL_NODE_LISTEN_PORT: String(nodePort),
          CONTROL_OPERATOR_TOKEN_SHA256: sha256(operator),
          CONTROL_MASTER_KEY: randomBytes(32).toString("base64"),
          CONTROL_PLATFORM_DOMAIN: DOMAIN,
          CONTROL_DASHBOARD_URL: `http://localhost:${dashPort}`,
          CONTROL_MAIL_OUTBOX_DIR: outbox,
        },
        stdout: "ignore",
        stderr: Bun.file(join(root, "api.log")),
      });
      procs.push(apiProc);
      await until("the control API", 60_000, async () => ((await fetch(`${api}/v1/healthz`)).ok ? true : undefined));

      // A node for the free tier, and the worker on it.
      const node = await fetch(`${api}/v1/admin/nodes`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify({ node_id: "node-journey-1" }) });
      expect(node.status).toBe(201);
      const tokenFile = join(root, "node.token");
      writeFileSync(tokenFile, ((await node.json()) as { token: string }).token, { mode: 0o600 });
      const port = freePort();
      const health = freePort();
      const exportListen = freePort();
      const w = join(root, "worker");
      writeFileSync(
        join(root, "worker.toml"),
        `mode = "controlled"
listen = "127.0.0.1:${port}"
node_id = "node-journey-1"
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
node_listen = "127.0.0.1:${exportListen}"
[sandbox]
allow_unsandboxed = true
`,
      );
      procs.push(Bun.spawn([worker as string, "--config", join(root, "worker.toml")], { stdout: "ignore", stderr: Bun.file(join(root, "worker.log")) }));
      await until("the worker", 60_000, async () => ((await fetch(`http://127.0.0.1:${health}/healthz`)).ok ? true : undefined));

      // The dashboard under renox dev, its browser side pointed at the local API.
      // /device checks the dashboard sign-in on the server, the hop the worker
      // refuses here: its loader is the stub account.browser.test.ts uses.
      const frame = { signed_in: true, impersonation: null, api_host: `localhost:${apiPort}`, ops_on: false, nav: "tokens" };
      const dash1 = await devWithData(
        { "pages/device.ts": { ...frame, api, code: "", grantable_json: JSON.stringify(ROLE_GRANTABLE), signin_href: "/signin?next=%2Fdevice" } },
        { port: dashPort, env: { RENOX_API_URL: api } },
      );
      stops.push(dash1.stop);

      // Chromium: the app's hostname resolves to the worker; the dashboard's CSP
      // names the production API only, so it is bypassed for the local one.
      browser = await pw!.chromium.launch({ args: [`--host-resolver-rules=MAP *.${DOMAIN} 127.0.0.1`] });
      const ctx = await browser.newContext({ bypassCSP: true });
      const p: PwPage = await ctx.newPage();
      const pageErrors: string[] = [];
      p.on("pageerror", (e) => pageErrors.push(String(e)));
      // The dashboard's POST /signin checks the token on the server (refused here): catch it.
      let signedIn: (token: string) => void = () => {};
      const dashboardToken = new Promise<string>((r) => {
        signedIn = r;
      });
      await p.route("**/signin", async (route) => {
        const req = route.request();
        if (req.method() !== "POST") return route.continue();
        signedIn(new URLSearchParams(req.postData() ?? "").get("token") ?? "");
        return route.fulfill({ status: 200, contentType: "text/html", body: "<p>signed in</p>" });
      });

      // (a) Sign up in the browser, open the verification link from the mail, land signed in.
      step("sign-up");
      const email = `journey-${b32(6)}@example.test`;
      await p.goto(`${dash1.base}/signup`);
      await p.fill('#signup-form [name="email"]', email);
      await p.fill('#signup-form [name="password"]', PASSWORD);
      await p.fill('#signup-form [name="tenant_name"]', "Journey Test");
      const tenantId = await p.inputValue('#signup-form [name="tenant_id"]');
      expect(tenantId).toBe("journey-test");
      await p.check('#signup-form [name="dpa"]');
      await p.click('#signup-form button[type="submit"]');
      await p.waitForSelector("#signup-sent:not([hidden])", { timeout: 10_000 });
      const mail = await until("the verification mail", 10_000, async () => {
        const f = existsSync(outbox) ? readdirSync(outbox).find((n) => n.endsWith("-verify_email.txt")) : undefined;
        return f === undefined ? undefined : readFileSync(join(outbox, f), "utf8");
      });
      expect(mail).toContain(`To: ${email}`);
      const verify = /\/signup\/verify#token=([a-z2-7]{32})/u.exec(mail);
      expect(verify).not.toBeNull();
      await p.goto(`${dash1.base}/signup/verify#token=${verify?.[1]}`);
      const token = await dashboardToken;
      expect(token).toMatch(/^renox_pat_[a-z2-7]{32}$/u);
      expect((await fetch(`${api}/v1/apps`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

      // (b) renox login as a process: the browser opens the device page and approves.
      step("renox login");
      const home = join(root, "home");
      mkdirSync(home);
      const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== "RENOX_TOKEN" && e[0] !== "RENOX_API_URL" && e[0] !== "XDG_CONFIG_HOME"));
      env.HOME = home;
      const loginProc = Bun.spawn(["bun", main, "login", "--api", api], { env, stdout: "pipe", stderr: "pipe" });
      procs.push(loginProc);
      const { match } = await readUntil(loginProc.stdout, /Open (\S+\/device\?code=([A-Z]{4}-[A-Z]{4}))\n/u, 30_000);
      expect(match[1]?.startsWith(`http://localhost:${dashPort}/device`)).toBe(true);
      const userCode = match[2] as string;
      await p.goto(`${dash1.base}/device`);
      await p.fill('#device-code [name="code"]', userCode);
      await p.click('#device-code button[type="submit"]');
      await p.waitForSelector("#device-request:not([hidden])", { timeout: 10_000 });
      expect(await p.textContent("#device-user-code")).toBe(userCode);
      expect(await p.locator('#device-scopes input[name="scope"]').count()).toBe(GRANTABLE_SCOPES.length);
      await p.click("#device-approve");
      await p.waitForSelector("#device-approved:not([hidden])", { timeout: 10_000 });
      expect(await Promise.race([loginProc.exited, guard("renox login to exit", 30_000)])).toBe(0);
      const creds = JSON.parse(readFileSync(join(home, ".config/renox/credentials.json"), "utf8")) as { api: string; token: string; tenant_id: string };
      expect(creds).toMatchObject({ api, tenant_id: tenantId });

      const cli = (args: string[], cwd: string) => {
        const r = Bun.spawnSync(["bun", main, ...args], { cwd, env });
        return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
      };

      // (c) renox new from the hello template, on this repository's SDK; bun install.
      step("renox new");
      const work = join(root, "work");
      mkdirSync(work);
      const made = cli(["new", APP, "--template", "hello"], work);
      expect(made.code, made.err).toBe(0);
      const app = join(work, APP);
      const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as { dependencies: Record<string, string> };
      pkg.dependencies["@renoxium/sdk"] = `file:${join(repo, "sdk")}`;
      writeFileSync(join(app, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      // One route that writes a log line: a static page writes none.
      writeFileSync(join(app, "functions/api/journey.ts"), 'import type { Handler } from "@renoxium/sdk";\n\nexport const GET = ((ctx) => {\n  ctx.log.info("journey log line");\n  return Response.json({ ok: true });\n}) satisfies Handler;\n');
      const installed = Bun.spawnSync(["bun", "install"], { cwd: app, env });
      expect(installed.exitCode, installed.stderr.toString()).toBe(0);

      // (d) renox deploy: live on its hostname.
      step("renox deploy");
      const d1 = cli(["deploy"], app);
      expect(d1.code, d1.err).toBe(0);
      expect(d1.out).toContain(`Live: https://${HOST}`);
      expect((await until("the app on the worker", 15_000, async () => {
        const r = await get(port, HOST, "/");
        return r.status === 200 ? r : undefined;
      })).body).toContain(`${APP} is running`);

      // renox export: a runnable copy with its worker.toml and the database.
      step("renox export");
      const exported = join(root, "export");
      // The test API has no object store that presigns: the export URLs it signs are
      // `https://api.<domain>/v1/exports/...`; a preload sends them to the local API
      // (as export-selfhost.e2e.test.ts does). Nothing else of the CLI changes.
      const preload = join(root, "export-url-preload.ts");
      writeFileSync(preload, `const realFetch = globalThis.fetch;\nglobalThis.fetch = ((input: any, init?: any) => {\n  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;\n  return realFetch(u.replace("https://api.${DOMAIN}/", ${JSON.stringify(`${api}/`)}), init);\n}) as typeof fetch;\n`);
      const exr = Bun.spawnSync(["bun", "--preload", preload, main, "export", "--out", exported], { cwd: app, env });
      expect(exr.exitCode, exr.stderr.toString()).toBe(0);
      expect(existsSync(join(exported, "worker.toml"))).toBe(true);
      expect(readdirSync(exported, { recursive: true }).map(String).some((f) => f.endsWith(".db"))).toBe(true);

      // (e) A request that logs; the dashboard's logs page shows its line.
      step("logs");
      const hit = await get(port, HOST, "/api/journey");
      expect(hit.status).toBe(200);
      const d: Dash = { h: undefined as never, sqlite: dashDb(), calls: { sent: [] }, sessionId: "JOURNEYJOURNEYJOURNEY0", secrets: SECRETS };
      // The dashboard's loaders and actions call the API's public origin: here, the local API.
      d.fetch = (input, init) => {
        const req = new Request(input, init);
        return fetch(new Request(req.url.replace("https://api.renoxium.com", api), req));
      };
      await signIn(statements(d.sqlite as Database), SECRETS, d.sessionId, token, Date.now());
      const logs = await until("the request's log line in the dashboard", 30_000, async () => {
        const data = (await logsPage.load(loaderCtx(d, `/apps/${APP}/logs`, { params: { app: APP } }))) as { lines?: { message: string; request_id: string }[] };
        return data.lines?.some((l) => l.message === "journey log line") ? data : undefined;
      });

      // (f) A page whose script throws: the browser reports it; the client-errors page groups it.
      step("client errors");
      writeFileSync(join(app, "pages/boom.html"), '<r-layout use="main">\n  <h1>boom</h1>\n  <script>\n    throw new Error("journey boom");\n  </script>\n</r-layout>\n');
      const d2 = cli(["deploy"], app);
      expect(d2.code, d2.err).toBe(0);
      await until("the boom page", 15_000, async () => ((await get(port, HOST, "/boom")).status === 200 ? true : undefined));
      const appPage = await ctx.newPage();
      await appPage.goto(`http://${HOST}:${port}/boom`);
      const errors = await until("the client error in the dashboard", 30_000, async () => {
        const data = (await errorsPage.load(loaderCtx(d, `/apps/${APP}/client-errors`, { params: { app: APP } }))) as { groups?: { message: string }[] };
        return data.groups?.some((g) => g.message.includes("journey boom")) ? data : undefined;
      });

      // (g) renox add auth, deploy: the module's sign-in page answers.
      step("renox add auth");
      const add = cli(["add", "auth", "--yes"], app);
      expect(add.code, add.err).toBe(0);
      const d3 = cli(["deploy"], app);
      expect(d3.code, d3.err).toBe(0);
      await until("/auth/login", 15_000, async () => ((await get(port, HOST, "/auth/login")).status === 200 ? true : undefined));

      // (h) renox apps rm: not served, restorable in the dashboard; Restore serves it again.
      step("delete and restore");
      const rm = cli(["apps", "rm", APP, "--yes"], app);
      expect(rm.code, rm.err).toBe(0);
      expect(rm.out).toContain("Restorable until");
      await until("the app gone from the worker", 15_000, async () => ((await get(port, HOST, "/")).status === 404 ? true : undefined));
      const apps = (await appsPage.load(loaderCtx(d, "/apps"))) as { deleted: { name: string }[] };
      expect(apps.deleted.map((a) => a.name)).toEqual([APP]);

      // What the real dashboard renders from that data, in Chromium.
      const dash2 = await devWithData(
        { "pages/apps/[app]/logs.ts": logs, "pages/apps/[app]/client-errors.ts": errors, "pages/apps/index.ts": apps },
        { env: { RENOX_API_URL: api } },
      );
      stops.push(dash2.stop);
      await p.goto(`${dash2.base}/apps/${APP}/logs`);
      await p.waitForSelector(`#log-rows tr:has-text("journey log line")`, { timeout: 10_000 });
      await p.goto(`${dash2.base}/apps/${APP}/client-errors`);
      await p.waitForSelector(`tr:has-text("journey boom")`, { timeout: 10_000 });
      await p.goto(`${dash2.base}/apps`);
      await p.waitForSelector(`#deleted-apps tr:has-text("${APP}")`, { timeout: 10_000 });
      // Restore: the page's action, against the API.
      const restored = (await appsPage.actions.restore(actionCtx(d, "/apps", "restore", { name: APP }))) as { restored: string | null; restore_problem: unknown };
      expect(restored.restore_problem).toBeNull();
      expect(restored.restored).toContain(APP);
      await until("the app served again", 15_000, async () => ((await get(port, HOST, "/")).status === 200 ? true : undefined));

      // (i) Delete it again.
      step("delete again");
      const rm2 = cli(["apps", "rm", APP, "--yes"], app);
      expect(rm2.code, rm2.err).toBe(0);
      expect(rm2.out).toContain("Restorable until");

      // (j) Tenant erasure by the owner, with the browser's session and its CSRF
      // token: the CLI's token stops working.
      step("tenant erasure");
      const cookie = (await ctx.cookies([api])).find((c) => c.name === SESSION_COOKIE)?.value;
      expect(cookie).toBeDefined();
      const erase = await fetch(`${api}/v1/tenants/${tenantId}`, {
        method: "DELETE",
        headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrfOf(cookie as string), "content-type": "application/json" },
        body: JSON.stringify({ confirm: tenantId }),
      });
      expect(erase.status, await erase.clone().text()).toBe(202);
      await until("the CLI token refused", 30_000, async () => ((await fetch(`${api}/v1/apps`, { headers: { authorization: `Bearer ${creds.token}` } })).status === 401 ? true : undefined));
      expect(pageErrors).toEqual([]);
      step("done");
    },
    240_000,
  );
});
