// The App MCP tools (F7-129): `next_free_slot`, `job_status` and `create_job`
// through the app's `/mcp`, as the agent of a signed-in user (`t.tool`: an OAuth
// token of the auth module). Under the same policies as the pages: a dispatcher's
// token books a visit after the confirmation, a technician's token cannot, and
// the slots are the ones the job page's slot picker offers. The raw `t.request`
// stays for what `t.tool` does not express: `tools/list`, the HTTP status of a
// narrowed token, and a confirmation token of someone else's arguments.
// Runs on the local worker with the seed's users (password below).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { agentToken, app, type ToolReply } from "@renoxium/sdk/test";

import { outboxOf } from "./outbox";

setDefaultTimeout(60_000);
const t = await app();
const PASSWORD = "correct horse battery";

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);

async function signIn(jar: string, email: string) {
  const u = t.as(jar);
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD })).status).toBe(303);
  return u;
}

/** The structured content of a tool's answer (the final result of a confirmed call). */
const outOf = (r: ToolReply) => (r.result ?? {}) as Record<string, unknown>;
/** A refusal of `create_job` inside its preview (`isError`): `t.tool` reports it as `RENOX_TOOL_ERROR` with the structured content as the message. */
const refusal = (r: ToolReply) => {
  expect(r.ok).toBe(false);
  expect(r.error?.code).toBe("RENOX_TOOL_ERROR");
  return (JSON.parse(r.error?.message ?? "{}") as { preview: { error: string; message: string } }).preview;
};

/** `tools/list` and a raw `tools/call`: JSON-RPC over `t.request` with an agent token. */
let seq = 0;
const rpc = (token: string, method: string, params: unknown) => t.request("POST", "/mcp", { headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: "2.0", id: ++seq, method, params } });

/** A Monday at least `after` days ahead (Dubai), as `YYYY-MM-DD`. */
function monday(after: number): string {
  const d = new Date(Date.now() + 4 * 3_600_000 + after * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const dina = await signIn("dina", "dispatcher.dubai@fixit.example");
const ali = await signIn("ali", "ali.dubai@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");
// A user with no role and no branch: registers, signs in, connects an agent.
const stranger = t.as("stranger");
expect((await stranger.action("/auth/register", "default", { email: "stranger@example.com", password: PASSWORD, display_name: "Sam Stranger" })).status).toBe(200);
expect((await stranger.action("/auth/login", "default", { email: "stranger@example.com", password: PASSWORD })).status).toBe(303);

describe("the listing", () => {
  test("a dispatcher's agent sees the three tools, create_job as the destructive one", async () => {
    const list = await rpc(await agentToken(t, dina), "tools/list", {});
    expect(list.status).toBe(200);
    const tools = list.json<{ result: { tools: { name: string; annotations: Record<string, boolean>; inputSchema: { required: string[] } }[] } }>().result.tools;
    expect(tools.map((x) => x.name)).toEqual(expect.arrayContaining(["create_job", "job_status", "next_free_slot"]));
    expect(tools.find((x) => x.name === "create_job")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((x) => x.name === "job_status")?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find((x) => x.name === "create_job")?.inputSchema.required).toEqual(["customer_phone", "service", "slot"]);
  });

  test("a token narrowed to one tool lists and calls only that one", async () => {
    const narrow = await agentToken(t, dina, "tools:job_status");
    const list = await rpc(narrow, "tools/list", {});
    expect(list.json<{ result: { tools: { name: string }[] } }>().result.tools.map((x) => x.name)).toEqual(["job_status"]);
    const refused = await rpc(narrow, "tools/call", { name: "create_job", arguments: { customer_phone: "+971501110001", service: "AC-SERVICE", slot: "x@1234567890" } });
    expect(refused.status).toBe(403);
    expect((await t.tool("create_job", { customer_phone: "+971501110001", service: "AC-SERVICE", slot: "x@1234567890" }, { as: dina, scope: "tools:job_status" })).error?.code).toBe("RENOX_TOOL_SCOPE");
  });
});

describe("job_status", () => {
  test("normal case: a seeded job's state, technician, time and invoice", async () => {
    const r = await t.tool("job_status", { number: "J-000013" }, { as: dina });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toMatchObject({ number: "J-000013", branch: "dubai", status: "invoiced", invoice: { number: "INV-000001", status: "part-paid" } });
    expect(typeof outOf(r).technician).toBe("string");
    expect(outOf(r).scheduled).toMatchObject({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) });
    // The number is not case sensitive.
    expect(outOf(await t.tool("job_status", { number: "j-000013" }, { as: dina })).status).toBe("invoiced");
    const unscheduled = await t.tool("job_status", { number: "J-000002" }, { as: dina });
    expect(unscheduled.result).toMatchObject({ number: "J-000002", invoice: null });
  });

  test("edge case: an unknown number, and a job of another branch, are a not_found object, not an exception", async () => {
    for (const number of ["J-999999", "J-000017"]) {
      const r = await t.tool("job_status", { number }, { as: dina });
      expect(r.ok).toBe(true);
      expect(r.result).toMatchObject({ error: "not_found" });
    }
  });

  test("error case: a technician reads their own job and gets forbidden for another's; an invalid input is a 400; an unverified user is a 403", async () => {
    const own = rows("select number from app__jobs where technician_user_id = 'u_dxb_ali' limit 1")[0]?.number as string;
    expect((await t.tool("job_status", { number: own }, { as: ali })).result).toMatchObject({ number: own });
    const other = rows("select number from app__jobs where technician_user_id = 'u_dxb_bilal' limit 1")[0]?.number as string;
    const refused = await t.tool("job_status", { number: other }, { as: ali });
    expect(refused.ok).toBe(true);
    expect(refused.result).toMatchObject({ error: "forbidden" });
    const invalid = await t.tool("job_status", {}, { as: dina });
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("RENOX_TOOL_INPUT");
    // A user who registered and never verified their email: the cell refuses the token's user before the tool runs.
    const unverified = await t.tool("job_status", { number: "J-000013" }, { as: stranger });
    expect(unverified.ok).toBe(false);
    expect(unverified.error?.code).toBe("RENOX_FORBIDDEN");
  });
});

describe("next_free_slot", () => {
  const day = monday(4);

  test("normal case: three slots inside the hours, each with its technician", async () => {
    const r = await t.tool("next_free_slot", { service: "AC-SERVICE", from: day }, { as: dina });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const slots = outOf(r).slots as { slot: string; technician: string; technician_id: string; day: string; start: string; end: string }[];
    expect(slots).toHaveLength(3);
    for (const s of slots) {
      const hour = Number(s.start.slice(11, 13));
      expect(hour).toBeGreaterThanOrEqual(8);
      expect(Number(s.end.slice(11, 13)) * 60 + Number(s.end.slice(14, 16))).toBeLessThanOrEqual(18 * 60);
      expect(["Ali Hassan", "Bilal Raza"]).toContain(s.technician);
      expect(s.slot).toMatch(/^u_dxb_(ali|bilal)@\d{13}$/u);
    }
    expect(r.result).toMatchObject({ branch: "dubai", service: "AC-SERVICE" });
  });

  test("the slots are the page's slot picker's for the same day", async () => {
    // A new Dubai job for the AC service: its page offers the free starts of every technician on `?day=`.
    const made = await dina.action("/jobs/new", "create", { site_id: "st_dxb_01a", service: String(rows("select id from app__services where code = 'AC-SERVICE'")[0]?.id), priority: "normal", description: "Picker comparison" });
    expect(made.status).toBe(303);
    const page = await dina.page(`${made.headers.get("location")}?day=${day}`);
    expect(page.status).toBe(200);
    const offered = [...page.html.matchAll(/value="(u_[a-z_]+@\d{13})"/gu)].map((m) => m[1] as string);
    expect(offered.length).toBeGreaterThanOrEqual(3);
    const r = await t.tool("next_free_slot", { service: "AC-SERVICE", from: day }, { as: dina });
    expect((outOf(r).slots as { slot: string }[]).map((s) => s.slot)).toEqual(offered.slice(0, 3));
  });

  test("error case: an unknown service and a branch the user is not in are not_found objects; a bad day is a 400", async () => {
    expect((await t.tool("next_free_slot", { service: "TELEPORT" }, { as: dina })).result).toMatchObject({ error: "not_found" });
    expect((await t.tool("next_free_slot", { service: "AC-SERVICE", branch: "sharjah" }, { as: dina })).result).toMatchObject({ error: "not_found" });
    const bad = await t.tool("next_free_slot", { service: "AC-SERVICE", from: "tomorrow" }, { as: dina });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("RENOX_TOOL_INPUT");
    const unverified = await t.tool("next_free_slot", { service: "AC-SERVICE" }, { as: stranger });
    expect(unverified.ok).toBe(false);
    expect(unverified.error?.code).toBe("RENOX_FORBIDDEN");
  });
});

describe("a user of two branches", () => {
  /** An agent token whose consent picked `orgId` (the consent page asks a user of several organisations, #590). */
  async function tokenFor(u: Awaited<ReturnType<typeof signIn>>, orgId: string): Promise<string> {
    const redirect = "https://agent.example/callback";
    const verifier = "agent-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
    const reg = await t.request("POST", "/auth/oauth/register", { body: { client_name: "Booking Agent", redirect_uris: [redirect] } });
    const clientId = reg.json<{ client_id: string }>().client_id;
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...d)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    const allow = await u.action("/auth/oauth/consent", "allow", { response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", org_id: orgId });
    expect(allow.status, allow.html).toBe(303);
    const code = new URL(allow.headers.get("location") as string).searchParams.get("code") as string;
    const tok = await t.request("POST", "/auth/oauth/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier }).toString(),
    });
    expect(tok.status).toBe(200);
    return tok.json<{ access_token: string }>().access_token;
  }
  const tool = async (token: string, name: string, args: Record<string, unknown>) =>
    ((await rpc(token, "tools/call", { name, arguments: args })).json<{ result?: { structuredContent?: Record<string, unknown> } }>().result?.structuredContent ?? {}) as Record<string, unknown>;

  test("a token acts in the branch picked at consent only: the other branch is unknown to it", async () => {
    // The owner belongs to Dubai and Sharjah (seed); the consent picked Dubai.
    const owner = await signIn("owner-agent", "owner@fixit.example");
    const token = await tokenFor(owner, "org_dubai");
    expect(await tool(token, "next_free_slot", { service: "AC-SERVICE" })).toMatchObject({ branch: "dubai" });
    expect(await tool(token, "next_free_slot", { service: "AC-SERVICE", branch: "dubai" })).toMatchObject({ branch: "dubai" });
    expect(await tool(token, "next_free_slot", { service: "AC-SERVICE", branch: "sharjah" })).toMatchObject({ error: "not_found", branches: ["dubai"] });
    // A Sharjah job is out of reach too.
    expect(await tool(token, "job_status", { number: "J-000017" })).toMatchObject({ error: "not_found" });
  });
});

describe("create_job", () => {
  const day = monday(5);
  const args = (slot: string, extra: Record<string, unknown> = {}) => ({ customer_phone: "+971 50 111 0001", service: "AC-SERVICE", slot, ...extra });
  const freeSlot = async () => (outOf(await t.tool("next_free_slot", { service: "AC-SERVICE", from: day }, { as: dina })).slots as { slot: string }[])[0]?.slot as string;
  let slot = "";
  let number = "";

  test("without the confirmation: the plan and a confirmation request, nothing written", async () => {
    slot = await freeSlot();
    const jobs = rows("select count(*) as n from app__jobs")[0]?.n;
    const r = await t.tool("create_job", args(slot), { as: dina });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.preview).toMatchObject({ would_create: { customer: "Layla Haddad", site: "Apartment", service: "AC-SERVICE", branch: "dubai" } });
    expect(typeof r.confirmation?.token).toBe("string");
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(jobs);
    // A confirmation for other arguments does not work (raw: `t.tool` only sends the confirmation of the same call).
    const other = await rpc(await agentToken(t, dina), "tools/call", { name: "create_job", arguments: args(slot, { service: "AC-REPAIR" }), _meta: { "renox/confirmation": r.confirmation?.token } });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(jobs);
  });

  test("with the confirmation: a scheduled job, booked with the technician, the customer told", async () => {
    const confirmed = await t.tool("create_job", args(slot), { as: dina, confirm: true });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    expect(confirmed.result, JSON.stringify(confirmed)).toMatchObject({ created: true, status: "scheduled", customer: "Layla Haddad", service: "AC-SERVICE" });
    number = String(outOf(confirmed).number);
    const job = rows("select status, technician_user_id, booking_id, scheduled_start, branch_id, created_by from app__jobs where number = ?", [number])[0] as Record<string, unknown>;
    expect(job).toMatchObject({ status: "scheduled", technician_user_id: slot.split("@")[0], branch_id: "br_dubai", created_by: "u_dxb_dispatcher" });
    expect(job.booking_id).not.toBeNull();
    expect(Number(job.scheduled_start) * 1000).toBe(Number(slot.split("@")[1]));
    expect(outboxOf(rows, "+971501110001").filter((m) => m.template === "visit_scheduled")).toHaveLength(1);
    expect(rows("select count(*) as n from app__job_events where job_id = (select id from app__jobs where number = ?) and to_status = 'scheduled'", [number])[0]?.n).toBe(1);
    // job_status sees it.
    expect((await t.tool("job_status", { number }, { as: dina })).result).toMatchObject({ number, status: "scheduled" });
  });

  test("the confirmation is single use", async () => {
    // Raw: `t.tool` confirms with a token of its own and does not hand it back, so the replay needs the token in hand.
    const next = await freeSlot();
    const token = await agentToken(t, dina);
    const call = (confirmation?: string) => rpc(token, "tools/call", { name: "create_job", arguments: args(next), ...(confirmation === undefined ? {} : { _meta: { "renox/confirmation": confirmation } }) });
    const first = (await call()).json<{ result: { structuredContent: { confirmation: { token: string } } } }>().result.structuredContent.confirmation.token;
    expect((await call(first)).status).toBe(200);
    expect((await call(first)).status).toBe(409);
  });

  test("edge case: the slot is taken now, an unknown phone, a customer with two sites, a malformed slot: objects, nothing written", async () => {
    const jobs = rows("select count(*) as n from app__jobs")[0]?.n;
    const taken = await t.tool("create_job", args(slot), { as: dina });
    expect(refusal(taken)).toMatchObject({ error: "slot_unavailable" });
    expect(taken.confirmation).toBeUndefined();
    expect(refusal(await t.tool("create_job", args(slot, { customer_phone: "+971 50 999 9999" }), { as: dina }))).toMatchObject({ error: "not_found" });
    const two = refusal(await t.tool("create_job", args(slot, { customer_phone: "+971 52 111 0002" }), { as: dina }));
    expect(two).toMatchObject({ error: "bad_input" });
    expect(two.message).toContain("Villa");
    expect(refusal(await t.tool("create_job", args("nonsense"), { as: dina }))).toMatchObject({ error: "bad_input" });
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(jobs);
  });

  test("error case: a technician's and an accountant's token are refused by the cell (403, nothing written); an unverified user's is a 403", async () => {
    const free = await freeSlot();
    const jobs = rows("select count(*) as n from app__jobs")[0]?.n;
    for (const user of [ali, accountant]) {
      // The token's principal carries the user's roles and branch (#590), so the cell's check of the tool's action
      // (job.write: the dispatcher's, the branch manager's and the owner's) refuses a technician's and an accountant's
      // token before the tool runs: a 403, no preview and no confirmation token.
      const preview = await t.tool("create_job", args(free), { as: user });
      expect(preview.ok, JSON.stringify(preview)).toBe(false);
      expect(preview.error?.code).toBe("RENOX_FORBIDDEN");
      expect(preview.preview).toBeUndefined();
      expect(preview.confirmation).toBeUndefined();
      // A made-up confirmation is refused as such (409) before the action is checked (raw: `t.tool` sends only real confirmations).
      const confirmed = await rpc(await agentToken(t, user), "tools/call", { name: "create_job", arguments: args(free), _meta: { "renox/confirmation": "any-token" } });
      expect(confirmed.status, confirmed.html).toBe(409);
      expect(confirmed.html).toContain("RENOX_TOOL_CONFIRM");
    }
    const unverified = await t.tool("create_job", args(free), { as: stranger });
    expect(unverified.ok).toBe(false);
    expect(unverified.error?.code).toBe("RENOX_FORBIDDEN");
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(jobs);
  });
});
