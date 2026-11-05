// renox domains add | list | status | rm (#477) against the in-process control
// API with StubCloudflare (control/api/tests/domain-stubs.ts); Cloudflare is
// never called. docs/contracts/deploy-api.md section 10.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tick } from "../../control/api/src/domains/jobs.ts";
import { configureDomains } from "../../control/api/src/domains/service.ts";
import { EDGE, StubCloudflare } from "../../control/api/tests/domain-stubs.ts";
import { createApp_, harness, tenant, type Harness } from "../../control/api/tests/helpers.ts";
import type { Io } from "../src/commands/login.ts";
import { normalizeHostname, run as domains } from "../src/commands/domains.ts";
import { CliError, EXIT } from "../src/errors.ts";

const API = "https://api.test";
const HOST = "www.example.com";

async function setup(): Promise<{ h: Harness; cf: StubCloudflare; token: string; io: Io & { lines: string[] } }> {
  const h = await harness();
  const token = await tenant(h, "t_cli", "paid");
  await createApp_(h, token, "shop");
  const cf = new StubCloudflare();
  configureDomains(h.deps, { cloudflare: cf });
  const lines: string[] = [];
  const io = {
    lines,
    env: { RENOX_TOKEN: token, RENOX_API_URL: API, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "renox-cfg-")) },
    out: (l: string) => lines.push(l),
    sleep: async () => {},
    readStdin: async () => "",
    fetch: async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const headers = Object.fromEntries(new Headers(init?.headers));
      return h.request(init?.method ?? "GET", `${u.pathname}${u.search}`, { headers, ...(init?.body === undefined ? {} : { body: init.body as BodyInit }) });
    },
  };
  return { h, cf, token, io };
}

async function failure(p: Promise<unknown>): Promise<CliError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CliError);
  return e as CliError;
}

describe("renox domains", () => {
  test("add prints the CNAME and both TXT records; status is pending, then verified once Cloudflare reports active", async () => {
    const { h, cf, io, token } = await setup();
    expect(await domains(["add", HOST, "--app", "shop"], io)).toBe(EXIT.OK);
    const id = cf.of(HOST)?.id as string;
    const text = io.lines.join("\n");
    expect(text).toContain(`${HOST}  pending`);
    expect(text).toContain(`CNAME  ${HOST}  ->  ${EDGE}`);
    expect(text).toContain(`_cf-custom-hostname.${HOST}  ->  own-${id}   (ownership)`);
    expect(text).toContain(`_acme-challenge.${HOST}  ->  dcv-${id}   (certificate validation)`);
    expect(text).not.toContain(token);

    io.lines.length = 0;
    expect(await domains(["status", HOST, "--app", "shop"], io)).toBe(EXIT.OK);
    expect(io.lines.join("\n")).toContain(`${HOST}  pending`);

    cf.setStatus(HOST, "active");
    await tick(h.deps);
    io.lines.length = 0;
    expect(await domains(["status", HOST, "--app", "shop"], io)).toBe(EXIT.OK);
    expect(io.lines.join("\n")).toContain(`${HOST}  verified`);
    expect(io.lines.join("\n")).not.toContain("CNAME");
  });

  test("list shows every domain with its state; --json is the API's answer; rm releases a pending one and detaches a verified one", async () => {
    const { h, cf, io } = await setup();
    expect(await domains(["list", "--app", "shop"], io)).toBe(EXIT.OK);
    expect(io.lines[0]).toContain("No custom domains for shop");
    await domains(["add", HOST, "--app", "shop"], io);
    await domains(["add", "shop.example.org", "--app", "shop"], io);
    io.lines.length = 0;
    await domains(["list", "--app", "shop"], io);
    expect(io.lines).toHaveLength(2);
    expect(io.lines[0]).toMatch(/^shop\.example\.org\s+pending/u);
    expect(io.lines[1]).toMatch(/^www\.example\.com\s+pending/u);

    io.lines.length = 0;
    await domains(["status", HOST, "--app", "shop", "--json"], io);
    expect(JSON.parse(io.lines[0] as string)).toMatchObject({ hostname: HOST, app: "shop", state: "pending", cname_target: EDGE });

    cf.setStatus(HOST, "active");
    await tick(h.deps);
    io.lines.length = 0;
    await domains(["rm", HOST, "--app", "shop"], io);
    expect(io.lines[0]).toContain(`Removed ${HOST}`);
    io.lines.length = 0;
    await domains(["rm", "shop.example.org", "--app", "shop"], io);
    expect(io.lines[0]).toContain("Released shop.example.org");
    const gone = await failure(domains(["status", "shop.example.org", "--app", "shop"], io));
    expect(gone.exitCode).not.toBe(EXIT.OK);
  });

  test("the app defaults to the one in renox.toml", async () => {
    const { io } = await setup();
    const dir = mkdtempSync(join(tmpdir(), "renox-domains-"));
    await Bun.write(join(dir, "renox.toml"), '[app]\nname = "shop"\ntimezone = "Asia/Dubai"\n');
    expect(await domains(["add", HOST], io, dir)).toBe(EXIT.OK);
    expect(io.lines[0]).toContain(`${HOST}  pending`);
  });

  test("the API's refusals are shown: a platform hostname (400), a taken one (409), no Cloudflare (503)", async () => {
    const { h, cf, io } = await setup();
    const platform = await failure(domains(["add", "other.renox.app", "--app", "shop"], io));
    expect(platform.exitCode).toBe(EXIT.USER);
    await domains(["add", HOST, "--app", "shop"], io);
    const other = await tenant(h, "t_other", "paid");
    await createApp_(h, other, "other");
    const io2 = { ...io, env: { ...io.env, RENOX_TOKEN: other } };
    const taken = await failure(domains(["add", HOST, "--app", "other"], io2));
    expect(taken.message).not.toContain("t_cli");
    configureDomains(h.deps, { cloudflare: null });
    const unavailable = await failure(domains(["add", "blog.example.com", "--app", "shop"], io));
    expect(unavailable.exitCode).not.toBe(EXIT.OK);
    expect(cf.calls).toEqual([`create ${HOST}`]);
  });

  test("bad input is refused before any request", async () => {
    const calls: string[] = [];
    const io: Io = { env: { RENOX_TOKEN: `renox_pat_${"a".repeat(32)}`, RENOX_API_URL: API }, out: () => {}, sleep: async () => {}, readStdin: async () => "", fetch: async (u) => (calls.push(u), new Response("{}")) };
    for (const args of [[], ["bogus"], ["add"], ["add", "https://www.example.com/"], ["add", "www.example.com:443", "--app", "shop"], ["add", "../x", "--app", "shop"], ["status", "a b.com", "--app", "shop"], ["add", "localhost", "--app", "shop"], ["list", "extra", "--app", "shop"], ["add", HOST, "--wat"], ["add", HOST, "--app", "Bad App"]]) {
      expect((await failure(domains(args, io))).exitCode).toBe(EXIT.USER);
    }
    expect(calls).toEqual([]);
  });

  test("normalizeHostname lowercases and drops a trailing dot", () => {
    expect(normalizeHostname("WWW.Example.COM.")).toBe("www.example.com");
  });
});
