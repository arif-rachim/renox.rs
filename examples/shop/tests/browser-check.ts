// Manual browser check of the shop pages (#45): starts `renox dev` on a
// copy of the shop, seeds it, and runs browser-check.mjs in Node with
// Playwright's Chromium. Not part of `bun test` (it needs a browser and the
// worker):
//
//   RENOX_WORKER_PATH=../../target/debug/renox-worker bun tests/browser-check.ts [screenshots-dir]
//
// The screenshots in ../screenshots/ were taken this way.
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDev } from "../../../cli/src/commands/dev.ts";

const app = join(import.meta.dir, "..");
const shots = process.argv[2] ?? join(app, "screenshots");
mkdirSync(shots, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "renox-shop-browser-"));
cpSync(app, dir, { recursive: true, filter: (p) => !/\/(node_modules|\.renox|tests|screenshots)(\/|$)/u.test(p.slice(app.length)) });
cpSync(join(app, "node_modules"), join(dir, "node_modules"), { recursive: true, dereference: true });
const port = 20000 + Math.floor(Math.random() * 20000);
const dev = await startDev({ project: dir, port, log: () => {} });
try {
  await fetch(`http://localhost:${port}/api/dev/seed`, { method: "POST" });
  // Async spawn: the dev proxy runs in this process and must keep serving.
  const p = Bun.spawn(["node", join(import.meta.dir, "browser-check.mjs"), shots, `http://localhost:${port}`], { stdout: "inherit", stderr: "inherit" });
  process.exitCode = await p.exited;
} finally {
  await dev.stop();
}
