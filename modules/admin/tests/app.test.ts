// The admin module in an app, on the real worker (#335): the back office
// needs admin.access; the sidebar renders the fillers of the installed
// modules whose action the user holds; an admin grants and revokes the admin
// role (not their own), and the decision is in the audit viewer for an
// auditor; the pages in ltr and rtl.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
/**
 * The harness runs a module's tests in `tests/app/` only. The same app with the back office mounted at
 * `/back-office` (`base_path` set to match) is staged as the `tests/app/` of a scratch module folder, its
 * `path:` sources made absolute.
 */
function stageBackOffice(): string {
  const src = join(MODULE, "tests/app");
  const root = mkdtempSync(join(tmpdir(), "admin-backoffice-"));
  const dest = join(root, "tests", "app");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(root, "module.toml"), "");
  cpSync(src, dest, { recursive: true });
  const toml = readFileSync(join(src, "renox.toml"), "utf8")
    .replace(/"path:([^"]+)"/gu, (_m, rel: string) => JSON.stringify(`path:${resolve(src, rel)}`))
    .replace('mount = "/admin" }', 'mount = "/back-office", config = { base_path = "/back-office" } }');
  writeFileSync(join(dest, "renox.toml"), toml);
  return root;
}

const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const b = worker ? await app({ project: stageBackOffice() }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";

async function user(name: string, ...roles: string[]): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  for (const role of roles) expect((await u.request("POST", `/api/grant?role=${role}`)).status).toBe(200);
  return u;
}
const idOf = (name: string): string => t.db.query<{ id: string }>("select id from auth__users where email = ?", [`${name}@example.com`])[0]?.id as string;
async function adminOf(a: TestApp, name: string): Promise<TestApp> {
  const u = a.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  expect((await u.request("POST", "/api/grant?role=admin")).status).toBe(200);
  return u;
}
const sidebar = (html: string): string[] => [...(/<nav class="renox-admin-sidebar".*?<\/nav>/su.exec(html)?.[0] ?? "").matchAll(/<a href="([^"]*)"/gu)].map((m) => m[1] as string);
const plain =(html: string) => html.replaceAll(' dir="auto"', "");

describe.skipIf(!worker)("admin in an app", () => {
  test("the back office needs admin.access; the sidebar shows the installed modules' links the user may follow", async () => {
    expect((await (await user("omar")).page("/admin")).status).toBe(403);
    const adel = await user("adel", "admin");
    const r = await adel.page("/admin");
    expect(r.status).toBe(200);
    const html = plain(r.html);
    expect(html).toContain('<a href="/jobs" class="renox-admin-link">Jobs</a>');
    expect(html).not.toContain('href="/billing/invoices"');
    expect(html).toMatch(/<article id="admin-card-users"><h2>Users<\/h2><p>2<\/p>/u);
  });

  test("an admin grants and revokes the admin role (never their own); an auditor reads the decisions", async () => {
    const adel = t.as("adel");
    const id = idOf("omar");
    expect((await adel.action("/admin/users", "grant", { user_id: id })).status).toBe(200);
    expect((await t.as("omar").page("/admin")).status).toBe(200);
    expect(plain((await adel.action("/admin/users", "revoke", { user_id: idOf("adel") })).html)).toContain("You cannot remove your own admin role.");
    expect((await adel.action("/admin/users", "revoke", { user_id: id })).status).toBe(200);
    expect((await t.as("omar").page("/admin")).status).toBe(403);
    // An admin without the auditor role sees the refusal, not the rows.
    expect(plain((await adel.page("/admin/audit")).html)).toContain("Reading the audit trail needs the auditor role.");
    const aud = await user("hala", "admin", "auditor");
    const a = plain((await aud.page("/admin/audit?action=admin.")).html);
    expect(a).toContain("admin.users");
  });

  test("the users page in ltr and rtl", async () => {
    const adel = t.as("adel");
    const en = await adel.page("/admin/users");
    expect(en.html).toContain('dir="ltr"');
    const head = (html: string) => /<thead>.*?<\/thead>/su.exec(plain(html))?.[0] ?? "";
    expect(head(en.html)).toMatchSnapshot("users ltr");
    const ar = await adel.page("/admin/users?lang=ar");
    expect(ar.html).toContain('dir="rtl"');
    expect(head(ar.html)).toMatchSnapshot("users rtl");
  });

  test("the sidebar links are absolute from base_path, at <mount> (and <mount>/ redirects there) (#704)", async () => {
    const adel = t.as("adel");
    const r = await adel.page("/admin");
    expect(r.status).toBe(200);
    expect(sidebar(r.html).slice(0, 3)).toEqual(["/admin/", "/admin/users", "/admin/audit"]);
    // The dashboard card too (the locale is whatever the earlier tests left on the user).
    expect(r.html.split('<a href="/admin/users">').length - 1).toBe(2);
    // The gateway sends <mount>/ to <mount> (308), so the same page answers.
    const slash = await adel.page("/admin/");
    expect(slash.status).toBe(308);
    expect(slash.headers.get("location")).toBe("/admin");
    const users = await adel.page("/admin/users");
    expect(sidebar(users.html).slice(0, 3)).toEqual(["/admin/", "/admin/users", "/admin/audit"]);
  });

  test("with base_path = /back-office the sidebar links follow it (#704)", async () => {
    const boss = await adminOf(b, "boss");
    const r = await boss.page("/back-office");
    expect(r.status).toBe(200);
    expect(sidebar(r.html).slice(0, 3)).toEqual(["/back-office/", "/back-office/users", "/back-office/audit"]);
    expect((await boss.page("/back-office/")).headers.get("location")).toBe("/back-office");
  });
});
