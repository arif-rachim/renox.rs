// The dashboard under `renox dev` on the real worker: the build (routes,
// fragments, migration), the redirect to /signin, the sign-in page with its
// CSRF form, and ADR D23's rule that the dashboard has no exemption from
// tenant `fetch` rules: pointed at a control API on loopback, the sign-in is
// refused by the runtime (RENOX_FETCH_BLOCKED) and the API sees no request.
// Runs only when RENOX_WORKER_PATH is set: templates need `renox-worker
// transpile` (cli/README.md, "Templates").
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "../../../cli/src/commands/check.ts";
import { DEV_TENANT, startDev } from "../../../cli/src/commands/dev.ts";
import { buildArtifact } from "../../../cli/src/lib/build.ts";
import { hashDir } from "../../../cli/src/lib/hash.ts";
import { signIn } from "../lib/session.ts";
import { statements } from "./helpers.ts";

const worker = process.env.RENOX_WORKER_PATH;
const app = join(import.meta.dir, "..");
const copyFilter = (p: string): boolean => !/\/(node_modules|\.renox|tests)(\/|$)/u.test(p.slice(app.length));

test.skipIf(!worker)("renox build: every F3 screen is a page route; renox check passes", async () => {
  const out = mkdtempSync(join(tmpdir(), "renox-dashboard-build-"));
  const r = await buildArtifact(app, out);
  expect(hashDir(r.dir)).toBe(r.hash);
  expect(r.manifest.routes.map((x) => `${x.kind === "function" ? x.method : x.kind === "page" ? "PAGE" : x.kind.toUpperCase()} ${"path" in x ? x.path : x.name}`).sort()).toEqual([
    "JOB log-follower",
    "PAGE /",
    "PAGE /account/security",
    "PAGE /apps",
    "PAGE /apps/:app",
    "PAGE /apps/:app/client-errors",
    "PAGE /apps/:app/database",
    "PAGE /apps/:app/deployments",
    "PAGE /apps/:app/logs",
    "PAGE /apps/:app/modules",
    "PAGE /apps/:app/secrets",
    "PAGE /apps/:app/settings",
    "PAGE /apps/:app/usage",
    "PAGE /ops/registry",
    "PAGE /ops/tenants/:tenant",
    "PAGE /signin",
    "PAGE /signout",
    "SSE /sse/logs",
  ]);
  expect(r.manifest.templates?.["pages/apps/[app]/logs"]?.fragments).toEqual({ log_lines: { target: "log-lines" } });
  expect(r.manifest.templates?.["pages/apps/[app]/deployments"]?.fragments).toEqual({ page: { target: "page" } });
  expect(r.manifest.permissions).toEqual({ network: ["api.renox.app"], secrets: ["DASHBOARD_KEY", "OPS_CONSOLE", "RENOX_API_URL"] });
  expect(readdirSync(join(r.dir, "migrations/app")).sort()).toEqual(["001_sessions.sql", "002_log_followers.sql", "003_impersonations.sql"]);
  expect(await check(app)).toEqual({ errors: [], findings: [] });
});

test.skipIf(!worker)(
  "under renox dev: redirects to sign-in, renders the form, and a loopback control API is refused",
  async () => {
    // A real local control API that must never be reached.
    let reached = 0;
    const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (reached++, new Response("{}")) });

    const dir = mkdtempSync(join(tmpdir(), "renox-dashboard-dev-"));
    cpSync(app, dir, { recursive: true, filter: copyFilter });
    cpSync(join(app, "node_modules/renox"), join(dir, "node_modules/renox"), { recursive: true, dereference: true });
    // Point the dashboard at the local API and allowlist it: only the blocked ranges stand in the way.
    writeFileSync(
      join(dir, "renox.toml"),
      `[app]\nname = "dashboard"\ntimezone = "Asia/Dubai"\n\n[permissions]\nnetwork = ["api.renox.app", "127.0.0.1:${local.port}"]\nsecrets = ["DASHBOARD_KEY", "RENOX_API_URL"]\n`,
    );
    const KEY = "e2e-dashboard-key-0123456789abcdef";
    writeFileSync(join(dir, ".env"), `DASHBOARD_KEY=${KEY}\nRENOX_API_URL=https://127.0.0.1:${local.port}\n`);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const dev = await startDev({ project: dir, port, log: () => {} });
    const base = `http://localhost:${port}`;
    try {
      const home = await fetch(`${base}/`, { redirect: "manual" });
      expect(home.status).toBe(303);
      expect(home.headers.get("location")).toBe("/apps");
      for (const path of ["/apps", "/apps/shop/logs?level=warn"]) {
        const r = await fetch(`${base}${path}`, { redirect: "manual" });
        expect(r.status).toBe(303);
        expect(r.headers.get("location")).toBe(`/signin?next=${encodeURIComponent(path)}`);
      }

      const page = await fetch(`${base}/signin?next=/apps/shop`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("<h1>Sign in</h1>");
      expect(html).toContain(`127.0.0.1:${local.port}`);
      expect(html).toContain('name="next" value="/apps/shop"');
      expect(page.headers.get("content-security-policy")).toContain("script-src");
      const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0] as string);
      const jar = cookies.join("; ");
      const csrf = /name="_csrf" value="([^"]+)"/u.exec(html)?.[1] ?? "";
      expect(csrf.length).toBeGreaterThan(20);

      const token = `renox_pat_${"a".repeat(32)}`;
      const form = (fields: Record<string, string>) => ({
        method: "POST",
        headers: { cookie: jar, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
        redirect: "manual" as const,
      });
      // Without the CSRF token no tenant code runs.
      expect((await fetch(`${base}/signin`, form({ token }))).status).toBe(403);

      /** docs/24-threat-model.md B, "SSRF to metadata, loopback, private ranges"; ADR D23: no exemption for the dashboard. */
      const refused = await fetch(`${base}/signin`, form({ _csrf: csrf, token, next: "/apps" }));
      expect(refused.status).toBe(200);
      const body = await refused.text();
      expect(body).toContain("The control API could not be reached (RENOX_FETCH_BLOCKED).");
      expect(body).not.toContain(token);
      expect(reached).toBe(0);

      // A malformed token never leaves the dashboard.
      const malformed = await (await fetch(`${base}/signin`, form({ _csrf: csrf, token: "hunter2" }))).text();
      expect(malformed).toContain("That is not a Renox token");

      // Signed in (a row written with Bun's WebCrypto, read by the worker's):
      // every screen renders through the worker, with the refusal shown in place.
      const sid = (cookies.find((c) => c.startsWith("__Host-renox_sid=")) ?? "").slice("__Host-renox_sid=".length).split(".")[0] as string;
      const sqlite = new Database(join(dir, ".renox/data", DEV_TENANT, "app.db"));
      await signIn(statements(sqlite), { DASHBOARD_KEY: KEY }, sid, token, Date.now());
      sqlite.close();
      for (const path of ["/apps", "/apps/shop", "/apps/shop/deployments", "/apps/shop/logs?live=1", "/apps/shop/usage?range=7d", "/apps/shop/secrets"]) {
        const r = await fetch(`${base}${path}`, { headers: { cookie: jar }, redirect: "manual" });
        expect(`${path} ${r.status}`).toBe(`${path} 200`);
        const text = await r.text();
        expect(text).toContain("could not be reached (RENOX_FETCH_BLOCKED)");
        expect(text).toContain("Sign out");
        if (path !== "/apps") expect(text).toContain('<a href="/apps/shop/logs"');
        expect(text).not.toContain(token);
      }
      // The live poll asks for the log_lines fragment only.
      const frag = await (await fetch(`${base}/apps/shop/logs?live=1`, { headers: { cookie: jar, "hx-request": "true", "hx-target": "log-lines" } })).text();
      expect(frag.startsWith('<div id="log-lines">')).toBe(true);
      expect(frag).not.toContain("<html");
      expect(reached).toBe(0);
    } finally {
      await dev.stop();
      local.stop(true);
    }
  },
  120_000,
);
