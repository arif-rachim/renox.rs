// The whatsapp module on the real worker (#290): the webhook handshake and
// signature, the inbox, a queued template send that never blocks the
// request (the outbox sends it), the OTP flow (attempts, expiry, single
// use, the same answer for every phone), the notifications.deliver filler,
// and no token in logs or the file.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { app, ServiceError, type TestApp } from "../../../sdk/src/test.ts";
import { hmacHex } from "../lib/cloud-api.ts";
import { codeHash } from "../lib/otp.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

const ENV = Object.fromEntries(
  readFileSync(join(MODULE, "tests/app/.env.test"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;

const wa = () => t.service("whatsapp");
/** The tenant file opened directly (to plant a known code); the worker may be writing, so wait for its lock. */
const rw = () => {
  const d = new Database(t.dbFile);
  d.exec("pragma busy_timeout = 5000");
  return d;
};

async function signed(body: unknown, secret = ENV.WHATSAPP_APP_SECRET as string) {
  const raw = JSON.stringify(body);
  return t.request("POST", "/whatsapp/webhook/whatsapp", { headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${await hmacHex(secret, raw)}` }, body: raw });
}

describe.skipIf(!worker)("whatsapp", () => {
  test("webhook: the verification handshake; a wrong signature is refused and stores nothing; inbound rows once", async () => {
    const ok = await t.request("GET", `/whatsapp/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${ENV.WHATSAPP_VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(ok.status).toBe(200);
    expect(ok.html).toBe("1158201444");
    expect((await t.request("GET", "/whatsapp/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status).toBe(403);
    const delivery = { entry: [{ changes: [{ value: { messages: [{ id: "wamid.in1", from: "971509999999", timestamp: "1700000000", type: "text", text: { body: "Is #42 in stock?" } }] } }] }] };
    const forged = await signed(delivery, "not-the-secret");
    expect(forged.status).toBe(401);
    const unsigned = await t.request("POST", "/whatsapp/webhook/whatsapp", { body: delivery });
    expect(unsigned.status).toBe(401);
    expect(t.db.query("select 1 from whatsapp__messages where direction = 'in'")).toEqual([]);
    expect((await signed(delivery)).json()).toEqual({ received: 1 });
    expect((await signed(delivery)).json()).toEqual({ received: 0 });
    const inbox = (await wa().inbox({ direction: "in" })) as { phone: string; body: string; status: string }[];
    expect(inbox).toEqual([expect.objectContaining({ phone: "+971509999999", body: "Is #42 in stock?", status: "received" })]);
  });

  test("a template send is queued and answered at once; the outbox carries it", async () => {
    const t0 = Date.now();
    const r = (await wa().sendTemplate("+971 50 123 4567", "order_shipped", ["#42"], "en")) as { id: string };
    expect(Date.now() - t0).toBeLessThan(2000);
    const row = t.db.query<{ kind: string; phone: string; body: string }>("select kind, phone, body from whatsapp__messages where id = ?", [r.id])[0];
    expect(row).toEqual({ kind: "template", phone: "+971501234567", body: JSON.stringify({ name: "order_shipped", language: "en", params: ["#42"] }) });
    const events = t.db.query<{ payload: string }>("select payload from renox__outbox where name = 'whatsapp.send_requested' union all select payload from renox__outbox_dead where name = 'whatsapp.send_requested'");
    expect(events.map((e) => JSON.parse(e.payload).message_id)).toContain(r.id);
    // A bad phone or template name is refused before anything is queued.
    await expect(wa().send("0501234567", "hi")).rejects.toBeInstanceOf(ServiceError);
    await expect(wa().sendTemplate("+971501234567", "Bad Name")).rejects.toBeInstanceOf(ServiceError);
  });

  test("OTP: the same answer for every phone; hashed and sealed; 5 attempts; expiry; single use", async () => {
    const phone = "+971501112233";
    expect(await wa().sendOtp(phone)).toEqual({ sent: true, expires_in: 300 });
    expect(await wa().sendOtp("+971502223344")).toEqual({ sent: true, expires_in: 300 });
    // Again within 30 s: the same answer, no second message.
    expect(await wa().sendOtp(phone)).toEqual({ sent: true, expires_in: 300 });
    expect(t.db.query("select 1 from whatsapp__messages where phone = ? and kind = 'otp'", [phone])).toHaveLength(1);
    // At rest: an HMAC in the OTP table, a sealed code (or nothing, once sent) in the message.
    const stored = t.db.query<{ code_hash: string }>("select code_hash from whatsapp__otp where phone = ?", [phone])[0]?.code_hash as string;
    expect(stored).toMatch(/^[0-9a-f]{64}$/u);
    const body = t.db.query<{ body: string }>("select body from whatsapp__messages where phone = ? and kind = 'otp'", [phone])[0]?.body as string;
    expect(body === "" || body.startsWith("seal:")).toBe(true);
    expect(body).not.toMatch(/\b[0-9]{6}\b/u);
    expect(((await wa().inbox({ phone })) as { body: string }[])[0]?.body).toBe("[otp]");
    // Plant a known code (the real one is only in the sealed message).
    const db = rw();
    try {
      db.query("update whatsapp__otp set code_hash = ? where phone = ?").run(await codeHash(ENV.WHATSAPP_APP_SECRET as string, phone, "123456"), phone);
    } finally {
      db.close();
    }
    for (let i = 0; i < 5; i++) expect(await wa().verifyOtp(phone, "000000")).toEqual({ ok: false });
    // The sixth try is refused even with the right code.
    expect(await wa().verifyOtp(phone, "123456")).toEqual({ ok: false });
    // A fresh code (past the resend window), right first time; then used.
    const db2 = rw();
    try {
      db2.query("update whatsapp__otp set created_at = created_at - 60000 where phone = ?").run(phone);
    } finally {
      db2.close();
    }
    await wa().sendOtp(phone);
    const db3 = rw();
    try {
      db3.query("update whatsapp__otp set code_hash = ? where phone = ?").run(await codeHash(ENV.WHATSAPP_APP_SECRET as string, phone, "424242"), phone);
    } finally {
      db3.close();
    }
    expect(await wa().verifyOtp(phone, "424242")).toEqual({ ok: true });
    expect(await wa().verifyOtp(phone, "424242")).toEqual({ ok: false });
    // Expiry: an aged code is refused.
    const other = "+971502223344";
    const db4 = rw();
    try {
      db4.query("update whatsapp__otp set code_hash = ?, expires_at = ? where phone = ?").run(await codeHash(ENV.WHATSAPP_APP_SECRET as string, other, "111111"), Date.now() - 1, other);
    } finally {
      db4.close();
    }
    expect(await wa().verifyOtp(other, "111111")).toEqual({ ok: false });
    // An unknown phone and a malformed code: the same answer.
    expect(await wa().verifyOtp("+971509876543", "123456")).toEqual({ ok: false });
    expect(await wa().verifyOtp(phone, "12ab56")).toEqual({ ok: false });
  });

  test("notifications.deliver: a user with a verified phone gets the WhatsApp message; one without gets none", async () => {
    const phone = "+971501112233"; // verified above
    expect(await wa().linkPhone("u_lina", phone)).toEqual({ ok: true });
    // A phone that never passed verifyOtp cannot be linked.
    expect(await wa().linkPhone("u_omar", "+971507777777")).toEqual({ ok: false });
    const r = await t.request("POST", "/api/notify", { body: { user: "u_lina", item: { category: "orders", title: "Order #42 shipped", link: "/orders/42" } } });
    expect(r.json<{ channels: string[] }>().channels).toEqual(["inapp", "whatsapp"]);
    expect(t.db.query("select body from whatsapp__messages where phone = ? and kind = 'text'", [phone])).toEqual([{ body: "Order #42 shipped\n/orders/42" }]);
    await t.request("POST", "/api/notify", { body: { user: "u_omar", item: { category: "orders", title: "Order #7 shipped" } } });
    expect(t.db.query("select 1 from whatsapp__messages where body like 'Order #7%'")).toEqual([]);
  });

  test("the tenant's per-minute limit; a chat-to-order link", async () => {
    let refused: unknown = null;
    for (let i = 0; i < 25 && refused === null; i++) {
      await wa()
        .send("+971501234567", `msg ${i}`)
        .catch((e: unknown) => (refused = e));
    }
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).message).toContain("at most 20 messages a minute");
    expect(await wa().chatLink("+971 50 123 4567", "Order #42")).toEqual({ url: "https://wa.me/971501234567?text=Order%20%2342" });
  });

  test("no token or secret in the logs or the file", async () => {
    await Bun.sleep(1500); // the outbox has tried the sends by now
    const logs = JSON.stringify(t.logs());
    const file = readFileSync(t.dbFile).toString("latin1");
    for (const k of ["WHATSAPP_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"]) {
      expect(logs).not.toContain(ENV[k] as string);
      expect(file).not.toContain(ENV[k] as string);
    }
  });
});
