// #444 in `renox dev`: a function handler that returns something other than
// a Response gets one tenant-log line naming the route and the value's type
// (`reason: "handler_result"`), and the terminal prints it with the fix.
// The worker side is crates/renox-runtime/tests/dispatch.rs
// (`handler_result_names_the_type_never_the_value`); this needs a worker
// with that change (CI builds it from the commit when crates/ change).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handlerResultHint, startDev } from "../src/commands/dev.ts";
import { newApp } from "../src/commands/new.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();

test("the hint names the fix for the common mistakes", () => {
  expect(handlerResultHint("undefined")).toStartWith("did you forget `return`?");
  expect(handlerResultHint("object")).toStartWith("use Response.json(value)");
  expect(handlerResultHint("array")).toStartWith("use Response.json(value)");
  expect(handlerResultHint("string")).toStartWith("use new Response(text)");
  expect(handlerResultHint("number")).toStartWith("return a Response");
});

test.skipIf(!worker)(
  "renox dev prints the route, the type and the hint; the client gets the plain 500",
  async () => {
    const dir = newApp("result", "hello", mkdtempSync(join(tmpdir(), "renox-result-")));
    writeFileSync(join(dir, "functions/api/hello.ts"), "export const GET = async () => 41 + 1;\n");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const lines: string[] = [];
    const dev = await startDev({ project: dir, port, log: (l) => lines.push(l) });
    try {
      const r = await fetch(`http://localhost:${port}/api/hello`);
      expect(r.status).toBe(500);
      const body = (await r.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RENOX_INTERNAL");
      expect(JSON.stringify(body)).not.toContain("42");
      for (let i = 0; i < 30 && !lines.some((l) => l.includes("hint:")); i++) await Bun.sleep(100);
      const at = lines.findIndex((l) => l.startsWith("[error] GET /api/hello returned number, not a Response"));
      expect(at, lines.join("\n")).toBeGreaterThanOrEqual(0);
      expect(lines[at]).toContain('"reason":"handler_result","name":"number"');
      expect(lines[at + 1]).toBe("    hint: return a Response, e.g. Response.json(value) or new Response(body, { status })");
    } finally {
      await dev.stop();
    }
  },
  60_000,
);
