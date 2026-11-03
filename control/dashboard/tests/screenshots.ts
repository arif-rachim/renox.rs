// Screenshots of the dashboard for a design review (#427): the overview,
// an app page and the sign-in, rendered by the real worker with the data the
// real loaders returned in process against the control API (tests/helpers.ts,
// devWithData), at 1280 and 390 px, light and dark, LTR and RTL.
//
//   RENOX_WORKER_PATH=<worker> bun tests/screenshots.ts <out dir>
//
// Not a test: it writes PNGs for the PR. tests/dashboard.e2e.test.ts covers
// the same pages for correctness.
import { contentHash } from "@renox/artifact-validate";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { helloArtifact, upload } from "../../api/tests/artifacts.ts";
import { createApp_, registeredNode, tenant } from "../../api/tests/helpers.ts";
import { load as appsLoad } from "../pages/apps/index.ts";
import { load as overviewLoad } from "../pages/apps/[app]/index.ts";
import { actions as deploymentsActions } from "../pages/apps/[app]/deployments.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, addLogs, dash, devWithData, loaderCtx } from "./helpers.ts";

const out = process.argv[2] ?? join(tmpdir(), "renox-dashboard-shots");
mkdirSync(out, { recursive: true });

const d = await dash();
const owner = await tenant(d.h, "t_acme");
for (const name of ["hello", "booking", "crm"]) await createApp_(d.h, owner, name);
await registeredNode(d.h, "node-1");
await signinActions.default(actionCtx(d, "/signin", "default", { token: owner, next: "/apps" }));
const enc = new TextEncoder();
const variant = (n: number) => helloArtifact((_m, f) => f.set("code/n.json", enc.encode(String(n))));
for (const n of [1, 2]) await upload(d.h, owner, "hello", variant(n));
await deploymentsActions.activate(actionCtx(d, "/apps/hello/deployments", "activate", { hash: contentHash(variant(1)) }, { params: { app: "hello" } }));
await deploymentsActions.activate(actionCtx(d, "/apps/hello/deployments", "activate", { hash: contentHash(variant(2)) }, { params: { app: "hello" } }));
const now = Date.now();
const line = (i: number, level: "info" | "warn" | "error", message: string) => ({
  ts: now - 90_000 + i * 1000, tenant_id: "t_acme", app: "hello", deployment_hash: contentHash(variant(2)),
  request_id: `01JBQ3Z7M8K5V6W9X2Y4A1B3E${i}`, module: "pages/products/[id]", level, message, fields: null, source: "server" as const,
});
await addLogs(d.h, [line(1, "info", "GET /products/42 200 (8 ms)"), line(2, "warn", "slow query on app__orders (180 ms)"), line(3, "error", "payment provider timed out after 5000 ms"), line(4, "info", "POST /cart 303")]);

const apps = await appsLoad(loaderCtx(d, "/apps"));
const overview = await overviewLoad(loaderCtx(d, "/apps/hello", { params: { app: "hello" } }));
if (apps instanceof Response || overview instanceof Response) throw new Error("not signed in");
const dev = await devWithData({ "pages/apps/index.ts": apps, "pages/apps/[app]/index.ts": overview });
writeFileSync(join(out, "base.txt"), dev.base);
console.log(dev.base);
// Keep serving until killed; the shooting script runs outside this process.
await new Promise(() => {});
