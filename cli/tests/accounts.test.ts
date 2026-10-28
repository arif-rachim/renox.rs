// renox login and renox tokens (#113) against a fake control plane.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apiAuth, credentialsPath, type Io, run as login } from "../src/commands/login.ts";
import { run as tokens } from "../src/commands/tokens.ts";
import { CliError, EXIT } from "../src/errors.ts";

const TOKEN = `renox_pat_${"a".repeat(32)}`;

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

function io(answers: ((call: Call) => Response | undefined)[], env: Record<string, string | undefined> = {}): Io & { lines: string[]; calls: Call[]; slept: number[] } {
  const lines: string[] = [];
  const calls: Call[] = [];
  const slept: number[] = [];
  const home = mkdtempSync(join(tmpdir(), "renox-cli-"));
  return {
    lines,
    calls,
    slept,
    env: { XDG_CONFIG_HOME: home, ...env },
    out: (l) => lines.push(l),
    sleep: async (ms) => {
      slept.push(ms);
    },
    readStdin: async () => `${TOKEN}\n`,
    fetch: async (url, init) => {
      const call = { method: init?.method ?? "GET", url, auth: new Headers(init?.headers).get("authorization"), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
      calls.push(call);
      for (const a of answers) {
        const r = a(call);
        if (r !== undefined) return r;
      }
      throw new Error(`unexpected ${call.method} ${url}`);
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("renox login", () => {
  test("device flow: shows the code, polls until approved, saves the token readable only by the user", async () => {
    let polls = 0;
    const t = io([
      (c) => (c.url === "https://api.test/v1/account/device" ? json(201, { device_code: "d".repeat(32), user_code: "BCDF-GHJK", verification_uri: "https://dash.test/device", expires_in: 900, interval: 5 }) : undefined),
      (c) => {
        if (c.url !== "https://api.test/v1/account/device/token") return undefined;
        expect(c.body).toEqual({ device_code: "d".repeat(32) });
        return ++polls < 3 ? json(polls === 1 ? 429 : 202, {}) : json(201, { id: "tok_1", token: TOKEN, tenant_id: "t-1", expires_at: 1, scopes: ["deploy"], name: "x", created_at: 0 });
      },
    ]);
    expect(await login(["--api", "https://api.test/"], t)).toBe(EXIT.OK);
    expect(t.lines[0]).toBe("Open https://dash.test/device and enter the code BCDF-GHJK");
    expect(t.slept).toEqual([5000, 10000, 10000]);
    const file = credentialsPath(t.env);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ api: "https://api.test", token: TOKEN, tenant_id: "t-1", token_id: "tok_1", expires_at: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(t.lines.join("\n")).not.toContain(TOKEN);
    expect(apiAuth(t.env)).toEqual({ api: "https://api.test", token: TOKEN });
  });

  test("an expired code is a user error; an unreachable API is an environment error", async () => {
    const expired = io([
      (c) => (c.url.endsWith("/device") ? json(201, { device_code: "d".repeat(32), user_code: "X", verification_uri: "u", expires_in: 900, interval: 5 }) : undefined),
      () => json(404, { error: { code: "RENOX_NOT_FOUND" } }),
    ]);
    const e1 = await login(["--api", "https://api.test"], expired).catch((e: unknown) => e);
    expect((e1 as CliError).exitCode).toBe(EXIT.USER);
    const down = io([
      () => {
        throw new Error("connection refused");
      },
    ]);
    const e2 = await login(["--api", "https://api.test"], down).catch((e: unknown) => e);
    expect((e2 as CliError).exitCode).toBe(EXIT.ENVIRONMENT);
  });

  test("--with-token reads stdin; RENOX_TOKEN overrides the file", async () => {
    const t = io([]);
    expect(await login(["--with-token", "--api", "https://api.test"], t)).toBe(EXIT.OK);
    expect(t.calls).toEqual([]);
    expect(apiAuth(t.env).token).toBe(TOKEN);
    const other = `renox_pat_${"b".repeat(32)}`;
    expect(apiAuth({ ...t.env, RENOX_TOKEN: other, RENOX_API_URL: "https://ci.test" })).toEqual({ api: "https://ci.test", token: other });
    expect(() => apiAuth({ XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cli-")) })).toThrow("not signed in");
  });
});

describe("renox tokens", () => {
  const env = { RENOX_TOKEN: TOKEN, RENOX_API_URL: "https://api.test" };

  test("create prints the value once and sends the scopes; list hides revoked tokens and never shows values", async () => {
    const t = io(
      [
        (c) =>
          c.method === "POST" && c.url === "https://api.test/v1/tokens"
            ? json(201, { id: "tok_2", name: "ci", token: `renox_pat_${"c".repeat(32)}`, scopes: ["deploy:shop"], created_at: 0, expires_at: 86_400_000 })
            : undefined,
        (c) =>
          c.method === "GET"
            ? json(200, {
                tokens: [
                  { id: "tok_2", name: "ci", scopes: ["deploy:shop"], created_at: 0, expires_at: 86_400_000, last_used_at: null, revoked_at: null },
                  { id: "tok_3", name: "old", scopes: ["*"], created_at: 0, expires_at: 1, last_used_at: 0, revoked_at: 5 },
                ],
              })
            : undefined,
      ],
      env,
    );
    expect(await tokens(["create", "ci", "--scope", "deploy:shop", "--expires-days", "30"], t)).toBe(EXIT.OK);
    expect(t.calls[0]).toEqual({ method: "POST", url: "https://api.test/v1/tokens", auth: `Bearer ${TOKEN}`, body: { name: "ci", scopes: ["deploy:shop"], expires_in_days: 30 } });
    expect(t.lines[0]).toBe(`renox_pat_${"c".repeat(32)}`);
    expect(t.lines[1]).toContain("shown only now");
    t.lines.length = 0;
    expect(await tokens(["list"], t)).toBe(EXIT.OK);
    expect(t.lines).toEqual(["tok_2  ci  [deploy:shop]  expires 1970-01-02  last used never"]);
  });

  test("revoke; errors from the API keep their code and say what to do", async () => {
    const t = io(
      [
        (c) => (c.method === "DELETE" && c.url.endsWith("/tok_2") ? new Response(null, { status: 204 }) : undefined),
        (c) => (c.method === "DELETE" ? json(404, { error: { code: "RENOX_NOT_FOUND", message: "Not found." } }) : undefined),
        () => json(401, { error: { code: "RENOX_UNAUTHENTICATED", message: "Authentication is required." } }),
      ],
      env,
    );
    expect(await tokens(["revoke", "tok_2"], t)).toBe(EXIT.OK);
    const missing = (await tokens(["revoke", "tok_9"], t).catch((e: unknown) => e)) as CliError;
    expect(missing.message).toBe("Not found. (RENOX_NOT_FOUND)");
    const expired = (await tokens(["list"], t).catch((e: unknown) => e)) as CliError;
    expect(expired.hint).toContain("renox login");
    for (const bad of [["create", "x"], ["create", "x", "--scope", "root"], ["create", "x", "--scope", "deploy", "--expires-days", "400"], ["frobnicate"], []]) {
      const e = (await tokens(bad, t).catch((x: unknown) => x)) as CliError;
      expect(e.exitCode).toBe(EXIT.USER);
    }
  });
});
