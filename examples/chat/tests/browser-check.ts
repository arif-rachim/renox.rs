// Chromium check of examples/chat (#282) under `renox dev`: two users in a
// room see each other's messages; a private room answers 403. Screenshots
// go to ../screenshots/ (or argv[2]).
//   RENOX_WORKER_PATH=../../target/debug/renox-worker bun tests/browser-check.ts [screenshots-dir]
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDev } from "../../../cli/src/commands/dev.ts";

const app = join(import.meta.dir, "..");
const shots = process.argv[2] ?? join(app, "screenshots");
mkdirSync(shots, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "renox-chat-browser-"));
cpSync(app, dir, { recursive: true, filter: (p) => !/\/(node_modules|\.renox|tests|screenshots)(\/|$)/u.test(p.slice(app.length)) });
const port = 20000 + Math.floor(Math.random() * 20000);
const dev = await startDev({ project: dir, port, log: () => {} });
try {
  const p = Bun.spawn(["node", join(import.meta.dir, "browser-check.mjs"), shots, `http://localhost:${port}`], { stdout: "inherit", stderr: "inherit" });
  process.exitCode = await p.exited;
} finally {
  await dev.stop();
}
