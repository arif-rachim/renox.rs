// The App MCP tools (F7-129): `next_free_slot`, `job_status` and `create_job`
// through the app's `/mcp`, as the agent of a signed-in user (an OAuth token of
// the auth module, the flow of modules/org/tests/tools.test.ts). Under the same
// policies as the pages: a dispatcher's token books a visit after the
// confirmation, a technician's token cannot, and the slots are the ones the job
// page's slot picker offers. The harness has no `t.tool()`, so the calls are
// JSON-RPC over `t.request` (see the platform gap in the report of F7-129).
// Runs on the local worker with the seed's users (password below).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

setDefaultTimeout(60_000);
const t = await app();
const PASSWORD = "correct horse battery";
const REDIRECT = "https://agent.example/callback";
const VERIFIER = "agent-verifier-0123456789abcdefghijklmnopqrstuvwxyz";

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);

async function signIn(jar: string, email: string) {
  const u = t.as(jar);
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD })).status).toBe(303);
  return u;
}

const challengeOf = async (verifier: string): Promise<string> => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

/** An agent token for `u` through registration, consent and the token endpoint. */
async function agentToken(u: Awaited<ReturnType<typeof signIn>>, scope?: string): Promise<string> {
  const reg = await t.request("POST", "/auth/oauth/register", { body: { client_name: "Booking Agent", redirect_uris: [REDIRECT] } });
  const clientId = reg.json<{ client_id: string }>().client_id;
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: await challengeOf(VERIFIER), code_challenge_method: "S256" });
  if (scope) q.set("scope", scope);
  const allow = await u.action("/auth/oauth/consent", "allow", Object.fromEntries(q));
  expect(allow.status).toBe(303);
  const code = new URL(allow.headers.get("location") as string).searchParams.get("code") as string;
  const tok = await t.request("POST", "/auth/oauth/token", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER }).toString(),
  });
  expect(tok.status).toBe(200);
  return tok.json<{ access_token: string }>().access_token;
}

let seq = 0;
const rpc = (token: string, method: string, params: unknown) => t.request("POST", "/mcp", { headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: "2.0", id: ++seq, method, params } });

type Result = { result: { isError?: boolean; structuredContent?: Record<string, unknown> & { preview?: Record<string, unknown>; confirmation?: { token: string } } } };
/** `tools/call`: the HTTP status and the structured content of the answer. */
async function call(token: string, name: string, args: Record<string, unknown>, confirmation?: string) {
  const res = await rpc(token, "tools/call", { name, arguments: args, ...(confirmation === undefined ? {} : { _meta: { "renox/confirmation": confirmation } }) });
  const body = res.status === 200 ? res.json<Result>().result : undefined;
  return { status: res.status, isError: body?.isError ?? false, out: (body?.structuredContent ?? {}) as Record<string, unknown> & { preview?: Record<string, unknown>; confirmation?: { token: string } }, text: res.html };
}

/** A Monday at least `after` days ahead (Dubai), as `YYYY-MM-DD`. */
function monday(after: number): string {
  const d = new Date(Date.now() + 4 * 3_600_000 + after * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const dina = await signIn("dina", "dispatcher.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
const dinaToken = await agentToken(dina);
const aliToken = await agentToken(ali);
const accountantToken = await agentToken(accountant);
// A user with no role and no branch: registers, signs in, connects an agent.
const stranger = t.as("stranger");
expect((await stranger.action("/auth/register", "default", { email: "stranger@example.com", password: PASSWORD, display_name: "Sam Stranger" })).status).toBe(200);
expect((await stranger.action("/auth/login", "default", { email: "stranger@example.com", password: PASSWORD })).status).toBe(303);
const strangerToken = await agentToken(stranger);

describe("the listing", () => {
  test("a dispatcher's agent sees the three tools, create_job as the destructive one", async () => {
    const list = await rpc(dinaToken, "tools/list", {});
    expect(list.status).toBe(200);
    const tools = list.json<{ result: { tools: { name: string; annotations: Record<string, boolean>; inputSchema: { required: string[] } }[] } }>().result.tools;
    expect(tools.map((x) => x.name)).toEqual(expect.arrayContaining(["create_job", "job_status", "next_free_slot"]));
    expect(tools.find((x) => x.name === "create_job")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((x) => x.name === "job_status")?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find((x) => x.name === "create_job")?.inputSchema.required).toEqual(["customer_phone", "service", "slot"]);
  });

  test("a token narrowed to one tool lists and calls only that one", async () => {
    const narrow = await agentToken(dina, "tools:job_status");
    const list = await rpc(narrow, "tools/list", {});
    expect(list.json<{ result: { tools: { name: string }[] } }>().result.tools.map((x) => x.name)).toEqual(["job_status"]);
    expect((await call(narrow, "create_job", { customer_phone: "+971501110001", service: "AC-SERVICE", slot: "x@1234567890" })).status).toBe(403);
  });
});

describe("job_status", () => {
  test("normal case: a seeded job's state, technician, time and invoice", async () => {
    const r = await call(dinaToken, "job_status", { number: "J-000013" });
    expect(r.status, r.text).toBe(200);
    expect(r.out).toMatchObject({ number: "J-000013", branch: "dubai", status: "invoiced", invoice: { number: "INV-000001", status: "part-paid" } });
    expect(typeof r.out.technician).toBe("string");
    expect(r.out.scheduled).toMatchObject({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) });
    // The number is not case sensitive.
    expect((await call(dinaToken, "job_status", { number: "j-000013" })).out.status).toBe("invoiced");
    const unscheduled = await call(dinaToken, "job_status", { number: "J-000002" });
    expect(unscheduled.out).toMatchObject({ number: "J-000002", invoice: null });
  });

  test("edge case: an unknown number, and a job of another branch, are a not_found object, not an exception", async () => {
    for (const number of ["J-999999", "J-000017"]) {
      const r = await call(dinaToken, "job_status", { number });
      expect(r.status).toBe(200);
      expect(r.isError).toBe(false);
      expect(r.out).toMatchObject({ error: "not_found" });
    }
  });

  test("error case: a technician reads their own job and gets forbidden for another's; an invalid input is a 400; an unverified user is a 403", async () => {
    const own = rows("select number from app__jobs where technician_user_id = 'u_dxb_ali' limit 1")[0]?.number as string;
    expect((await call(aliToken, "job_status", { number: own })).out).toMatchObject({ number: own });
    const other = rows("select number from app__jobs where technician_user_id = 'u_dxb_bilal' limit 1")[0]?.number as string;
    const refused = await call(aliToken, "job_status", { number: other });
    expect(refused.status).toBe(200);
    expect(refused.out).toMatchObject({ error: "forbidden" });
    expect((await call(dinaToken, "job_status", {})).status).toBe(400);
    // A user who registered and never verified their email: the cell refuses the token's user before the tool runs.
    expect((await call(strangerToken, "job_status", { number: "J-000013" })).status).toBe(403);
  });
});

describe("next_free_slot", () => {
  const day = monday(4);

  test("normal case: three slots inside the hours, each with its technician", async () => {
    const r = await call(dinaToken, "next_free_slot", { service: "AC-SERVICE", from: day });
    expect(r.status).toBe(200);
    const slots = r.out.slots as { slot: string; technician: string; technician_id: string; day: string; start: string; end: string }[];
    expect(slots).toHaveLength(3);
    for (const s of slots) {
      const hour = Number(s.start.slice(11, 13));
      expect(hour).toBeGreaterThanOrEqual(8);
      expect(Number(s.end.slice(11, 13)) * 60 + Number(s.end.slice(14, 16))).toBeLessThanOrEqual(18 * 60);
      expect(["Ali Hassan", "Bilal Raza"]).toContain(s.technician);
      expect(s.slot).toMatch(/^u_dxb_(ali|bilal)@\d{13}$/u);
    }
    expect(r.out).toMatchObject({ branch: "dubai", service: "AC-SERVICE" });
  });

  test("the slots are the page's slot picker's for the same day", async () => {
    // A new Dubai job for the AC service: its page offers the free starts of every technician on `?day=`.
    const made = await dina.action("/jobs/new", "create", { site_id: "st_dxb_01a", service: String(rows("select id from app__services where code = 'AC-SERVICE'")[0]?.id), priority: "normal", description: "Picker comparison" });
    expect(made.status).toBe(303);
    const page = await dina.page(`${made.headers.get("location")}?day=${day}`);
    expect(page.status).toBe(200);
    const offered = [...page.html.matchAll(/value="(u_[a-z_]+@\d{13})"/gu)].map((m) => m[1] as string);
    expect(offered.length).toBeGreaterThanOrEqual(3);
    const r = await call(dinaToken, "next_free_slot", { service: "AC-SERVICE", from: day });
    expect((r.out.slots as { slot: string }[]).map((s) => s.slot)).toEqual(offered.slice(0, 3));
  });

  test("error case: an unknown service and a branch the user is not in are not_found objects; a bad day is a 400", async () => {
    expect((await call(dinaToken, "next_free_slot", { service: "TELEPORT" })).out).toMatchObject({ error: "not_found" });
    expect((await call(dinaToken, "next_free_slot", { service: "AC-SERVICE", branch: "sharjah" })).out).toMatchObject({ error: "not_found" });
    expect((await call(dinaToken, "next_free_slot", { service: "AC-SERVICE", from: "tomorrow" })).status).toBe(400);
    expect((await call(strangerToken, "next_free_slot", { service: "AC-SERVICE" })).status).toBe(403);
  });
});

describe("create_job", () => {
  const day = monday(5);
  const args = (slot: string, extra: Record<string, unknown> = {}) => ({ customer_phone: "+971 50 111 0001", service: "AC-SERVICE", slot, ...extra });
  let slot = "";
  let number = "";

  test("without the confirmation: the plan and a confirmation request, nothing written", async () => {
    slot = ((await call(dinaToken, "next_free_slot", { service: "AC-SERVICE", from: day })).out.slots as { slot: string }[])[0]?.slot as string;
    const jobs = rows("select count(*) as n from app__jobs")[0]?.n;
    const r = await call(dinaToken, "create_job", args(slot));
    expect(r.status).toBe(200);
    expect(r.out.preview).toMatchObject({ would_create: { customer: "Layla Haddad", site: "Apartment", service: "AC-SERVICE", branch: "dubai" } });
    expect(typeof r.out.confirmation?.token).toBe("string");
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(jobs);
    // A confirmation for other arguments does not work.
    const other = await call(dinaToken, "create_job", args(slot, { service: "AC-REPAIR" }), r.out.confirmation?.token);
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(jobs);
  });

  test("with the confirmation: a scheduled job, booked with the technician, the customer told", async () => {
    const first = await call(dinaToken, "create_job", args(slot));
    const confirmed = await call(dinaToken, "create_job", args(slot), first.out.confirmation?.token);
    expect(confirmed.status, confirmed.text).toBe(200);
    expect(confirmed.out, confirmed.text).toMatchObject({ created: true, status: "scheduled", customer: "Layla Haddad", service: "AC-SERVICE" });
    number = String(confirmed.out.number);
    const job = rows("select status, technician_user_id, booking_id, scheduled_start, branch_id, created_by from app__jobs where number = ?", [number])[0] as Record<string, unknown>;
    expect(job).toMatchObject({ status: "scheduled", technician_user_id: slot.split("@")[0], branch_id: "br_dubai", created_by: "u_dxb_dispatcher" });
    expect(job.booking_id).not.toBeNull();
    expect(Number(job.scheduled_start) * 1000).toBe(Number(slot.split("@")[1]));
    expect(rows("select count(*) as n from app__outbox_preview where customer_id = 'cu_dxb_01' and template = 'visit_scheduled'")[0]?.n).toBe(1);
    expect(rows("select count(*) as n from app__job_events where job_id = (select id from app__jobs where number = ?) and to_status = 'scheduled'", [number])[0]?.n).toBe(1);
    // The confirmation is single use.
    expect((await call(dinaToken, "create_job", args(slot), first.out.confirmation?.token)).status).toBe(409);
    // job_status sees it.
    expect((await call(dinaToken, "job_status", { number })).out).toMatchObject({ number, status: "scheduled" });
  });

  test("edge case: the slot is taken now, an unknown phone, a customer with two sites, a malformed slot: objects, nothing written", async () => {
    const jobs = rows("select count(*) as n from app__jobs")[0]?.n;
    const taken = await call(dinaToken, "create_job", args(slot));
    expect(taken.isError).toBe(true);
    expect(taken.out.preview).toMatchObject({ error: "slot_unavailable" });
    expect(taken.out.confirmation).toBeUndefined();
    expect((await call(dinaToken, "create_job", args(slot, { customer_phone: "+971 50 999 9999" }))).out.preview).toMatchObject({ error: "not_found" });
    const two = await call(dinaToken, "create_job", args(slot, { customer_phone: "+971 52 111 0002" }));
    expect(two.out.preview).toMatchObject({ error: "bad_input" });
    expect(String((two.out.preview as { message: string }).message)).toContain("Villa");
    expect((await call(dinaToken, "create_job", args("nonsense"))).out.preview).toMatchObject({ error: "bad_input" });
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(jobs);
  });

  test("error case: a technician's and an accountant's token are refused (forbidden, nothing written); an unverified user's is a 403", async () => {
    const free = ((await call(dinaToken, "next_free_slot", { service: "AC-SERVICE", from: day })).out.slots as { slot: string }[])[0]?.slot as string;
    const jobs = rows("select count(*) as n from app__jobs")[0]?.n;
    for (const token of [aliToken, accountantToken]) {
      // The cell lets the token through (it names no roles); the tool asks the policies with the user's roles and answers forbidden
      // on the preview. A preview that returns an error is a tool error with no confirmation (#609), so no token can confirm it.
      const preview = await call(token, "create_job", args(free));
      expect(preview.status, preview.text).toBe(200);
      expect(preview.isError).toBe(true);
      expect(preview.out.preview).toMatchObject({ error: "forbidden" });
      expect(preview.out.confirmation).toBeUndefined();
      const confirmed = await call(token, "create_job", args(free), "any-token");
      expect(confirmed.status).toBe(409);
      expect(confirmed.text).toContain("RENOX_TOOL_CONFIRM");
    }
    const unverified = await call(strangerToken, "create_job", args(free));
    expect(unverified.status).toBe(403);
    expect(unverified.text).toContain("RENOX_FORBIDDEN");
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(jobs);
  });
});
