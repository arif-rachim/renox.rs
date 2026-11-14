// Notifications (F7-124): the customer's WhatsApp message (or email) at the
// moments that matter, the dispatcher's live badge, and a customer's "cancel"
// or "reschedule" reply becoming a task. Runs on the local worker with the
// seed's users (password below).
//
// The app runs the `whatsapp` module in its sandbox (`sandbox = true` in
// renox.toml): a message is recorded as sent and no API is called. "whatsapp is
// called" is read from the module's outbox (tests/outbox.ts: `whatsapp__messages`,
// what `whatsapp.outbox()` lists): a row of kind `template` with the template's
// name, language, parameters and the customer's +971 number. The module's own
// tests cover the Cloud API calls.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, snapshot } from "@renoxium/sdk/test";

import { renderMessage } from "../lib/messages";
import { replyKind } from "../lib/reply";
import { outboxOf } from "./outbox";

setDefaultTimeout(30_000);
const t = await app();
const PASSWORD = "correct horse battery";
const ENV = Object.fromEntries(
  readFileSync(join(import.meta.dir, "..", ".env.test"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;

async function signIn(jar: string, email: string, next = "/jobs") {
  const u = t.as(jar);
  const res = await u.action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(res.status).toBe(303);
  return u;
}

const dubai = await signIn("dubai", "dispatcher.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example", "/me");
const customer = t.as("customer"); // never signs in

const ALI = "u_dxb_ali";
const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);
const rw = <T>(f: (db: Database) => T): T => {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  try {
    return f(db);
  } finally {
    db.close();
  }
};
const setContact = (id: string, phone: string, email: string | null) => rw((db) => db.run("update app__customers set phone = ?, email = ? where id = ?", [phone, email, id]));

/** The day (`YYYY-MM-DD`, Dubai) of a Monday about two weeks away (the booking module takes starts at most 30 days ahead). */
function monday(): string {
  const d = new Date(Date.now() + 4 * 3_600_000 + 14 * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
/** Schedules the job with Ali at the first start the slot picker offers that Monday (what the seed or an earlier test booked is not offered). */
async function schedule(job: string) {
  const page = await dubai.page(`/jobs/${job}?day=${monday()}&technician=${ALI}`);
  const slot = new RegExp(`value="(${ALI}@\\d+)"`, "u").exec(page.html)?.[1];
  expect(slot).toBeDefined();
  return dubai.action(`/jobs/${job}`, "schedule", { slot: slot as string });
}
const PHONE = { layla: "+971501110001", peter: "+971521110002", fatima: "+971551110003" };
/** What the whatsapp module sent to the customer's phone (as seeded), oldest first. */
const sent = (customerId: string) => outboxOf(rows, String(rows("select phone from app__customers where id = ?", [customerId])[0]?.phone));
/** Waits for the module's outbox handler: in the sandbox every queued message ends as sent, with a `sandbox-` id. */
async function settled(): Promise<void> {
  for (let i = 0; i < 100 && Number(rows("select count(*) as n from whatsapp__messages where direction = 'out' and status = 'queued'")[0]?.n) > 0; i++) await Bun.sleep(50);
  expect(rows("select 1 from whatsapp__messages where direction = 'out' and (status != 'sent' or wa_id not like 'sandbox-%')")).toEqual([]);
}
const messages = (customerId: string, kind: string) => rows("select channel, template from app__customer_messages where customer_id = ? and kind = ? order by id", [customerId, kind]);
const emails = (to: string) => rows("select subject, text_body from email__messages where to_address = ? order by at", [to]);

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let seq = 0;
/** A signed delivery of one inbound text, as Meta sends it (`wamid`: Meta's message id; a retried delivery repeats it). */
async function inbound(from: string, text: string, secret = ENV.WHATSAPP_APP_SECRET as string, wamid = `wamid.hs${++seq}`) {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
  return t.request("POST", "/whatsapp/webhook/whatsapp", { headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${await hmac(secret, raw)}` }, body: raw });
}

/**
 * Waits until the app's handler of `whatsapp.message_received` (hooks.ts) has
 * run for every message received so far: the module emits the event in the
 * webhook's transaction, and the worker's outbox delivers it to the app right
 * after the commit (no job, no tick), then drops the delivery's row (target
 * '' is the event before it is fanned out to its handlers).
 */
async function handled(): Promise<void> {
  const pending = () => Number(rows("select count(*) as n from renox__outbox where target in ('', 'app') and name = 'whatsapp.message_received'")[0]?.n);
  for (let i = 0; i < 200 && pending() > 0; i++) await Bun.sleep(50);
  expect(pending()).toBe(0);
}

describe("the texts", () => {
  test("a template is filled in the customer's language, and its parameters follow the placeholders", () => {
    const en = renderMessage("visit_scheduled", "en", { name: "Peter", job: "J-000002", when: "2026-11-09 09:00", technician: "Ali" });
    expect(en.template).toBe("visit_scheduled");
    expect(en.params).toEqual(["Peter", "J-000002", "2026-11-09 09:00", "Ali"]);
    expect(en.body).toContain("Hello Peter, your visit J-000002 is scheduled for 2026-11-09 09:00 with Ali.");
    const ar = renderMessage("visit_scheduled", "ar", { name: "ليلى", job: "J-000002", when: "2026-11-09 09:00", technician: "Ali" });
    expect(ar.body).toContain("مرحباً ليلى");
    expect(ar.language).toBe("ar");
  });

  test("the reply keywords, in English and Arabic", () => {
    expect(["Cancel", " cancel! ", "إلغاء", "RESCHEDULE", "تغيير الموعد", "cancel my job please", "hello", ""].map(replyKind)).toEqual(["cancel", "cancel", "cancel", "reschedule", "reschedule", null, null, null]);
  });
});

describe("with the whatsapp module in its sandbox (renox.toml)", () => {
  test("normal case: scheduling queues the template in the module's outbox, sent in the sandbox", async () => {
    // Fatima Al Suwaidi (Arabic, a phone, no email): J-000008 is moved to Ali.
    expect((await schedule("jb_seed_08")).status).toBe(303);
    await settled();
    const p = sent("cu_dxb_03");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: "template", phone: PHONE.fatima, template: "visit_scheduled", status: "sent" });
    // Edge case: the customer's language is Arabic: the Arabic template, with her name and the job number first.
    expect(p[0]?.language).toBe("ar");
    expect(p[0]?.params.slice(0, 2)).toEqual(["Fatima Al Suwaidi", "J-000008"]);
    expect(messages("cu_dxb_03", "visit_scheduled")).toEqual([{ channel: "whatsapp", template: "visit_scheduled" }]);
    expect(emails("fatima@example.com")).toEqual([]);
  });

  test("a customer with a phone and an email is told on WhatsApp only", async () => {
    // Peter Nowak (English): J-000002 is scheduled.
    expect((await schedule("jb_seed_02")).status).toBe(303);
    await settled();
    const p = sent("cu_dxb_02");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: "template", phone: PHONE.peter, template: "visit_scheduled", language: "en" });
    expect(messages("cu_dxb_02", "visit_scheduled")).toEqual([{ channel: "whatsapp", template: "visit_scheduled" }]);
    expect(emails("peter.nowak@example.com")).toEqual([]);
  });

  test("a quotation sent to the customer carries the approval link", async () => {
    const q = rows("select id, customer_id, number from app__quotes where status = 'draft' and branch_id = 'br_dubai' order by number limit 1")[0] as { id: string; customer_id: string; number: string };
    const before = sent(q.customer_id).length;
    const res = await dubai.action(`/quotes/${q.id}`, "send", {});
    expect(res.status).toBe(200);
    expect(messages(q.customer_id, "quote_sent")).toHaveLength(1);
    const all = sent(q.customer_id);
    expect(all).toHaveLength(before + 1);
    const last = all[all.length - 1];
    expect(last?.template).toBe("quote_sent");
    expect(last?.text).toContain(q.number);
    expect(last?.text).toMatch(/https?:\/\/[^ ]*\/l\/approve\/[A-Za-z0-9_-]{43}/u);
  });
});

describe("a customer without a phone", () => {
  test("gets the email version, with the Arabic subject for an Arabic customer", async () => {
    // Layla Haddad (Arabic): J-000001 is scheduled while her phone is blank.
    setContact("cu_dxb_01", "", "layla.haddad@example.com");
    expect((await schedule("jb_seed_01")).status).toBe(303);
    expect(messages("cu_dxb_01", "visit_scheduled")).toEqual([{ channel: "email", template: "visit_scheduled" }]);
    const mail = emails("layla.haddad@example.com").filter((m) => String(m.subject).includes("J-000001"));
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toBe("تم تحديد موعد زيارتك J-000001");
    expect(outboxOf(rows, PHONE.layla).filter((p) => p.template === "visit_scheduled")).toEqual([]);
    setContact("cu_dxb_01", "+971501110001", "layla.haddad@example.com");
  });

  test("with no email either, the message is recorded as no channel on the job's timeline", async () => {
    setContact("cu_dxb_03", "", null);
    expect((await schedule("jb_seed_08")).status).toBe(303);
    expect(messages("cu_dxb_03", "visit_scheduled").map((m) => m.channel)).toEqual(["whatsapp", "none"]);
    const event = rows("select note from app__job_events where job_id = 'jb_seed_08' and to_status is null order by id desc limit 1")[0];
    expect(String(event?.note)).toContain("no channel");
    setContact("cu_dxb_03", "+971551110003", null);
  });
});

describe("a second message to the same customer", () => {
  test("moving another job of his queues a second message with the new job's number", async () => {
    // Peter again: J-000006 is moved to a new time.
    expect((await schedule("jb_seed_06")).status).toBe(303);
    await settled();
    const p = sent("cu_dxb_02");
    expect(p).toHaveLength(2);
    expect(p[1]).toMatchObject({ kind: "template", phone: PHONE.peter, template: "visit_scheduled", language: "en" });
    expect(p[1]?.params.slice(0, 2)).toEqual(["Peter Nowak", "J-000006"]);
    expect(messages("cu_dxb_02", "visit_scheduled").map((m) => m.channel)).toEqual(["whatsapp", "whatsapp"]);
  });
});

describe("the technician's flow tells the customer", () => {
  let reportPath = "";

  test("on the way, then the report link that opens the report page and its PDF", async () => {
    expect((await dubai.action("/jobs/jb_seed_06", "status", { to: "en_route" })).status).toBe(303);
    const way = sent("cu_dxb_02").filter((p) => p.template === "technician_on_the_way");
    expect(way).toHaveLength(1);
    expect(way[0]?.params).toEqual(expect.arrayContaining(["Ali Hassan", "J-000006"]));
    expect((await ali.action("/me/visits/jb_seed_06", "checkin", {})).status).toBe(303);
    expect((await ali.action("/me/visits/jb_seed_06", "checkout", {})).status).toBe(303);
    const ready = sent("cu_dxb_02").filter((p) => p.template === "report_ready");
    expect(ready).toHaveLength(1);
    reportPath = /(\/l\/report\/[A-Za-z0-9_-]{43})/u.exec(String(ready[0]?.text))?.[1] ?? "";
    expect(reportPath).not.toBe("");
    const page = await customer.page(reportPath);
    expect(page.status).toBe(200);
    expect(page.html).toContain("J-000006");
    const pdf = await customer.page(`${reportPath}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.html.startsWith("%PDF")).toBe(true);
  });

  test("the dispatcher who made the job is told the visit is done", () => {
    const n = rows("select category, title, link from notifications__items where user_id = 'u_dxb_dispatcher' and title = 'Visit of job J-000006 is done'");
    expect(n).toEqual([{ category: "jobs", title: "Visit of job J-000006 is done", link: "/jobs/jb_seed_06" }]);
  });

  test("error case: a link that was never issued, or whose token is cut, is a 404", async () => {
    expect((await customer.page(`/l/report/${"A".repeat(43)}`)).status).toBe(404);
    expect((await customer.page(`${reportPath.slice(0, -3)}`)).status).toBe(404);
    expect((await customer.page(`${reportPath.slice(0, -3)}/pdf`)).status).toBe(404);
  });
});

describe("a customer's reply", () => {
  test("error case: a webhook with a wrong signature is a 401 and nothing reaches the app", async () => {
    const res = await inbound("971501110001", "cancel", "not-the-secret");
    expect(res.status).toBe(401);
    expect(rows("select 1 from whatsapp__messages where direction = 'in'")).toEqual([]);
    expect(rows("select 1 from renox__outbox where name = 'whatsapp.message_received'")).toEqual([]);
    expect(rows("select 1 from app__tasks")).toEqual([]);
    expect(rows("select 1 from whatsapp__messages where phone = '+971501110001' and direction = 'in'")).toEqual([]);
  });

  test("normal case: cancel from Layla becomes a task on her next scheduled job and a notification to its dispatcher, with no job run", async () => {
    const live = rows("select id, number from app__jobs where customer_id = 'cu_dxb_01' and status = 'scheduled' order by scheduled_start limit 1")[0] as { id: string; number: string };
    const stream = await dubai.sse("/notifications/sse/notifications");
    expect(stream.status).toBe(200);
    expect((await inbound("971501110001", "Cancel", undefined, "wamid.layla-cancel")).status).toBe(200);
    // The webhook alone: the event reaches hooks.ts after its commit (no t.job, no scheduled tick).
    await handled();
    const tasks = rows("select branch_id, kind, job_id, message, done_at from app__tasks");
    expect(tasks).toEqual([{ branch_id: "br_dubai", kind: "cancel", job_id: live.id, message: `Layla Haddad asked to cancel job ${live.number}.`, done_at: null }]);
    expect(rows("select count(*) as n from app__tasks where message_id = (select id from whatsapp__messages where wa_id = 'wamid.layla-cancel')")[0]?.n).toBe(1);
    const n = rows("select category, title, link from notifications__items where user_id = 'u_dxb_dispatcher' and title like 'Layla Haddad asked%'");
    expect(n).toEqual([{ category: "jobs", title: `Layla Haddad asked to cancel job ${live.number}.`, link: `/jobs/${live.id}` }]);
    expect(rows("select note from app__job_events where job_id = ? order by id desc limit 1", [live.id])[0]?.note).toBe("customer reply on WhatsApp: cancel");
    // The dispatcher's badge moves over SSE through the notifications module.
    let seen: string | null = null;
    for (let e = await stream.next(3000); e !== null && seen === null; e = await stream.next(3000)) if (e.event === "notif-badge") seen = e.data;
    expect(seen).not.toBeNull();
    stream.close();
  });

  test("a message is handled once: Meta's retry of the same delivery adds nothing", async () => {
    const notes = rows("select count(*) as n from notifications__items")[0]?.n;
    expect((await inbound("971501110001", "Cancel", undefined, "wamid.layla-cancel")).status).toBe(200);
    await handled();
    expect(rows("select count(*) as n from whatsapp__messages where wa_id = 'wamid.layla-cancel'")[0]?.n).toBe(1);
    expect(rows("select count(*) as n from app__tasks")[0]?.n).toBe(1);
    expect(rows("select count(*) as n from notifications__items")[0]?.n).toBe(notes);
  });

  test("and the app's handler is idempotent: a second delivery of the event to the app adds nothing", async () => {
    const notes = rows("select count(*) as n from notifications__items")[0]?.n;
    const message = rows("select id, phone from whatsapp__messages where wa_id = 'wamid.layla-cancel'")[0] as { id: string; phone: string };
    // A redelivery, as the outbox makes one after a crash between the handler's commit and its bookkeeping:
    // t.deliver writes the durable delivery of whatsapp's event to the app the way the broker writes it,
    // and resolves once the app's handler has run (it rejects if the handler failed or the delivery died).
    await t.deliver("whatsapp.message_received", { message_id: message.id, from: message.phone }, { module: "whatsapp" });
    expect(rows("select count(*) as n from app__tasks")[0]?.n).toBe(1);
    expect(rows("select count(*) as n from notifications__items")[0]?.n).toBe(notes);
  });

  test("an Arabic reschedule from Fatima becomes a reschedule task", async () => {
    expect((await inbound("971551110003", "تغيير الموعد")).status).toBe(200);
    await handled();
    expect(rows("select kind, job_id from app__tasks where message like 'Fatima%'")).toEqual([{ kind: "reschedule", job_id: "jb_seed_08" }]);
  });

  test("edge case: an unknown number, or a text that is no keyword, creates nothing but an inbox row", async () => {
    const tasks = rows("select count(*) as n from app__tasks")[0]?.n;
    const notes = rows("select count(*) as n from notifications__items")[0]?.n;
    expect((await inbound("971509999999", "cancel")).status).toBe(200);
    expect((await inbound("971501110001", "thank you")).status).toBe(200);
    await handled();
    expect(rows("select count(*) as n from whatsapp__messages where direction = 'in' and phone = '+971509999999'")[0]?.n).toBe(1);
    expect(rows("select count(*) as n from app__tasks")[0]?.n).toBe(tasks);
    expect(rows("select count(*) as n from notifications__items")[0]?.n).toBe(notes);
  });

  test("edge case: a phone with 201 earlier inbound messages still gets its cancel task (the message is read by id, not found in a page)", async () => {
    const tasks = Number(rows("select count(*) as n from app__tasks")[0]?.n);
    rw((db) => db.transaction(() => {
      const q = db.query("insert into whatsapp__messages (id, direction, kind, wa_id, phone, body, status, at, updated_at) values (?, 'in', 'text', ?, '+971501110001', 'thanks', 'received', ?, ?)");
      for (let i = 0; i < 201; i++) q.run(`01HSBULK${String(i).padStart(18, "0")}`, `wamid.bulk${i}`, Date.now() + i, Date.now() + i);
    }).immediate());
    expect((await inbound("971501110001", "cancel", undefined, "wamid.layla-cancel-late")).status).toBe(200);
    await handled();
    expect(rows("select count(*) as n from app__tasks")[0]?.n).toBe(tasks + 1);
    expect(rows("select count(*) as n from app__tasks where message_id = (select id from whatsapp__messages where wa_id = 'wamid.layla-cancel-late')")[0]?.n).toBe(1);
  });
});

describe("the ownership fence", () => {
  test("every task repeats its job's branch", () => {
    expect(rows("select count(*) as n from app__tasks k join app__jobs j on j.id = k.job_id where k.branch_id != j.branch_id")[0]?.n).toBe(0);
  });
});

describe("the owner's WhatsApp page (/admin/whatsapp)", () => {
  const owner = t.as("owner");
  let signedIn = false;
  const asOwner = async () => {
    if (!signedIn) {
      expect((await owner.action("/auth/login", "default", { email: "owner@fixit.example", password: PASSWORD, next: "/admin/whatsapp" })).status).toBe(303);
      signedIn = true;
    }
    return owner;
  };
  /** The page's rows with what moves between runs (ids, times) masked, for the snapshots. */
  const table = (html: string) => (/<table id="whatsapp-outbox"[\s\S]*?<\/table>/u.exec(html)?.[0] ?? "").replace(/id="wa-[^"]*"/gu, 'id="wa-<id>"').replace(/<td dir="ltr">\d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/td>/gu, '<td dir="ltr"><time></td>');
  const plant = (id: string, kind: string, phone: string, body: string, status: string, at: number, error: string | null = null) =>
    rw((db) => db.run("insert into whatsapp__messages (id, direction, kind, phone, body, status, error, at, updated_at) values (?, 'out', ?, ?, ?, ?, ?, ?, ?)", [id, kind, phone, body, status, error, at, at]));

  test("normal case: after a quotation is sent the page lists the message as sent, with the phone masked", async () => {
    const q = rows("select customer_id, number from app__quotes where status = 'sent' and branch_id = 'br_dubai' order by number limit 1")[0] as { customer_id: string; number: string };
    const phone = String(rows("select phone from app__customers where id = ?", [q.customer_id])[0]?.phone);
    const page = await (await asOwner()).page("/admin/whatsapp");
    expect(page.status).toBe(200);
    expect(page.html).toContain('id="whatsapp-outbox"');
    const row = new RegExp(`<tr id="wa-[^"]*">(?:(?!</tr>)[\\s\\S])*quote_sent(?:(?!</tr>)[\\s\\S])*</tr>`, "u").exec(page.html)?.[0] ?? "";
    expect(row).toContain("status-sent");
    expect(row).toContain("Sent");
    // Only the last four digits show, inside a left-to-right element; the number itself is nowhere on the page.
    expect(row).toContain(`<span dir="ltr">+${"•".repeat(phone.replace(/\D/gu, "").length - 4)}${phone.slice(-4)}</span>`);
    expect(page.html).not.toContain(phone);
    // No resend: the table holds no form and no button.
    expect(table(page.html)).not.toMatch(/<(button|form|input)/u);
  });

  test("an OTP's body is never shown, and a text is cut at 80 characters", async () => {
    const at = Date.now();
    plant("wa_t_otp", "otp", "+971500000042", "SEALED-CODE-654321", "queued", at);
    plant("wa_t_text", "text", "+971500000043", `${"x".repeat(80)}TAIL`, "sent", at + 1);
    const page = await (await asOwner()).page("/admin/whatsapp");
    expect(page.html).not.toContain("SEALED-CODE-654321");
    expect(page.html).not.toContain("654321");
    expect(page.html).toContain("[otp]");
    expect(page.html).toContain(`${"x".repeat(80)}…`);
    expect(page.html).not.toContain("TAIL");
  });

  test("the filters: by status, and by phone as the customer form normalises it", async () => {
    plant("wa_t_failed", "text", "+971500000044", "Failed message body", "failed", Date.now() + 2);
    const u = await asOwner();
    const failed = await u.page("/admin/whatsapp?status=failed");
    expect(failed.html).toContain("Failed message body");
    expect(failed.html).toContain("status-failed");
    expect(failed.html).not.toContain("status-sent");
    // A number typed with spaces and the 00 prefix finds the same row.
    const byPhone = await u.page("/admin/whatsapp?phone=00971%2050%20000%200044");
    expect(byPhone.html).toContain("Failed message body");
    expect(byPhone.html).not.toContain("quote_sent");
    expect((await u.page("/admin/whatsapp?phone=not-a-phone")).html).toContain('<tr><td colspan="4">');
    // The newest message comes first.
    const all = await u.page("/admin/whatsapp");
    expect(all.html.indexOf("Failed message body")).toBeLessThan(all.html.indexOf("quote_sent"));
  });

  test("error case: a dispatcher gets 403, and nobody is shown the page signed out", async () => {
    expect((await dubai.page("/admin/whatsapp")).status).toBe(403);
    expect((await t.as("anonymous").page("/admin/whatsapp")).status).not.toBe(200);
  });

  test("in Arabic: the page and its table", async () => {
    const u = await asOwner();
    const en = await u.page("/admin/whatsapp?status=failed");
    snapshot(table(en.html), { role: "whatsapp outbox, failed, owner, en" });
    expect((await u.page("/admin/whatsapp?lang=ar")).status).toBe(200);
    const ar = await u.page("/admin/whatsapp?status=failed");
    expect((await u.page("/admin/whatsapp?lang=en")).status).toBe(200);
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.html).toContain("رسائل واتساب");
    snapshot(table(ar.html), { role: "whatsapp outbox, failed, owner, ar" });
  });

  test("a failed message shows the module's failure reason after its status; a sent one shows none (#771)", async () => {
    plant("wa_t_reason", "text", "+971500000045", "Reason message body", "failed", Date.now() + 3, "400 (131026)");
    const page = await (await asOwner()).page("/admin/whatsapp?status=failed");
    const row = /<tr id="wa-wa_t_reason">[\s\S]*?<\/tr>/u.exec(page.html)?.[0] ?? "";
    expect(row).toContain("status-failed");
    expect(row).toMatch(/Failed<\/span><br><small class="muted">Reason: <span dir="ltr">400 \(131026\)<\/span><\/small>/u);
    const all = await (await asOwner()).page("/admin/whatsapp");
    const sent = new RegExp(`<tr id="wa-[^"]*">(?:(?!</tr>)[\\s\\S])*quote_sent(?:(?!</tr>)[\\s\\S])*</tr>`, "u").exec(all.html)?.[0] ?? "";
    expect(sent).toContain("status-sent");
    expect(sent).not.toContain("Reason");
  });

  test("with the module in sandbox mode the page says nothing leaves the server, also when no message is listed (#771)", async () => {
    const u = await asOwner();
    const page = await u.page("/admin/whatsapp");
    expect(page.html).toContain('<p class="notice" id="whatsapp-sandbox" role="note">Sandbox: nothing leaves this server.');
    const empty = await u.page("/admin/whatsapp?phone=not-a-phone");
    expect(empty.html).toContain('<tr><td colspan="4">');
    expect(empty.html).toContain('id="whatsapp-sandbox"');
    expect((await u.page("/admin/whatsapp?lang=ar")).html).toContain("وضع التجربة: لا يخرج شيء من هذا الخادم.");
    expect((await u.page("/admin/whatsapp?lang=en")).status).toBe(200);
  });
});

// The booking module's reminders (#799): the module queues a run 24 h and 2 h before a confirmed booking and
// runs its hook `booking.remind` first; hooks.ts fills it (lib/reminders.ts). The runs are queued for a day two
// weeks away, so each test runs one now with `t.job` and the payload the module queued.
describe("the visit reminders (booking.remind)", () => {
  const bookingOf = (job: string) => String(rows("select booking_id from app__jobs where id = ?", [job])[0]?.booking_id);
  const remind = (booking: string, kind: "24h" | "2h") => t.job("reminder", { module: "booking", payload: { booking_id: booking, kind } });
  const reminders = (customerId: string) => sent(customerId).filter((m) => m.template.startsWith("reminder_"));
  const branchPhone = String(rows("select phone from app__branches where id = 'br_dubai'")[0]?.phone);
  /** `schedule`, a week later than that helper's Monday: Ali's first Monday is full by now (still within the module's 30 days). */
  const scheduleNextWeek = async (job: string) => {
    const day = new Date(Date.parse(`${monday()}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const page = await dubai.page(`/jobs/${job}?day=${day}&technician=${ALI}`);
    const slot = new RegExp(`value="(${ALI}@\\d+)"`, "u").exec(page.html)?.[1];
    expect(slot).toBeDefined();
    return dubai.action(`/jobs/${job}`, "schedule", { slot: slot as string });
  };
  /** Waits until nothing is queued any more (the whatsapp-page tests above leave failed and queued rows on purpose, so `settled()` does not fit here). */
  const delivered = async () => {
    for (let i = 0; i < 100 && Number(rows("select count(*) as n from whatsapp__messages where direction = 'out' and status = 'queued' and body like '%reminder_%'")[0]?.n) > 0; i++) await Bun.sleep(50);
    expect(rows("select 1 from whatsapp__messages where direction = 'out' and status = 'queued' and body like '%reminder_%'")).toEqual([]);
  };
  const mailCount = () => Number(rows("select count(*) as n from email__messages")[0]?.n);

  test("normal case: the 24 h and the 2 h run each send one WhatsApp message, with the service, the Dubai time window and the branch phone", async () => {
    expect((await scheduleNextWeek("jb_seed_04")).status).toBe(303);
    const booking = bookingOf("jb_seed_04");
    const job = rows("select number, scheduled_start, scheduled_end from app__jobs where id = 'jb_seed_04'")[0] as { number: string; scheduled_start: number; scheduled_end: number };
    const clock = (s: number) => new Date(s * 1000 + 4 * 3_600_000).toISOString().slice(11, 16);
    const day = new Date(job.scheduled_start * 1000 + 4 * 3_600_000).toISOString().slice(0, 10);
    await remind(booking, "24h");
    await remind(booking, "2h");
    await delivered();
    const p = reminders("cu_dxb_05");
    expect(p.map((m) => m.template)).toEqual(["reminder_24h", "reminder_2h"]);
    expect(branchPhone).not.toBe("");
    for (const m of p) {
      expect(m).toMatchObject({ kind: "template", phone: "+971561110005", language: "en", status: "sent" });
      expect(m.params[0]).toBe("Al Barsha Facilities LLC");
      expect(m.text).toContain(job.number);
      expect(m.text).toContain(`${day} ${clock(job.scheduled_start)}-${clock(job.scheduled_end)}`);
      expect(m.params.at(-1)).toBe(branchPhone);
    }
    expect(messages("cu_dxb_05", "reminder_24h")).toEqual([{ channel: "whatsapp", template: "reminder_24h" }]);
    expect(messages("cu_dxb_05", "reminder_2h")).toEqual([{ channel: "whatsapp", template: "reminder_2h" }]);
  });

  test("an Arabic customer gets the Arabic text, and booking sends no email of its own to an app customer", async () => {
    const before = emails("layla.haddad@example.com").length;
    const mails = mailCount();
    expect((await scheduleNextWeek("jb_seed_05")).status).toBe(303);
    const booking = bookingOf("jb_seed_05");
    await remind(booking, "24h");
    await delivered();
    const p = reminders("cu_dxb_01");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: "template", phone: PHONE.layla, template: "reminder_24h", language: "ar" });
    expect(p[0]?.params[0]).toBe("Layla Haddad");
    expect(p[0]?.params[2]).toBe("J-000005");
    expect(emails("layla.haddad@example.com")).toHaveLength(before);
    expect(mailCount()).toBe(mails);
    // The module's own mark is there: the run went through the hook and nothing else was sent.
    expect(rows("select kind from booking__reminders where booking_id = ?", [booking])).toEqual([{ kind: "24h" }]);
  });

  test("edge case: a cancelled visit sends nothing, and booking still sends no email", async () => {
    expect((await scheduleNextWeek("jb_seed_03")).status).toBe(303);
    const booking = bookingOf("jb_seed_03");
    rw((db) => db.run("update app__jobs set status = 'cancelled' where id = 'jb_seed_03'"));
    const mails = mailCount();
    await remind(booking, "24h");
    await remind(booking, "2h");
    await delivered();
    expect(reminders("cu_dxb_04")).toEqual([]);
    expect(messages("cu_dxb_04", "reminder_24h")).toEqual([]);
    expect(mailCount()).toBe(mails);
  });

  test("edge case: one run delivered twice sends one message, also when the module's own mark is gone", async () => {
    expect((await scheduleNextWeek("jb_seed_02")).status).toBe(303);
    const booking = bookingOf("jb_seed_02");
    await remind(booking, "2h");
    await remind(booking, "2h");
    await delivered();
    expect(reminders("cu_dxb_02").filter((m) => m.template === "reminder_2h")).toHaveLength(1);
    // The app's own guard: with the module's row removed, the run reaches the hook again and sends nothing new.
    rw((db) => db.run("delete from booking__reminders where booking_id = ?", [booking]));
    await remind(booking, "2h");
    await delivered();
    expect(reminders("cu_dxb_02").filter((m) => m.template === "reminder_2h")).toHaveLength(1);
    expect(messages("cu_dxb_02", "reminder_2h")).toHaveLength(1);
  });
});
