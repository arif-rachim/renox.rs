// A path link (`/org/accept/<token>`, #765): the email module completes it with
// the app's own origin (the queuing request's, else `config.app_url`); every
// other relative value and every non-https value is dropped.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as core from "../lib/core.ts";
import { safeUrl } from "../lib/templates.ts";

function setup(opts: { url?: string; app_url?: string } = {}) {
  const db = new Database(":memory:");
  for (const f of ["001_init.sql", "002_templates.sql", "003_reputation.sql", "004_from_name.sql"]) db.exec(readFileSync(join(import.meta.dir, "../migrations", f), "utf8"));
  const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
  const c: core.EmailCtx = {
    db: {
      async query<T>(sql: string, p: unknown[] = []) {
        return db.query(sql).all(...(p as never[])) as T[];
      },
      async queryOne<T>(sql: string, p: unknown[] = []) {
        return (db.query(sql).get(...(p as never[])) ?? null) as T | null;
      },
      async execute(sql: string, p: unknown[] = []) {
        return { changes: db.query(sql).run(...(p as never[])).changes };
      },
    },
    fetch: async () => new Response("{}"),
    secrets: {},
    config: { provider: "resend", from: "shop@hello.ae", ...(opts.app_url === undefined ? {} : { app_url: opts.app_url }) },
    events: { emit: async () => {} },
    log: { info() {}, warn: (msg, fields) => void warns.push({ msg, fields }) },
    ...(opts.url === undefined ? {} : { url: new URL(opts.url) }),
  };
  const send = async (url: string): Promise<{ html: string; text: string }> => {
    const r = await core.sendTemplate(c, "new@example.com", "org_invite", { url, org_name: "Acme", role: "member", expires_days: 7, invited_by: "Sam" });
    const row = db.query("select html_body, text_body from email__messages where id = ?").get(r.id as string) as { html_body: string; text_body: string };
    return { html: row.html_body, text: row.text_body };
  };
  return { send, warns };
}

test("a path link gets the request's origin (a page request)", async () => {
  const { send, warns } = setup({ url: "https://shop.renoxium.app/org/invite" });
  const m = await send("/org/accept/abc");
  expect(m.html).toContain('href="https://shop.renoxium.app/org/accept/abc"');
  expect(m.text).toContain("https://shop.renoxium.app/org/accept/abc");
  expect(warns).toEqual([]);
});

test("a custom domain gives the custom host", async () => {
  const { send } = setup({ url: "https://book.example.ae/x?y=1" });
  expect((await send("/org/accept/abc")).html).toContain('href="https://book.example.ae/org/accept/abc"');
});

test("an App MCP request (no request origin) uses the app_url config", async () => {
  const { send, warns } = setup({ app_url: "https://shop.renoxium.app" });
  expect((await send("/org/accept/abc")).html).toContain('href="https://shop.renoxium.app/org/accept/abc"');
  expect(warns).toEqual([]);
});

test("the request origin wins over app_url", async () => {
  const { send } = setup({ url: "https://book.example.ae/", app_url: "https://shop.renoxium.app" });
  expect((await send("/org/accept/abc")).html).toContain('href="https://book.example.ae/org/accept/abc"');
});

test("with no origin the link is dropped and one warning is logged", async () => {
  const { send, warns } = setup();
  const m = await send("/org/accept/abc");
  expect(m.html).not.toContain("href=");
  expect(m.text).not.toContain("/org/accept/abc");
  expect(warns).toHaveLength(1);
  expect(warns[0]?.fields).toMatchObject({ code: "EMAIL_LINK_NO_ORIGIN" });
});

test("an invalid app_url is no origin", async () => {
  for (const bad of ["http://shop.example.com", "https://shop.example.com/path", "https://shop.example.com?x=1", "https://u:p@shop.example.com", "shop.example.com", "https://shop.example.com#a"]) {
    const { send, warns } = setup({ app_url: bad });
    expect((await send("/org/accept/abc")).html).not.toContain("href=");
    expect(warns).toHaveLength(1);
  }
});

test("values that are not an app path are dropped, with an origin known", async () => {
  const { send } = setup({ url: "https://shop.renoxium.app/" });
  const bad = ["//evil.example/x", "/\\evil.example", "/a\\b", "javascript:alert(1)", "http://evil.example/x", "relative/path", "/org/accept/a\nb", "/org/accept/a\u0000b", "/org/accept/a\tb", `/${"a".repeat(2000)}`, "///evil.example", "", "  /org/x"];
  for (const v of bad) expect((await send(v)).html).not.toContain("href=");
  // Absolute https stays, and the longest allowed path stays.
  expect((await send("https://ok.example/x")).html).toContain('href="https://ok.example/x"');
  expect((await send(`/${"a".repeat(1999)}`)).html).toContain("href=");
});

test("safeUrl: the origin of the result equals the base; localhost http is kept", () => {
  expect(safeUrl("/a/b?c=d#e", "https://x.example")).toBe("https://x.example/a/b?c=d#e");
  expect(safeUrl("/a", null)).toBeNull();
  expect(safeUrl("/a", "ftp://x.example")).toBeNull();
  expect(safeUrl("http://localhost:3000/a")).toBe("http://localhost:3000/a");
  expect(safeUrl("/a", "http://localhost:3000")).toBe("http://localhost:3000/a");
  expect(safeUrl("http://evil.example/a")).toBeNull();
  expect(safeUrl("/@evil.example/", "https://x.example")).toBe("https://x.example/@evil.example/");
});
