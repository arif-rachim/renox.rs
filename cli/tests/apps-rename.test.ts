// renox apps rename (#537; docs/contracts/deploy-api.md 0.7 section 3): the
// request, the output, the renox.toml offer (--yes, a typed answer, CRLF and
// LF kept, only the value changed), the refusals before any call, and, against
// the in-process control API, `renox deploy` from a renox.toml that still has
// the old name: it stops with `renamed to <new>; update renox.toml` and
// creates nothing; once renox.toml is updated the deploy goes through.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harness, registeredNode, tenant, type Harness } from "../../control/api/tests/helpers.ts";
import { run as apps, setTomlAppName, type AppsIo } from "../src/commands/apps.ts";
import { run as deploy } from "../src/commands/deploy.ts";
import { CliError, EXIT } from "../src/errors.ts";

const repo = join(import.meta.dir, "../..");
const API = "https://api.test";
const TOKEN = `renox_pat_${"a".repeat(32)}`;

interface Call {
  method: string;
  path: string;
  body: string | null;
}

type FakeIo = AppsIo & { lines: string[]; errs: string[]; calls: Call[]; asked: string[] };

function fake(answer: (c: Call) => Response, typed = "", cwd = mkdtempSync(join(tmpdir(), "renox-noapp-"))): FakeIo {
  const lines: string[] = [];
  const errs: string[] = [];
  const calls: Call[] = [];
  const asked: string[] = [];
  return {
    lines,
    errs,
    calls,
    asked,
    cwd,
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
const apiError = (status: number, code: string, details?: unknown[]) => json(status, { error: { code, message: "x", request_id: "01JBQ3Z7MA0000000000000013", ...(details === undefined ? {} : { details }) } });
const STORE = { name: "store", tenant_id: "t_cli", created_at: 1, active_deployment: "a".repeat(64), hostnames: ["store.renoxium.app", "www.shop.example"] };

async function failure(p: Promise<unknown>): Promise<CliError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CliError);
  return e as CliError;
}

/** A folder with a renox.toml of `text`. */
function folder(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-app-"));
  writeFileSync(join(dir, "renox.toml"), text);
  return dir;
}

describe("renox apps rename", () => {
  test("one request; prints the new URL and that the old hostname is no longer served", async () => {
    const io = fake(() => json(200, STORE));
    expect(await apps(["rename", "shop", "store"], io)).toBe(EXIT.OK);
    expect(io.calls).toEqual([{ method: "POST", path: "/v1/apps/shop/rename", body: JSON.stringify({ name: "store" }) }]);
    expect(io.lines).toEqual(["shop renamed to store: https://store.renoxium.app", "  https://shop.renoxium.app is no longer served; its users sign in again on https://store.renoxium.app"]);
    expect(io.asked).toEqual([]);
    const j = fake(() => json(200, STORE));
    expect(await apps(["rename", "shop", "store", "--json"], j)).toBe(EXIT.OK);
    expect(JSON.parse(j.lines[0] as string)).toEqual({ ...STORE, renamed_from: "shop", renox_toml: "none" });
  });

  test("404 and 409 are exit 1 with a plain message; bad arguments are refused before any call", async () => {
    const gone = await failure(apps(["rename", "shop", "store"], fake(() => apiError(404, "RENOX_NOT_FOUND"))));
    expect([gone.exitCode, gone.message]).toEqual([EXIT.USER, "no app shop"]);
    const taken = await failure(apps(["rename", "shop", "store"], fake(() => apiError(409, "RENOX_CONFLICT", [{ field: "name", reason: "not available" }]))));
    expect([taken.exitCode, taken.message]).toEqual([EXIT.USER, "the name store is not available"]);
    const busy = await failure(apps(["rename", "shop", "store"], fake(() => apiError(409, "RENOX_CONFLICT", [{ field: "app", reason: "import in progress" }]))));
    expect(busy.message).toContain("import in progress");
    const scope = await failure(apps(["rename", "shop", "store"], fake(() => apiError(403, "RENOX_TOKEN_SCOPE"))));
    expect(scope.exitCode).toBe(EXIT.USER);
    const none = fake(() => {
      throw new Error("no call expected");
    });
    for (const args of [["rename"], ["rename", "shop"], ["rename", "shop", "Store"], ["rename", "Shop", "store"], ["rename", "shop", "shop"], ["rename", "a", "b", "c"], ["rename", "shop", "store", "--deleted"]]) {
      expect([args.join(" "), (await failure(apps(args, none))).exitCode]).toEqual([args.join(" "), EXIT.USER]);
    }
    expect(none.calls).toEqual([]);
  });

  test("in the app's folder: --yes updates [app] name and nothing else, CRLF kept", async () => {
    const before = '# my shop\r\n[app]\r\nname = "shop"   # the slug\r\ntimezone = "Asia/Dubai"\r\n\r\n[modules]\r\nname = "shop"\r\n';
    const dir = folder(before);
    const io = fake(() => json(200, STORE), "", dir);
    expect(await apps(["rename", "shop", "store", "--yes"], io)).toBe(EXIT.OK);
    expect(io.asked).toEqual([]);
    expect(readFileSync(join(dir, "renox.toml"), "utf8")).toBe(before.replace('name = "shop"   #', 'name = "store"   #'));
    expect(io.lines).toContain('  renox.toml: [app] name = "store"');
  });

  test("without --yes it asks: y updates (LF kept), anything else keeps renox.toml and says what to change", async () => {
    const lf = "[app]\nname = 'shop'\n";
    const yes = folder(lf);
    const a = fake(() => json(200, STORE), "y\r\n", yes);
    expect(await apps(["rename", "shop", "store"], a)).toBe(EXIT.OK);
    expect(a.asked).toEqual(['Update [app] name in renox.toml to "store"? [y/N] ']);
    expect(readFileSync(join(yes, "renox.toml"), "utf8")).toBe("[app]\nname = 'store'\n");
    const no = folder(lf);
    const b = fake(() => json(200, STORE), "", no);
    expect(await apps(["rename", "shop", "store"], b)).toBe(EXIT.OK);
    expect(readFileSync(join(no, "renox.toml"), "utf8")).toBe(lf);
    expect(b.lines.at(-1)).toBe('  renox.toml still says name = "shop": set [app] name = "store" before the next renox deploy');
    // Another app's folder is not offered and not touched.
    const other = folder('[app]\nname = "notes"\n');
    const c = fake(() => json(200, STORE), "y", other);
    expect(await apps(["rename", "shop", "store", "--json"], c)).toBe(EXIT.OK);
    expect(c.asked).toEqual([]);
    expect(JSON.parse(c.lines[0] as string).renox_toml).toBe("unchanged");
    expect(readFileSync(join(other, "renox.toml"), "utf8")).toBe('[app]\nname = "notes"\n');
  });

  test("setTomlAppName changes only the [app] value, and refuses what it cannot edit safely", () => {
    expect(setTomlAppName('[app]\r\nname="shop"\r\n', "shop", "store")).toBe('[app]\r\nname="store"\r\n');
    expect(setTomlAppName('[routes]\nname = "shop"\n[app]\n  name = "shop" # x\n', "shop", "store")).toBe('[routes]\nname = "shop"\n[app]\n  name = "store" # x\n');
    expect(setTomlAppName('[app]\nname = "notes"\n', "shop", "store")).toBeNull();
    expect(setTomlAppName('app.name = "shop"\n', "shop", "store")).toBeNull();
    expect(setTomlAppName("[app]\ntimezone = 'UTC'\n", "shop", "store")).toBeNull();
  });
});

describe("renox deploy after a rename, against the control API", () => {
  async function setup(): Promise<{ h: Harness; dir: string; io: FakeIo }> {
    const h = await harness();
    const token = await tenant(h, "t_cli");
    await registeredNode(h, "node-1");
    const dir = mkdtempSync(join(tmpdir(), "renox-rename-"));
    cpSync(join(repo, "examples/hello"), dir, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes("_spike") && !src.includes(".renox") });
    const io = fake(() => new Response(null, { status: 500 }), "", dir);
    io.env.RENOX_TOKEN = token;
    io.fetch = async (url, init) => {
      const u = new URL(url);
      const headers = Object.fromEntries(new Headers(init?.headers));
      return h.request(init?.method ?? "GET", `${u.pathname}${u.search}`, { headers, ...(init?.body === undefined ? {} : { body: init.body as BodyInit }) });
    };
    expect(await deploy([], io, dir)).toBe(EXIT.OK);
    expect(io.lines).toContain("  Created app hello");
    return { h, dir, io };
  }

  const appNames = async (h: Harness, io: FakeIo): Promise<string[]> =>
    ((await (await h.request("GET", "/v1/apps", { token: io.env.RENOX_TOKEN as string })).json()) as { apps: { name: string }[] }).apps.map((a) => a.name);

  test("a renox.toml with the old name: the deploy stops with the hint and creates nothing; after updating renox.toml it deploys", async () => {
    const { h, dir, io } = await setup();
    // Declined: renox.toml keeps the old name.
    expect(await apps(["rename", "hello", "greet"], io)).toBe(EXIT.OK);
    expect(readFileSync(join(dir, "renox.toml"), "utf8")).toContain('name = "hello"');
    const e = await failure(deploy([], io, dir));
    expect(e.exitCode).toBe(EXIT.USER);
    expect(e.message).toBe("renamed to greet; update renox.toml");
    expect(e.hint).toContain('[app] name = "greet"');
    expect(await appNames(h, io)).toEqual(["greet"]);
    // The CLI's own edit of renox.toml, then the deploy goes to the renamed app.
    const path = join(dir, "renox.toml");
    writeFileSync(path, setTomlAppName(readFileSync(path, "utf8"), "hello", "greet") as string);
    io.lines.length = 0;
    expect(await deploy([], io, dir)).toBe(EXIT.OK);
    expect(io.lines.some((l) => l.includes("Created app"))).toBe(false);
    expect(io.lines.some((l) => l.includes("https://greet.renox.app"))).toBe(true);
    expect(await appNames(h, io)).toEqual(["greet"]);
  });

  test("renox apps rename --yes in the app's folder updates renox.toml, and the next deploy goes through", async () => {
    const { h, dir, io } = await setup();
    expect(await apps(["rename", "hello", "greet", "--yes"], io)).toBe(EXIT.OK);
    expect(io.lines).toContain('  renox.toml: [app] name = "greet"');
    expect(readFileSync(join(dir, "renox.toml"), "utf8")).toBe(readFileSync(join(repo, "examples/hello/renox.toml"), "utf8").replace('name = "hello"', 'name = "greet"'));
    io.lines.length = 0;
    expect(await deploy([], io, dir)).toBe(EXIT.OK);
    expect(io.lines.some((l) => l.includes("https://greet.renox.app"))).toBe(true);
    expect(await appNames(h, io)).toEqual(["greet"]);
  });
});
