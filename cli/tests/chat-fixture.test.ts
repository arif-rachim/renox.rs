// examples/chat as a CLI fixture (#282), as the shop is: `renox build`
// gives an artifact with the `ws` route, its guard and the policy files;
// `renox check` passes; `renox test` runs its tests and policy cases.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "../src/commands/check.ts";
import { runTests } from "../src/commands/test.ts";
import { buildArtifact } from "../src/lib/build.ts";

const worker = process.env.RENOX_WORKER_PATH;
const chat = join(import.meta.dir, "../../examples/chat");

test.skipIf(!worker)("examples/chat: the ws route and the policies in the artifact; renox check passes", async () => {
  const r = await buildArtifact(chat, mkdtempSync(join(tmpdir(), "renox-chat-build-")));
  const ws = r.manifest.routes.find((x) => x.kind === "ws");
  expect(ws).toMatchObject({ kind: "ws", path: "/ws/chat/:room", module: "functions/ws/chat/[room]", guard: { action: "room.enter" } });
  expect(existsSync(join(r.dir, "policies/app/chat.cedar"))).toBe(true);
  expect(r.manifest.authz?.actions).toEqual(["room.enter", "room.join"]);
  expect((await check(chat)).errors).toEqual([]);
});

test.skipIf(!worker)(
  "examples/chat: renox test passes (two users in a room, a private room refused, the policy cases)",
  async () => {
    const r = await runTests(chat, [], "pipe");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("3 pass");
    expect(r.out).toContain("(pass) policy policies/tests/chat.json: a private room, not a member -> deny");
  },
  180_000,
);
