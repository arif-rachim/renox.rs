// The Logs page lists a server stack's frames at their original TypeScript
// position, with the bundled position beside it (#261), from what the real
// control API (in process) answers for a deployment with an uploaded map.
import { afterEach, describe, expect, test } from "bun:test";
import { contentHash, writeTar } from "@renox/artifact-validate";

import { helloArtifact, upload } from "../../api/tests/artifacts.ts";
import { assertScoped, createApp_, tenant } from "../../api/tests/helpers.ts";
import { frameRows, load } from "../pages/apps/[app]/logs.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actionCtx, addLogs, dash, loaderCtx } from "./helpers.ts";

afterEach(assertScoped);

const MAP = JSON.stringify({ version: 3, sources: ["functions/api/hello.ts"], names: [], mappings: ";;UAMG" });

describe("logs: server frames (#261)", () => {
  test("a RENOX_INTERNAL line shows its frames, original first; the raw stack is not repeated", async () => {
    const d = await dash();
    const owner = await tenant(d.h, "t_hello");
    await createApp_(d.h, owner, "hello");
    const files = helloArtifact();
    expect((await upload(d.h, owner, "hello", files)).status).toBe(201);
    const hash = contentHash(files);
    const tar = writeTar(new Map([["functions/api/hello.js.map", new TextEncoder().encode(MAP)]]));
    expect((await d.h.request("PUT", `/v1/apps/hello/deployments/${hash}/sourcemaps`, { token: owner, body: tar, headers: { "content-type": "application/x-tar" } })).status).toBeLessThan(300);
    expect(await signinActions.default(actionCtx(d, "/signin", "default", { token: owner, next: "/apps" }))).toBeInstanceOf(Response);
    const stack = "Error: boom\n    at loadCart (file:///functions/api/hello.js:3:11)\n    at file:///functions/api/hello.js:9:2";
    await addLogs(d.h, [
      { ts: Date.now() - 1_000, tenant_id: "t_hello", app: "hello", deployment_hash: hash, request_id: "01JBQ3Z7M8K5V6W9X2Y4A1B3C9", module: "functions/api/hello", level: "error", message: "handler threw", fields: { code: "RENOX_INTERNAL", stack }, source: "server" },
    ]);
    const page = (await load(loaderCtx(d, "/apps/hello/logs", { params: { app: "hello" } }))) as { lines: { frames: unknown; fields: string }[] };
    expect(page.lines[0]?.frames).toEqual([
      { fn: "loadCart", at: "functions/api/hello.ts:7:4", bundled: "/functions/api/hello.js:3:11" },
      { fn: "(anonymous)", at: "/functions/api/hello.js:9:2", bundled: null },
    ]);
    expect(page.lines[0]?.fields).toBe('{"code":"RENOX_INTERNAL"}');
  });

  test("frames that are not well formed are skipped", () => {
    expect(frameRows(null)).toEqual([]);
    expect(frameRows({ frames: [{ file: 1 }, { file: "/a.js", line: 1, column: 2, function: null, original: null }] })).toEqual([{ fn: "(anonymous)", at: "/a.js:1:2", bundled: null }]);
  });
});
