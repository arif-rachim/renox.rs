// POST /api/setup (#711; deploy-api.md section 21): the platform's one-time
// call with the company's first data. The token is checked (a forged one,
// one for another app and an expired one are 401), only POST is served, a
// body out of the limits is 422 and writes nothing, the first call writes the
// settings, the services and the owner's account with the role `owner`, a
// second one is 409. The same call makes the branches `org` organisations and
// invites the people (`org.bootstrap`, #747), each with their app role: all of
// it exists before any page is opened. The demo seed is never loaded.
//
// `renox test --seed` loads the demo seed into every test file's tenant, so
// this file empties the tables the seed fills first: the app starts as the
// platform creates it.
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

setDefaultTimeout(60_000);
const t = await app();

/** `.env.test`: the platform's key for this app. */
const KEY = "home-services-test-setup-key";
/** The test worker serves the app on `test.localhost`: its name is the first label. */
const APP = "test";
const HASH = "3036375ec4507cc45555acd94592bcfa44a0884fee861d99bee24a45f917b164";
const OWNER = "owner@coolair.ae";
/** The header the app reads the token from (functions/api/setup.ts: the platform removes `x-renox-*` headers of a request). */
const HEADER = "renox-setup";

/** A token as the API's `mintSetupToken` makes it (control/api/src/signup/templates.ts). */
function mint(o: { key?: string; app?: string; exp?: number } = {}): string {
  const body = `v1.${o.app ?? APP}.${HASH}.${o.exp ?? Date.now() + 600_000}`;
  return `${body}.${createHmac("sha256", o.key ?? KEY).update(body).digest("base64url")}`;
}

const SETUP = {
  company: { name: "CoolAir", trn: "100123456700003", phone: "+971501234567", emirate: "dubai" },
  branches: [
    { name: "Dubai", emirate: "dubai" },
    { name: "Sharjah", emirate: "sharjah" },
  ],
  services: [
    { name: "AC service", price_aed: 150 },
    { name: "Deep clean", price_aed: 320.5 },
  ],
  people: [
    { email: "Tech@CoolAir.ae", role: "technician" },
    { email: "books@coolair.ae", role: "accountant" },
    { email: "boss@coolair.ae", role: "manager" },
  ],
  owner: { email: OWNER },
};

const caller = t.as("platform");
const post = (body: unknown, token: string | null = mint()) => caller.request("POST", "/api/setup", { headers: { accept: "application/json", ...(token === null ? {} : { [HEADER]: token }) }, body: body as Record<string, unknown> });

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);
const count = (table: string): number => Number(rows(`select count(*) as n from ${table}`)[0]?.n);
const setting = (key: string): string | undefined => rows("select value from app__settings where key = ?", [key])[0]?.value as string | undefined;

/** Polls until `f` returns something other than undefined (mail is queued by the modules in the same request, read here after it). */
async function until<T>(f: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
    const v = f();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The tables `seeds/001_demo.sql` fills. */
const SEEDED = [
  "app__visit_parts", "app__visit_photos", "app__visits", "app__payments", "app__job_invoices", "app__job_events", "app__jobs", "app__job_numbers",
  "app__contract_items", "app__contracts", "app__contract_numbers", "app__quote_lines", "app__quotes", "app__quote_numbers", "app__links",
  "app__sites", "app__customers", "app__services", "app__branch_hours", "app__branches", "app__settings",
  "booking__staff_services", "booking__staff", "booking__services", "booking__hours", "booking__bookings",
  "tax_gcc__documents", "tax_gcc__sequences", "org__invites", "org__members", "org__orgs", "app__staff_invites", "auth__users", "renox__role_assignments",
];

beforeAll(() => {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  try {
    db.transaction(() => {
      for (const table of SEEDED) db.run(`delete from ${table}`);
      // What migrations/001_core.sql writes.
      db.run("insert into app__settings (key, value) values ('brand_name', 'Home Services'), ('brand_logo_key', ''), ('brand_color', '#e8634a'), ('brand_footer_en', ''), ('brand_footer_ar', ''), ('accounts_email', ''), ('whatsapp_sandbox', '1')");
    })();
  } finally {
    db.close();
  }
});

describe("the token", () => {
  test("a missing, malformed or forged token, one for another app and an expired one are 401, and nothing is written", async () => {
    const parts = mint().split(".");
    const moved = [...parts.slice(0, 3), String(Date.now() + 3_600_000), parts[4]].join(".");
    const cases: [string, string | null][] = [
      ["missing", null],
      ["garbage", "garbage"],
      ["v2", mint().replace(/^v1\./u, "v2.")],
      ["another key", mint({ key: "another-key" })],
      ["another app", mint({ app: "coolair" })],
      ["expired", mint({ exp: Date.now() - 1 })],
      ["expiry moved", moved],
    ];
    for (const [label, token] of cases) {
      const r = await post(SETUP, token);
      expect([label, r.status]).toEqual([label, 401]);
      expect(r.html).not.toContain(KEY);
    }
    expect(setting("setup_hash")).toBeUndefined();
    expect(count("auth__users")).toBe(0);
  });

  test("a valid token in x-renox-setup never reaches the app: the platform removes x-renox-* request headers, so it is 401", async () => {
    const r = await caller.request("POST", "/api/setup", { headers: { "x-renox-setup": mint() }, body: SETUP });
    expect(r.status).toBe(401);
    expect(setting("setup_hash")).toBeUndefined();
  });

  test("only POST is served: 405", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const r = await caller.request(method, "/api/setup", { headers: { [HEADER]: mint() } });
      expect([method, r.status]).toEqual([method, 405]);
    }
  });
});

describe("the body", () => {
  test("a body out of the limits of section 21 is 422 with the field, and writes nothing", async () => {
    const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
    const bad: [string, unknown, string][] = [
      ["not JSON", "{", "body"],
      ["no company name", { ...SETUP, company: { ...SETUP.company, name: " " } }, "company.name"],
      ["phone", { ...SETUP, company: { ...SETUP.company, phone: "050 123" } }, "company.phone"],
      ["trn", { ...SETUP, company: { ...SETUP.company, trn: "123" } }, "company.trn"],
      ["emirate", { ...SETUP, company: { ...SETUP.company, emirate: "riyadh" } }, "company.emirate"],
      ["no branches", { ...SETUP, branches: [] }, "branches"],
      ["six branches", { ...SETUP, branches: many(6, (i) => ({ name: `B${i}`, emirate: "dubai" })) }, "branches"],
      ["no services", { ...SETUP, services: [] }, "services"],
      ["price", { ...SETUP, services: [{ name: "AC", price_aed: -1 }] }, "services[0].price_aed"],
      ["21 people", { ...SETUP, people: many(21, (i) => ({ email: `p${i}@x.ae`, role: "technician" })) }, "people"],
      ["a role outside [authz.default_roles]", { ...SETUP, people: [{ email: "p@x.ae", role: "admin" }] }, "people[0].role"],
      ["twice", { ...SETUP, people: [{ email: "p@x.ae", role: "technician" }, { email: "P@x.ae", role: "accountant" }] }, "people[1].email"],
      ["no owner", { ...SETUP, owner: undefined }, "owner"],
      ["extra key", { ...SETUP, extra: 1 }, "extra"],
    ];
    for (const [label, body, field] of bad) {
      const r = await caller.request("POST", "/api/setup", { headers: { [HEADER]: mint(), "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
      expect([label, r.status]).toEqual([label, 422]);
      expect([label, Object.keys(r.json<{ errors: Record<string, string> }>().errors)]).toEqual([label, expect.arrayContaining([field])]);
    }
    expect(setting("setup_hash")).toBeUndefined();
    expect(count("app__services")).toBe(0);
    expect(count("auth__users")).toBe(0);
  });
});

describe("the setup", () => {
  test("writes the settings, the services, the owner with the role owner, the branches and the invitations; a second call is 409 and changes nothing; no demo row", async () => {
    const r = await post(SETUP);
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({
      invited: [
        { email: "tech@coolair.ae", role: "technician" },
        { email: "books@coolair.ae", role: "accountant" },
        { email: "boss@coolair.ae", role: "branch_manager" },
      ],
      skipped: [],
    });
    expect({ brand: setting("brand_name"), phone: setting("company_phone"), trn: setting("company_trn"), emirate: setting("company_emirate"), hash: setting("setup_hash") }).toEqual({
      brand: "CoolAir",
      phone: "+971501234567",
      trn: "100123456700003",
      emirate: "dubai",
      hash: HASH,
    });
    expect(rows("select code, name_en, unit, price_fils, vat_rate, active, branch_id from app__services order by id")).toEqual([
      { code: "AC-SERVICE", name_en: "AC service", unit: "visit", price_fils: 15000, vat_rate: 5, active: 1, branch_id: null },
      { code: "DEEP-CLEAN", name_en: "Deep clean", unit: "visit", price_fils: 32050, vat_rate: 5, active: 1, branch_id: null },
    ]);
    const owner = rows("select id, email from auth__users")[0] as { id: string; email: string };
    expect(owner.email).toBe(OWNER);
    expect(rows("select role, scope_type from renox__role_assignments where user_id = ?", [owner.id])).toEqual([{ role: "owner", scope_type: "global" }]);
    // Everything is in the call: no pending state, no page needed.
    expect(setting("setup_pending")).toBeUndefined();
    expect(setting("setup_owner_email")).toBeUndefined();
    const branches = rows("select b.id, b.slug, b.name_en, b.emirate, o.name as org_name, m.role from app__branches b join org__orgs o on o.id = b.org_id join org__members m on m.org_id = b.org_id and m.user_id = ? order by b.created_at, b.id", [owner.id]);
    expect(branches).toEqual([
      { id: "br_dubai", slug: "dubai", name_en: "Dubai", emirate: "dubai", org_name: "Dubai", role: "owner" },
      { id: "br_sharjah", slug: "sharjah", name_en: "Sharjah", emirate: "sharjah", org_name: "Sharjah", role: "owner" },
    ]);
    expect(rows("select distinct branch_id from app__branch_hours order by branch_id").map((r) => r.branch_id)).toEqual(["br_dubai", "br_sharjah"]);
    expect(rows("select i.email, i.role from org__invites i join app__branches b on b.org_id = i.org_id where b.id = 'br_dubai' order by i.email")).toEqual([
      { email: "books@coolair.ae", role: "member" },
      { email: "boss@coolair.ae", role: "member" },
      { email: "tech@coolair.ae", role: "member" },
    ]);
    expect(count("org__invites")).toBe(3);
    expect(rows("select email, role, invited_by, applied_at from app__staff_invites where branch_id = 'br_dubai' order by email")).toEqual([
      { email: "books@coolair.ae", role: "accountant", invited_by: owner.id, applied_at: null },
      { email: "boss@coolair.ae", role: "branch_manager", invited_by: owner.id, applied_at: null },
      { email: "tech@coolair.ae", role: "technician", invited_by: owner.id, applied_at: null },
    ]);
    expect(count("app__staff_invites")).toBe(3);
    // One mail each, from the same org.send_mail hook as org.invite.
    for (const to of ["tech@coolair.ae", "books@coolair.ae", "boss@coolair.ae"]) {
      await until(() => (rows("select 1 from email__messages where to_address = ?", [to]).length > 0 ? true : undefined), `the invitation mail of ${to}`);
      expect(rows("select 1 from email__messages where to_address = ?", [to])).toHaveLength(1);
    }
    expect(rows("select count(*) as n from audit__events where action = 'setup.write'")).toEqual([{ n: 1 }]);

    const again = await post({ ...SETUP, company: { ...SETUP.company, name: "Other" } });
    expect(again.status).toBe(409);
    expect(setting("brand_name")).toBe("CoolAir");
    expect(count("app__services")).toBe(2);
    expect(count("auth__users")).toBe(1);

    // Never the demo seed.
    expect(rows("select count(*) as n from app__customers")).toEqual([{ n: 0 }]);
    expect(count("app__jobs")).toBe(0);
    expect(count("app__quotes")).toBe(0);
  });

  test("the owner signs in with the mailed link; their first page changes nothing, and a person who accepts the invitation holds their staff role in the first branch (org.member_added applies app__staff_invites)", async () => {
    const mail = await until(() => rows("select text_body from email__messages where to_address = ?", [OWNER])[0]?.text_body as string | undefined, "the owner's mail");
    const link = /\/auth\/magic\/[0-9a-f]+/u.exec(mail)?.[0];
    expect(link).toBeDefined();
    const owner = t.as("owner");
    expect((await owner.request("GET", link as string)).status).toBe(303);
    expect((await owner.request("GET", "/")).status).toBe(200);
    expect((await owner.request("GET", "/")).status).toBe(200);
    expect(count("app__branches")).toBe(2);
    expect(count("org__orgs")).toBe(2);
    expect(count("org__invites")).toBe(3);
    expect(count("app__staff_invites")).toBe(3);
    expect(setting("setup_pending")).toBeUndefined();
    expect(rows("select count(*) as n from app__customers")).toEqual([{ n: 0 }]);

    const techMail = rows("select text_body from email__messages where to_address = 'tech@coolair.ae'")[0]?.text_body as string;
    const token = /\/org\/accept\/([A-Za-z0-9_-]+)/u.exec(techMail)?.[1] ?? "";
    expect(token).not.toBe("");
    const tech = t.as("tech");
    expect((await tech.action("/auth/register", "default", { email: "tech@coolair.ae", password: "correct-horse-battery-9", display_name: "Tariq Tech" })).status).toBe(200);
    expect((await tech.action("/auth/login", "default", { email: "tech@coolair.ae", password: "correct-horse-battery-9" })).status).toBe(303);
    expect((await tech.action(`/org/accept/${token}`, "accept", {})).status).toBe(303);
    const orgId = String(rows("select org_id from app__branches where id = 'br_dubai'")[0]?.org_id);
    const held = await until(() => {
      const r = rows("select scope_type, scope_id from renox__role_assignments where role = 'technician' and user_id = (select id from auth__users where email = 'tech@coolair.ae')");
      return r.length > 0 ? r : undefined;
    }, "the technician role");
    expect(held).toEqual([{ scope_type: "org", scope_id: orgId }]);
    expect(rows("select applied_at is not null as done from app__staff_invites where email = 'tech@coolair.ae'")).toEqual([{ done: 1 }]);
    expect(rows("select applied_at is not null as done from app__staff_invites where email = 'books@coolair.ae'")).toEqual([{ done: 0 }]);
  });
});
