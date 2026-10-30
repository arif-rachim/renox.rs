// The F5 done criterion on the shop (#292; docs/15-roadmap.md F5;
// docs/11-authorization.md, the worked example): a refund is denied for a
// user without the role or without the second factor. The curl path: the
// button is hidden and `POST /orders?/refund` is denied (403) for the same
// user; after a TOTP verification (2fa module) the button shows and the
// refund goes through, under the threshold; over it only a finance manager
// may. Every decision on the sensitive action is in the audit table.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app as harness, snapshot, type TestApp } from "renox/test";
import { totp } from "../../../sdk/src/totp.ts";

const worker = process.env.RENOX_WORKER_PATH;
const t = worker ? await harness({ project: join(import.meta.dir, "..") }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";

function rw(fn: (db: Database) => void) {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  try {
    fn(db);
  } finally {
    db.close();
  }
}

const idOf = (email: string) => t.db.query<{ id: string }>("select id from auth__users where email = ?", [email])[0]?.id as string;
const signIn = (jar: string, email: string) => t.as(jar).action("/auth/login", "default", { email, password: PASSWORD, next: "/orders" });
const refundButtons = (html: string) => [...html.matchAll(/name="order" value="(\d+)"><button type="submit">Refund<\/button>/gu)].map((m) => Number(m[1]));
const stable = (html: string) => html.replace(/\b[0-9a-f]{32}\b/gu, "<id>");

describe.skipIf(!worker)("refunds: roles, threshold, second factor", () => {
  let small = 0;
  let large = 0;
  let secret = "";

  test("setup: fatima (finance) and vera (viewer) in Acme, two orders", async () => {
    for (const [jar, email, name] of [["fatima", "fatima@example.com", "Fatima"], ["vera", "vera@example.com", "Vera"]] as const) {
      const u = t.as(jar);
      expect((await u.action("/auth/register", "default", { email, password: PASSWORD, display_name: name })).status).toBe(200);
    }
    rw((db) => {
      const at = Date.now();
      db.query("insert into renox__role_assignments (user_id, role, scope_type, scope_id, granted_by, at) values (?, 'finance', 'global', '', 'test', ?)").run(idOf("fatima@example.com"), at);
      db.query("insert into renox__role_assignments (user_id, role, scope_type, scope_id, granted_by, at) values (?, 'viewer', 'global', '', 'test', ?)").run(idOf("vera@example.com"), at);
    });
    expect((await signIn("fatima", "fatima@example.com")).status).toBe(303);
    expect((await t.as("fatima").action("/org", "create", { name: "Acme", slug: "" })).status).toBe(303);
    const org = t.db.query<{ id: string }>("select id from org__orgs where slug = 'acme'")[0]?.id as string;
    rw((db) => {
      const add = db.query("insert into app__orders (user_id, org_id, cart_id, amount_fils, created_at) values (?, ?, 'c_t', ?, ?) returning id");
      small = (add.get(idOf("fatima@example.com"), org, 5000, 1) as { id: number }).id;
      large = (add.get(idOf("fatima@example.com"), org, 2_000_000, 2) as { id: number }).id;
    });
  });

  test("without the second factor: no refund button, and the curl POST is denied", async () => {
    // Creating the organisation emits auth.principal_changed; the cell drops
    // the cached principal when the outbox delivers it.
    let page = await t.as("fatima").page("/orders");
    for (let i = 0; i < 40 && page.status !== 200; i++) {
      await Bun.sleep(50);
      page = await t.as("fatima").page("/orders");
    }
    expect(page.status).toBe(200);
    expect(page.html).toContain(`id="order-${small}"`);
    expect(refundButtons(page.html)).toEqual([]);
    const curl = await t.as("fatima").action("/orders", "refund", { order: String(small) });
    expect(curl.status).toBe(403);
    expect(t.db.query("select 1 from app__refunds")).toEqual([]);
    // A viewer has no refund either (and no order list without an organisation).
    expect((await signIn("vera", "vera@example.com")).status).toBe(303);
    expect((await t.as("vera").page("/orders")).status).toBe(403);
  });

  test("after a TOTP verification: the button for the small order only; the refund goes through; over the threshold it is denied", async () => {
    const enrol = await t.as("fatima").page("/2fa/enroll/totp");
    secret = (/id="secret"[^>]*>([A-Z2-7 ]+)</u.exec(enrol.html)?.[1] ?? "").replace(/ /gu, "");
    expect((await t.as("fatima").action("/2fa/enroll/totp", "confirm", { code: await totp(secret) })).status).toBe(200);
    // A new sign-in: halted after the password, resumed by the second factor.
    const halted = await signIn("fatima-2", "fatima@example.com");
    expect(halted.headers.get("location")).toBe("/2fa/verify?next=%2Forders");
    const verified = await t.as("fatima-2").action("/2fa/verify", "totp", { code: await totp(secret, Date.now() / 1000 + 30), next: "/orders" });
    expect(verified.status).toBe(303);
    expect((await t.as("fatima-2").action("/org", "switch", { org: t.db.query<{ id: string }>("select id from org__orgs where slug = 'acme'")[0]?.id as string, next: "/orders" })).status).toBe(303);
    const page = await t.as("fatima-2").page("/orders");
    expect(refundButtons(page.html)).toEqual([small]);
    snapshot(stable(page.html), { role: "finance with 2FA" });
    const ok = await t.as("fatima-2").action("/orders", "refund", { order: String(small) });
    expect(ok.status).toBe(200);
    expect(ok.html).toContain(`Order #${small} refunded.`);
    expect(t.db.query("select order_id from app__refunds")).toEqual([{ order_id: small }]);
    // The curl path over the threshold: the same policy denies it.
    expect((await t.as("fatima-2").action("/orders", "refund", { order: String(large) })).status).toBe(403);
    // The buyer was notified.
    expect(t.db.query("select title from notifications__items")).toEqual([{ title: `Order #${small} refunded` }]);
  });

  test("the audit table has every decision on the sensitive action", async () => {
    const rows = t.db.query<{ result: string }>("select result from renox__authz_audit_v1 where action = 'invoice.refund' order by id");
    expect(rows.map((r) => r.result)).toEqual(["deny", "allow", "deny"]);
  });
});
