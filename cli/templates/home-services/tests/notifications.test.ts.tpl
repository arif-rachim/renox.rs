// Notifications (F7-124): the customer's WhatsApp message (or email) at the
// moments that matter, the dispatcher's live badge, and a customer's "cancel"
// or "reschedule" reply becoming a task. Runs on the local worker with the
// seed's users (password below).
//
// The worker cannot reach a fake Cloud API (tenant fetch refuses private
// addresses) and the test secrets hold no WhatsApp token, so "whatsapp.send is
// called" is read from the module's own queue: one `whatsapp__messages` row of
// kind `template`, with the template's name, language, parameters and the
// customer's +971 number. The module's own tests cover the Cloud API calls.
import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@renoxium/sdk/test";

import { renderMessage } from "../lib/messages";
import { replyKind } from "../lib/reply";

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
const setSandbox = (on: boolean) => rw((db) => db.run("update app__settings set value = ? where key = 'whatsapp_sandbox'", [on ? "1" : "0"]));
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
const previews = (customerId: string) => rows("select channel, to_address, template, body from app__outbox_preview where customer_id = ? order by id", [customerId]);
const messages = (customerId: string, kind: string) => rows("select channel, template from app__customer_messages where customer_id = ? and kind = ? order by id", [customerId, kind]);
const waOut = (phone: string) => rows("select kind, phone, body, status from whatsapp__messages where direction = 'out' and phone = ? order by at", [phone]);
const emails = (to: string) => rows("select subject, text_body from email__messages where to_address = ? order by at", [to]);

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let seq = 0;
/** A signed delivery of one inbound text, as Meta sends it. */
async function inbound(from: string, text: string, secret = ENV.WHATSAPP_APP_SECRET as string) {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: `wamid.hs${++seq}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
  return t.request("POST", "/whatsapp/webhook/whatsapp", { headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${await hmac(secret, raw)}` }, body: raw });
}

/**
 * Runs the inbox sweep now, as the scheduler would: a tick of the job is
 * written the way `renox jobs run` writes one (the worker may be writing, so
 * the lock is taken first), and a signed message from a number nobody knows
 * wakes the outbox (it commits an event), which runs the tick.
 */
async function sweep(): Promise<void> {
  const id = `01HS${crypto.randomUUID().replace(/-/gu, "").slice(0, 22).toUpperCase()}`; // 26 characters, like the platform's ULIDs
  rw((db) =>
    db
      .transaction(() => {
        db.query("insert into renox__outbox (id, target, name, payload, module, created_at, attempts, next_at) values (?, 'app', 'job:inbox-sweep', 'null', 'app', ?, 0, ?)").run(id, Date.now(), Date.now());
        db.query("insert into renox__outbox_meta (key, value) values ('job_tick:app:inbox-sweep', ?) on conflict (key) do update set value = excluded.value").run(Date.now());
      })
      .immediate(),
  );
  expect((await inbound("971500000000", `ping ${++seq}`)).status).toBe(200);
  for (let i = 0; i < 200 && rows("select 1 from renox__outbox where id = ?", [id]).length > 0; i++) await Bun.sleep(50);
  expect(rows("select 1 from renox__outbox where id = ?", [id])).toEqual([]);
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

describe("with the WhatsApp sandbox on (the default)", () => {
  test("normal case: scheduling writes the preview and sends nothing on WhatsApp", async () => {
    // Fatima Al Suwaidi (Arabic, a phone, no email): J-000008 is moved to Ali.
    const before = rows("select count(*) as n from whatsapp__messages")[0]?.n;
    expect((await schedule("jb_seed_08")).status).toBe(303);
    const p = previews("cu_dxb_03");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ channel: "whatsapp", to_address: "+971551110003", template: "visit_scheduled" });
    // Edge case: the customer's language is Arabic: the Arabic body.
    expect(String(p[0]?.body)).toContain("مرحباً Fatima Al Suwaidi، تم تحديد موعد زيارتك J-000008");
    expect(messages("cu_dxb_03", "visit_scheduled")).toEqual([{ channel: "preview", template: "visit_scheduled" }]);
    expect(rows("select count(*) as n from whatsapp__messages")[0]?.n).toBe(before);
    expect(emails("fatima@example.com")).toEqual([]);
  });

  test("a customer with a phone and an email gets the preview and the email", async () => {
    // Peter Nowak (English): J-000002 is scheduled.
    expect((await schedule("jb_seed_02")).status).toBe(303);
    expect(previews("cu_dxb_02")).toHaveLength(1);
    expect(messages("cu_dxb_02", "visit_scheduled")).toEqual([{ channel: "email", template: "visit_scheduled" }]);
    const mail = emails("peter.nowak@example.com");
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toBe("Your visit J-000002 is scheduled");
    expect(waOut("+971521110002")).toEqual([]);
  });

  test("a quotation sent to the customer carries the approval link", async () => {
    const before = previews("cu_dxb_04").length;
    const q = rows("select id, customer_id, number from app__quotes where status = 'draft' and branch_id = 'br_dubai' order by number limit 1")[0] as { id: string; customer_id: string; number: string };
    const res = await dubai.action(`/quotes/${q.id}`, "send", {});
    expect(res.status).toBe(200);
    const sent = messages(q.customer_id, "quote_sent");
    expect(sent).toHaveLength(1);
    const p = previews(q.customer_id);
    expect(p.length).toBeGreaterThan(before === 0 ? 0 : -1);
    expect(String(p[p.length - 1]?.body)).toMatch(new RegExp(`${q.number}.*https?://[^ ]*/l/approve/[A-Za-z0-9_-]{43}`, "u"));
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
    expect(previews("cu_dxb_01").filter((p) => p.template === "visit_scheduled")).toEqual([]);
    setContact("cu_dxb_01", "+971501110001", "layla.haddad@example.com");
  });

  test("with no email either, the message is recorded as no channel on the job's timeline", async () => {
    setContact("cu_dxb_03", "", null);
    expect((await schedule("jb_seed_08")).status).toBe(303);
    expect(messages("cu_dxb_03", "visit_scheduled").map((m) => m.channel)).toEqual(["preview", "none"]);
    const event = rows("select note from app__job_events where job_id = 'jb_seed_08' and to_status is null order by id desc limit 1")[0];
    expect(String(event?.note)).toContain("no channel");
    setContact("cu_dxb_03", "+971551110003", null);
  });
});

describe("with the sandbox off", () => {
  test("normal case: whatsapp is called once with the visit_scheduled template and the +971 number", async () => {
    setSandbox(false);
    // Peter again: J-000006 is moved to a new time.
    expect((await schedule("jb_seed_06")).status).toBe(303);
    const sent = waOut("+971521110002");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "template", phone: "+971521110002" });
    expect(JSON.parse(String(sent[0]?.body))).toMatchObject({ name: "visit_scheduled", language: "en" });
    expect(JSON.parse(String(sent[0]?.body)).params.slice(0, 2)).toEqual(["Peter Nowak", "J-000006"]);
    expect(messages("cu_dxb_02", "visit_scheduled").map((m) => m.channel)).toEqual(["email", "whatsapp"]);
    // Live means no preview and no email for this message.
    expect(previews("cu_dxb_02")).toHaveLength(1);
    expect(emails("peter.nowak@example.com")).toHaveLength(1);
    setSandbox(true);
  });
});

describe("the technician's flow tells the customer", () => {
  let reportPath = "";

  test("on the way, then the report link that opens the report page and its PDF", async () => {
    expect((await dubai.action("/jobs/jb_seed_06", "status", { to: "en_route" })).status).toBe(303);
    const way = previews("cu_dxb_02").filter((p) => p.template === "technician_on_the_way");
    expect(way).toHaveLength(1);
    expect(String(way[0]?.body)).toContain("Ali Hassan is on the way for visit J-000006");
    expect((await ali.action("/me/visits/jb_seed_06", "checkin", {})).status).toBe(303);
    expect((await ali.action("/me/visits/jb_seed_06", "checkout", {})).status).toBe(303);
    const ready = previews("cu_dxb_02").filter((p) => p.template === "report_ready");
    expect(ready).toHaveLength(1);
    reportPath = /(\/l\/report\/[A-Za-z0-9_-]{43})/u.exec(String(ready[0]?.body))?.[1] ?? "";
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
    await sweep();
    expect(rows("select 1 from app__tasks")).toEqual([]);
    expect(rows("select 1 from whatsapp__messages where phone = '+971501110001' and direction = 'in'")).toEqual([]);
  });

  test("normal case: cancel from Layla becomes a task on her next scheduled job and a notification to its dispatcher", async () => {
    const live = rows("select id, number from app__jobs where customer_id = 'cu_dxb_01' and status = 'scheduled' order by scheduled_start limit 1")[0] as { id: string; number: string };
    const stream = await dubai.sse("/notifications/sse/notifications");
    expect(stream.status).toBe(200);
    expect((await inbound("971501110001", "Cancel")).status).toBe(200);
    await sweep();
    const tasks = rows("select branch_id, kind, job_id, message, done_at from app__tasks");
    expect(tasks).toEqual([{ branch_id: "br_dubai", kind: "cancel", job_id: live.id, message: `Layla Haddad asked to cancel job ${live.number}.`, done_at: null }]);
    const n = rows("select category, title, link from notifications__items where user_id = 'u_dxb_dispatcher' and title like 'Layla Haddad asked%'");
    expect(n).toEqual([{ category: "jobs", title: `Layla Haddad asked to cancel job ${live.number}.`, link: `/jobs/${live.id}` }]);
    expect(rows("select note from app__job_events where job_id = ? order by id desc limit 1", [live.id])[0]?.note).toBe("customer reply on WhatsApp: cancel");
    // The dispatcher's badge moves over SSE through the notifications module.
    let seen: string | null = null;
    for (let e = await stream.next(3000); e !== null && seen === null; e = await stream.next(3000)) if (e.event === "notif-badge") seen = e.data;
    expect(seen).not.toBeNull();
    stream.close();
  });

  test("a message is handled once: a second sweep adds nothing", async () => {
    await sweep();
    expect(rows("select count(*) as n from app__tasks")[0]?.n).toBe(1);
  });

  test("an Arabic reschedule from Fatima becomes a reschedule task", async () => {
    expect((await inbound("971551110003", "تغيير الموعد")).status).toBe(200);
    await sweep();
    expect(rows("select kind, job_id from app__tasks where message like 'Fatima%'")).toEqual([{ kind: "reschedule", job_id: "jb_seed_08" }]);
  });

  test("edge case: an unknown number, or a text that is no keyword, creates nothing but an inbox row", async () => {
    const tasks = rows("select count(*) as n from app__tasks")[0]?.n;
    const notes = rows("select count(*) as n from notifications__items")[0]?.n;
    expect((await inbound("971509999999", "cancel")).status).toBe(200);
    expect((await inbound("971501110001", "thank you")).status).toBe(200);
    await sweep();
    expect(rows("select count(*) as n from whatsapp__messages where direction = 'in' and phone = '+971509999999'")[0]?.n).toBe(1);
    expect(rows("select count(*) as n from app__tasks")[0]?.n).toBe(tasks);
    expect(rows("select count(*) as n from notifications__items")[0]?.n).toBe(notes);
  });
});

describe("the ownership fence", () => {
  test("every preview and task repeats its customer's or job's branch", () => {
    expect(rows("select count(*) as n from app__outbox_preview p join app__customers c on c.id = p.customer_id where p.branch_id != c.branch_id")[0]?.n).toBe(0);
    expect(rows("select count(*) as n from app__tasks k join app__jobs j on j.id = k.job_id where k.branch_id != j.branch_id")[0]?.n).toBe(0);
  });
});
