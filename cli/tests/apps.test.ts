// renox apps list | rm | restore (#536; docs/contracts/deploy-api.md 0.7
// section 3): the typed confirmation, --yes, --json, the exit codes (2 on a
// mismatch with zero API calls, 1 on a restore past the window), against a
// fake API and against the in-process control API.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentHash } from "@renox/artifact-validate";
import { named, upload } from "../../control/api/tests/artifacts.ts";
import { createApp_, harness, registeredNode, tenant, type Harness } from "../../control/api/tests/helpers.ts";
import { run as apps, when, type AppsIo } from "../src/commands/apps.ts";
import { CliError, EXIT } from "../src/errors.ts";

const API = "https://api.test";
const TOKEN = `renox_pat_${"a".repeat(32)}`;
const DAY = 86_400_000;

interface Call {
  method: string;
  path: string;
  body: string | null;
}

type FakeIo = AppsIo & { lines: string[]; errs: string[]; calls: Call[]; asked: string[] };

/** An Io whose API answers `answer(call)`; `typed` is what the user types at the prompt. */
function fake(answer: (c: Call) => Response, typed = ""): FakeIo {
  const lines: string[] = [];
  const errs: string[] = [];
  const calls: Call[] = [];
  const asked: string[] = [];
  return {
    lines,
    errs,
    calls,
    asked,
    env: { RENOX_TOKEN: TOKEN, RENOX_API_URL: API, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cfg-")) },
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    ask: async (prompt) => {
      asked.push(prompt);
      return typed;
    },
    sleep: async () => {},
    readStdin: async () => "",
    fetch: async (url, init) => {
      const call = { method: init?.method ?? "GET", path: url.slice(API.length), body: typeof init?.body === "string" ? init.body : null };
      calls.push(call);
      return answer(call);
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => json(404, { error: { code: "RENOX_NOT_FOUND", message: "Not found.", request_id: "01JBQ3Z7MA0000000000000013" } });
const DELETED = { name: "shop", deleted_at: 1_793_400_000_000, restorable_until: 1_793_400_000_000 + 7 * DAY };

async function failure(p: Promise<unknown>): Promise<CliError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CliError);
  return e as CliError;
}

describe("renox apps rm", () => {
  test("asks for the name; the typed name deletes and prints the restore line", async () => {
    const io = fake(() => json(200, DELETED), "shop\r\n");
    expect(await apps(["rm", "shop"], io)).toBe(EXIT.OK);
    expect(io.asked).toHaveLength(1);
    expect(io.asked[0]).toContain("restored for 7 days");
    expect(io.calls).toEqual([{ method: "DELETE", path: "/v1/apps/shop", body: JSON.stringify({ confirm: "shop" }) }]);
    expect(io.lines).toEqual([`shop deleted. Restorable until ${when(DELETED.restorable_until)} with: renox apps restore shop`]);
    expect(io.lines.join("\n")).not.toContain(TOKEN);
  });

  test("a mismatch exits 2 with zero API calls", async () => {
    const io = fake(() => {
      throw new Error("no call expected");
    }, "shpo");
    expect(await apps(["rm", "shop"], io)).toBe(EXIT.VALIDATION);
    expect(io.calls).toEqual([]);
    expect(io.errs.join("\n")).toContain("nothing was deleted");
    // An empty answer (stdin closed) is a mismatch too.
    const closed = fake(() => {
      throw new Error("no call expected");
    });
    expect(await apps(["rm", "shop"], closed)).toBe(EXIT.VALIDATION);
    expect(closed.calls).toEqual([]);
  });

  test("--yes skips the question; --json prints the API's answer", async () => {
    const io = fake(() => json(200, DELETED));
    expect(await apps(["rm", "shop", "--yes", "--json"], io)).toBe(EXIT.OK);
    expect(io.asked).toEqual([]);
    expect(JSON.parse(io.lines[0] as string)).toEqual(DELETED);
  });

  test("an API refusal is exit 1 with the API's message; a bad name or argument is refused before any call", async () => {
    const io = fake(() => json(403, { error: { code: "RENOX_TOKEN_SCOPE", message: "The token does not allow this operation.", request_id: "01JBQ3Z7MA0000000000000015" } }));
    const e = await failure(apps(["rm", "shop", "--yes"], io));
    expect(e.exitCode).toBe(EXIT.USER);
    expect(e.message).toContain("RENOX_TOKEN_SCOPE");
    const none = fake(() => {
      throw new Error("no call expected");
    });
    for (const args of [["rm"], ["rm", "Shop"], ["rm", "a", "b"], ["rm", "shop", "--force"], ["restore", "shop", "--yes"], ["nope"], []]) {
      expect((await failure(apps(args, none))).exitCode).toBe(EXIT.USER);
    }
    expect(none.calls).toEqual([]);
  });
});

describe("renox apps restore and list", () => {
  test("restore prints the URL; --json the app; a 404 says the window may have passed and exits 1", async () => {
    const app = { name: "shop", tenant_id: "t_cli", created_at: 1, active_deployment: "a".repeat(64), hostnames: ["shop.renoxium.app"] };
    const io = fake(() => json(200, app));
    expect(await apps(["restore", "shop"], io)).toBe(EXIT.OK);
    expect(io.calls).toEqual([{ method: "POST", path: "/v1/apps/shop/restore", body: null }]);
    expect(io.lines).toEqual(["shop restored: https://shop.renoxium.app"]);
    const j = fake(() => json(200, app));
    expect(await apps(["restore", "shop", "--json"], j)).toBe(EXIT.OK);
    expect(JSON.parse(j.lines[0] as string)).toEqual(app);
    const gone = fake(() => notFound());
    const e = await failure(apps(["restore", "shop"], gone));
    expect(e.exitCode).toBe(EXIT.USER);
    expect(e.message).toBe("no app shop, or the restore window has passed");
  });

  test("list is one request and one table; --deleted asks for the deleted ones", async () => {
    const io = fake((c) =>
      c.path === "/v1/apps"
        ? json(200, { apps: [{ name: "shop", tenant_id: "t", created_at: 1, active_deployment: "b".repeat(64), hostnames: ["shop.renoxium.app"] }] })
        : json(200, { apps: [{ name: "old", tenant_id: "t", created_at: 1, active_deployment: null, hostnames: ["old.renoxium.app"], deleted_at: DELETED.deleted_at, restorable_until: DELETED.restorable_until }] }),
    );
    expect(await apps(["list"], io)).toBe(EXIT.OK);
    expect(io.calls).toHaveLength(1);
    expect(io.lines[0]).toContain("shop");
    expect(io.lines[0]).toContain("https://shop.renoxium.app");
    io.lines.length = 0;
    expect(await apps(["list", "--deleted"], io)).toBe(EXIT.OK);
    expect(io.calls.map((c) => c.path)).toEqual(["/v1/apps", "/v1/apps?deleted=true"]);
    expect(io.lines[0]).toContain(`restorable until ${when(DELETED.restorable_until)}`);
  });
});

describe("renox apps against the control API", () => {
  async function setup(): Promise<{ h: Harness; io: FakeIo }> {
    const h = await harness();
    const token = await tenant(h, "t_cli");
    await registeredNode(h, "node-1");
    await createApp_(h, token, "shop");
    const files = named("shop");
    expect((await upload(h, token, "shop", files)).status).toBe(201);
    expect((await h.request("POST", "/v1/apps/shop/activate", { token, json: { hash: contentHash(files) } })).status).toBe(200);
    const io = fake(() => new Response(null, { status: 500 }), "shop");
    io.env.RENOX_TOKEN = token;
    io.fetch = async (url, init) => {
      const u = new URL(url);
      const headers = Object.fromEntries(new Headers(init?.headers));
      return h.request(init?.method ?? "GET", `${u.pathname}${u.search}`, { headers, ...(init?.body === undefined ? {} : { body: init.body as BodyInit }) });
    };
    return { h, io };
  }

  test("rm, list --deleted, restore, list; after 7 days restore is 404 (exit 1)", async () => {
    const { h, io } = await setup();
    expect(await apps(["rm", "shop"], io)).toBe(EXIT.OK);
    expect(io.lines.at(-1)).toContain("shop deleted. Restorable until");
    expect(await apps(["list"], io)).toBe(EXIT.OK);
    expect(io.lines.at(-1)).toContain("No apps yet");
    expect(await apps(["list", "--deleted"], io)).toBe(EXIT.OK);
    expect(io.lines.at(-1)).toContain("shop");
    expect(await apps(["restore", "shop"], io)).toBe(EXIT.OK);
    expect(io.lines.at(-1)).toBe("shop restored: https://shop.renox.app");
    expect(await apps(["rm", "shop", "--yes"], io)).toBe(EXIT.OK);
    h.clock.now += 8 * DAY;
    expect((await failure(apps(["restore", "shop"], io))).exitCode).toBe(EXIT.USER);
  });
});
