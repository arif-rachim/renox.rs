// renox logs prints a server stack's frames at their original positions and,
// with --raw, the bundled position under each, dimmed (#261).

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Io } from "../src/commands/login.ts";
import { formatLine, run as logs, type LogLine } from "../src/commands/logs.ts";
import { EXIT } from "../src/errors.ts";

const LINE: LogLine = {
  ts: 1793318400000,
  deployment_hash: "a".repeat(64),
  request_id: "01JBQ3Z7M8K5V6W9X2Y4A1B3C5",
  module: "functions/api/hello",
  level: "error",
  message: "handler threw",
  fields: {
    code: "RENOX_INTERNAL",
    stack: "Error: boom\n    at loadCart (file:///functions/api/hello.js:3:11)",
    frames: [
      { file: "/functions/api/hello.js", line: 3, column: 11, function: "loadCart", original: { file: "functions/api/hello.ts", line: 7, column: 4 } },
      { file: "/functions/api/hello.js", line: 9, column: 2, function: null, original: null },
    ],
  },
  source: "server",
};

describe("server frames", () => {
  test("the original frame is printed; the raw one only under --raw, dimmed", () => {
    const plain = formatLine(LINE).split("\n");
    expect(plain).toHaveLength(3);
    expect(plain[0]).toContain('{"code":"RENOX_INTERNAL"}');
    expect(plain[0]).not.toContain("stack");
    expect(plain[1]).toBe("    at loadCart (functions/api/hello.ts:7:4)");
    expect(plain[2]).toBe("    at (/functions/api/hello.js:9:2)");
    const raw = formatLine(LINE, { raw: true }).split("\n");
    expect(raw[1]).toBe("    at loadCart (functions/api/hello.ts:7:4)");
    expect(raw[2]).toBe("\u001b[2m       bundled /functions/api/hello.js:3:11\u001b[22m");
    // A frame without an original has nothing to add.
    expect(raw[3]).toBe("    at (/functions/api/hello.js:9:2)");
    expect(formatLine(LINE, { raw: true, color: false }).split("\n")[2]).toBe("       bundled /functions/api/hello.js:3:11");
  });

  test("a line without frames prints as before", () => {
    const line = { ...LINE, fields: { code: "RENOX_INTERNAL", stack: "Error: boom" } };
    expect(formatLine(line)).toBe(`2026-10-30T00:00:00.000Z  error  functions/api/hello  handler threw {"code":"RENOX_INTERNAL","stack":"Error: boom"}  (01JBQ3Z7M8K5V6W9X2Y4A1B3C5)`);
  });

  test("--raw through the command, NO_COLOR honoured", async () => {
    const lines: string[] = [];
    const io: Io = {
      env: { RENOX_TOKEN: `renox_pat_${"a".repeat(32)}`, RENOX_API_URL: "https://api.test", XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cfg-")), NO_COLOR: "1" },
      out: (l) => lines.push(l),
      sleep: async () => {},
      readStdin: async () => "",
      fetch: async () => new Response(`event: log\nid: 1-0\ndata: ${JSON.stringify(LINE)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    };
    expect(await logs(["--app", "hello", "--raw"], io)).toBe(EXIT.OK);
    expect(lines[0]?.split("\n")).toEqual([expect.stringContaining("handler threw"), "    at loadCart (functions/api/hello.ts:7:4)", "       bundled /functions/api/hello.js:3:11", "    at (/functions/api/hello.js:9:2)"]);
  });
});
