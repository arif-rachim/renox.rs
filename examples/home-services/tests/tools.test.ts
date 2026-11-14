// The App MCP tools (F7-129): `next_free_slot`, `job_status` and `create_job`
// through the app's `/mcp`, as the agent of a signed-in user (`t.tool`: an OAuth
// token of the auth module). Under the same policies as the pages: a dispatcher's
// token books a visit after the confirmation, a technician's token cannot, and
// the slots are the ones the job page's slot picker offers. `t.tools` lists the
// tools, and `t.tool(..., { confirmation })` sends a made-up, replayed or
// other-argument confirmation as given. The raw `t.request` stays for the agent
// of a user of two branches, whose consent picks the organisation.
// Runs on the local worker with the seed's users (password below).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { app, type ToolReply } from "@renoxium/sdk/test";

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

/** A raw JSON-RPC call over `t.request` with an agent token (the two-branch agent below). */
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
    const list = await t.tools({ as: dina });
    expect(list.status).toBe(200);
    const tools = list.tools;
    expect(tools.map((x) => x.name)).toEqual(expect.arrayContaining(["create_job", "job_status", "next_free_slot"]));
    expect(tools.find((x) => x.name === "create_job")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((x) => x.name === "job_status")?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find((x) => x.name === "create_job")?.inputSchema.required).toEqual(["customer_phone", "service", "slot"]);
  });

  test("a token narrowed to one tool lists and calls only that one", async () => {
    const list = await t.tools({ as: dina, scope: "tools:job_status" });
    expect(list.tools.map((x) => x.name)).toEqual(["job_status"]);
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
    // A confirmation for other arguments does not work. On the same agent token (t.tool keeps one per user): the cell
    // seals the confirmation over the tool, the arguments and the token, so the replay must change only the arguments.
    const other = await t.tool("create_job", args(slot, { service: "AC-REPAIR" }), { as: dina, confirmation: r.confirmation?.token });
    expect(other.ok).toBe(false);
    expect(other.error?.code).toBe("RENOX_TOOL_CONFIRM");
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
    const next = await freeSlot();
    const first = (await t.tool("create_job", args(next), { as: dina })).confirmation?.token;
    expect(typeof first).toBe("string");
    const used = await t.tool("create_job", args(next), { as: dina, confirmation: first });
    expect(used.ok, JSON.stringify(used)).toBe(true);
    const replay = await t.tool("create_job", args(next), { as: dina, confirmation: first });
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe("RENOX_TOOL_CONFIRM");
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
      // A made-up confirmation is refused as such (409) before the action is checked.
      const confirmed = await t.tool("create_job", args(free), { as: user, confirmation: "any-token" });
      expect(confirmed.ok).toBe(false);
      expect(confirmed.error?.code, JSON.stringify(confirmed)).toBe("RENOX_TOOL_CONFIRM");
    }
    const unverified = await t.tool("create_job", args(free), { as: stranger });
    expect(unverified.ok).toBe(false);
    expect(unverified.error?.code).toBe("RENOX_FORBIDDEN");
    expect(rows("select count(*) as n from app__jobs")[0]?.n).toBe(jobs);
  });
});

// #683 (#658): the cell emits `mcp.tool_called` after every App MCP tools/call
// and the `audit` module stores it as an `agent` row with the client's name.
// Worker 0.7.0 was tagged before #658 merged, so it emits nothing: the
// assertion runs on a worker newer than 0.7.0 and is skipped, with the reason
// printed, on 0.7.0 and older. A worker built from main still reports 0.7.0
// until the next worker release, so it is skipped there too.
const WORKER_WITH_TOOL_AUDIT = [0, 7, 1];
function workerVersion(): number[] | null {
  const path = process.env.RENOX_WORKER_PATH;
  if (!path) return null;
  const out = Bun.spawnSync([path, "--version"]).stdout.toString();
  const m = /(\d+)\.(\d+)\.(\d+)/u.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const atLeast = (v: number[], min: number[]) => v[0]! !== min[0]! ? v[0]! > min[0]! : v[1]! !== min[1]! ? v[1]! > min[1]! : v[2]! >= min[2]!;
const worker = workerVersion();
const toolAudit = worker !== null && atLeast(worker, WORKER_WITH_TOOL_AUDIT);
if (!toolAudit) console.log(`skip: the audit page assertion for an agent's create_job (#683) needs a renox-worker >= ${WORKER_WITH_TOOL_AUDIT.join(".")} (mcp.tool_called, #658); this worker is ${worker?.join(".") ?? "unknown"}`);

describe("the audit trail of an agent's tool call (#683)", () => {
  test.skipIf(!toolAudit)("an agent's create_job is on the audit page, as actor kind agent with the client's name", async () => {
    // dina's agent created a job above (create_job, confirmed). The audit module's row:
    const row = rows("select actor_kind, actor_id, client, resource_id, result from audit__events where action = 'mcp.tool_called' and resource_id = 'create_job' and actor_id = 'u_dxb_dispatcher' and result = 'ok' order by rowid desc limit 1")[0];
    expect(row).toEqual({ actor_kind: "agent", actor_id: "u_dxb_dispatcher", client: "renox test agent", resource_id: "create_job", result: "ok" });
    // And the `admin` module's audit page (the owner holds admin.access and audit.read) lists it.
    const owner = await signIn("owner-audit", "owner@fixit.example");
    const page = await owner.page("/admin/audit?action=mcp.tool_called");
    expect(page.status).toBe(200);
    // The module's page (admin 1.0.1, #709) shows the action, the actor id with its kind and client, and the
    // resource as type:id or the id alone.
    const line = page.html.split("<tr").find((tr) => tr.includes(">mcp.tool_called<") && tr.includes("u_dxb_dispatcher") && /:create_job<|>create_job</u.test(tr));
    expect(line, page.html).toBeDefined();
    expect(line).toContain(">u_dxb_dispatcher agent (renox test agent)<");
  });
});

// #699 (#686): the settings, branches, services and people tools the owner connector calls
// (docs/20-ai-agents-mcp.md section 1b): the owner's agent runs them, a technician's is refused by the cell
// (403, no preview) wherever the admin page is forbidden. The mutating ones are `confirm` tools: the first call
// writes nothing. The owner's token holds no second factor (an agent token never does), which is why the tools'
// actions are `settings.update`, `branch.write` and `service.write` and not the pages' sensitive `settings.write`.
// The owner belongs to two branches, so the consent must name one (t.tool cannot): this agent acts in Dubai.
import { Database } from "bun:sqlite";
import { agentToken, callTool, listTools } from "@renoxium/sdk/test";

const ownerJar = await signIn("owner-tools", "owner@fixit.example");
/** The owner's agent token: the cell allows 60 calls a minute per token, so a new one is minted well before that. */
let ownerToken = "";
let ownerCalls = 0;
async function ownerAgentToken(calls: number): Promise<string> {
  if (ownerToken === "" || ownerCalls + calls > 40) {
    ownerToken = await agentToken(t, { request: (m, p, i) => ownerJar.request(m, p, i), action: (p, n, f) => ownerJar.action(p, n, { ...f, org_id: "org_dubai" }) });
    ownerCalls = 0;
  }
  ownerCalls += calls;
  return ownerToken;
}
/** A call as the owner's agent: a `confirm` tool answers its preview, or with `confirm` the real result. */
const own = async (name: string, args: Record<string, unknown>, confirm = false) => callTool(t, await ownerAgentToken(confirm ? 2 : 1), name, args, confirm);

const OWNER_TOOLS = ["get_settings", "update_settings", "upload_logo", "list_branches", "add_branch", "update_branch", "list_services", "add_service", "update_service", "list_people"];

/** An invalid input: the cell's schema check answers a 400, or the tool's own check refuses inside its preview; no confirmation exists either way. */
function expectInvalid(r: ToolReply, label: string): void {
  expect(r.ok, label).toBe(false);
  expect(r.confirmation, label).toBeUndefined();
  expect(r.preview, label).toBeUndefined();
  if (r.error?.code === "RENOX_TOOL_ERROR") expect(refusal(r), label).toMatchObject({ error: "bad_input" });
  else expect(r.error?.code, label).toBe("RENOX_TOOL_INPUT");
}

const png = (size: number): Uint8Array => {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

describe("the owner connector's tools: listing and policies", () => {
  test("the owner's agent sees all ten; the mutating ones are the destructive kind, the readers read only", async () => {
    const list = await listTools(t, await ownerAgentToken(1));
    const names = list.tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(OWNER_TOOLS));
    for (const name of ["update_settings", "upload_logo", "add_branch", "update_branch", "add_service", "update_service"]) expect(list.tools.find((x) => x.name === name)?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    for (const name of ["get_settings", "list_branches", "list_services", "list_people"]) expect(list.tools.find((x) => x.name === name)?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(list.tools.find((x) => x.name === "upload_logo")?.inputSchema.required).toEqual(["image", "content_type"]);
  });

  test("a technician is forbidden every one of them (403, no preview, no confirmation)", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["get_settings", {}],
      ["update_settings", { settings: { brand_name: "Nope" } }],
      ["upload_logo", { image: b64(png(64)), content_type: "image/png" }],
      ["list_branches", {}],
      ["add_branch", { branch: { name: "Nope", emirate: "dubai" } }],
      ["update_branch", { id: "br_dubai", branch: { name: "Nope" } }],
      ["list_services", {}],
      ["add_service", { service: { name: "Nope", price_aed: 1 } }],
      ["update_service", { id: 1, service: { active: false } }],
      ["list_people", {}],
    ];
    for (const [name, args] of calls) {
      const r = await t.tool(name, args, { as: ali });
      expect(r.ok, name).toBe(false);
      expect(r.error?.code, name).toBe("RENOX_FORBIDDEN");
      expect(r.preview, name).toBeUndefined();
      expect(r.confirmation, name).toBeUndefined();
    }
    expect(rows("select count(*) as n from app__settings where key = 'brand_name' and value = 'Nope'")[0]?.n).toBe(0);
  });

  test("a dispatcher reads the catalogue (as /services lets her) but changes and reads nothing else of these", async () => {
    expect((await t.tool("list_services", {}, { as: dina })).ok).toBe(true);
    for (const [name, args] of [["add_service", { service: { name: "Nope", price_aed: 1 } }], ["update_branch", { id: "br_dubai", branch: { name: "Nope" } }], ["update_settings", { settings: { brand_name: "Nope" } }], ["list_people", {}]] as [string, Record<string, unknown>][]) {
      const r = await t.tool(name, args, { as: dina });
      expect(r.error?.code, name).toBe("RENOX_FORBIDDEN");
    }
  });
});

describe("get_settings and update_settings", () => {
  test("get_settings: the branding of the seed, a logo flag, and no secret", async () => {
    const r = await own("get_settings", {});
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toMatchObject({ brand_name: expect.any(String), brand_color: expect.stringMatching(/^#[0-9a-fA-F]{6}$/u), accounts_email: "accounts@fixit.example", footers: { invoice: "", quote: "", job_card: "" }, logo: false, logo_url: null });
    expect(JSON.stringify(r.result)).not.toMatch(/setup_hash|SETUP_KEY|setup_pending|token|secret/iu);
    expectInvalid(await own("get_settings", { extra: 1 }), "an unknown property");
  });

  test("update_settings: the first call names each change and writes nothing; the confirmed one writes, audits and answers the settings", async () => {
    const before = rows("select value from app__settings where key = 'brand_color'")[0]?.value as string;
    const args = { settings: { brand_color: "#E40000", sender_name: "FixIt Care", footers: { invoice: "Pay within 30 days", quote: "Valid for 30 days" } } };
    const preview = await own("update_settings", args);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.preview).toMatchObject({ would_change: expect.arrayContaining([{ key: "brand_color", from: before, to: "#E40000" }, { key: "footer_invoice", from: "", to: "Pay within 30 days" }]) });
    expect(rows("select value from app__settings where key = 'brand_color'")[0]?.value).toBe(before);
    const done = await own("update_settings", args, true);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(done.result).toMatchObject({ brand_color: "#E40000", sender_name: "FixIt Care", footers: { invoice: "Pay within 30 days", quote: "Valid for 30 days", job_card: "" } });
    expect(rows("select value from app__settings where key = 'brand_color'")[0]?.value).toBe("#E40000");
    expect((await own("get_settings", {})).result).toMatchObject({ brand_color: "#E40000", footers: { invoice: "Pay within 30 days" } });
    // The audit row names the keys, never the values.
    const audit = rows("select details from audit__events where action = 'settings.update' order by rowid desc limit 1")[0]?.details as string;
    expect(audit).toContain("brand_color");
    expect(audit).not.toContain("Pay within");
    // A footer is cleared with an empty string.
    expect((await own("update_settings", { settings: { footers: { invoice: "" } } }, true)).result).toMatchObject({ footers: { invoice: "", quote: "Valid for 30 days" } });
  });

  test("update_settings: invalid input is a 400 and writes nothing; the limits themselves are accepted", async () => {
    const colour = rows("select value from app__settings where key = 'brand_color'")[0]?.value;
    const bad: Record<string, unknown>[] = [
      {},
      { settings: {} },
      { settings: { brand_color: "red" } },
      { settings: { brand_color: "#E40" } },
      { settings: { brand_name: "" } },
      { settings: { brand_name: "x".repeat(81) } },
      { settings: { accounts_email: "not an email" } },
      { settings: { sender_name: "a<b" } },
      { settings: { footers: {} } },
      { settings: { footers: { invoice: "x".repeat(501) } } },
      { settings: { footers: { receipt: "x" } } },
      { settings: { brand_name_ar: "x" } },
      { settings: { brand_name: "ok" }, extra: true },
    ];
    for (const args of bad) {
      expectInvalid(await own("update_settings", args), JSON.stringify(args));
    }
    expect(rows("select value from app__settings where key = 'brand_color'")[0]?.value).toBe(colour);
    expect((await own("update_settings", { settings: { brand_name: "x".repeat(80), footers: { job_card: "y".repeat(500) } } }, true)).ok).toBe(true);
  });
});

describe("upload_logo", () => {
  test("a PNG: the first call stores nothing, the confirmed one stores it public and sets the logo", async () => {
    const args = { image: b64(png(2048)), content_type: "image/png" };
    const files = rows("select count(*) as n from renox__files where key like 'app/brand/%'")[0]?.n;
    const preview = await own("upload_logo", args);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.preview).toEqual({ would_replace: { content_type: "image/png", bytes: 2048 } });
    expect(rows("select count(*) as n from renox__files where key like 'app/brand/%'")[0]?.n).toBe(files);
    const done = await own("upload_logo", args, true);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    const key = rows("select value from app__settings where key = 'brand_logo_key'")[0]?.value as string;
    expect(key).toMatch(/^app\/brand\/logo-[a-z0-9]+\.png$/u);
    expect(done.result).toEqual({ logo_url: `/_img/${key}?w=400` });
    expect(rows("select public, content_type from renox__files where key = ?", [key])[0]).toMatchObject({ public: 1, content_type: "image/png" });
    expect((await own("get_settings", {})).result).toMatchObject({ logo: true, logo_url: `/_img/${key}?w=400` });
  });

  test("a replaced logo is deleted: the previous file goes", async () => {
    const old = rows("select value from app__settings where key = 'brand_logo_key'")[0]?.value as string;
    const jpeg = new Uint8Array(1024);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    const done = await own("upload_logo", { image: b64(jpeg), content_type: "image/jpeg" }, true);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    const key = rows("select value from app__settings where key = 'brand_logo_key'")[0]?.value as string;
    expect(key).toMatch(/\.jpg$/u);
    expect(rows("select count(*) as n from renox__files where key = ?", [old])[0]?.n).toBe(0);
  });

  test("the size cap: exactly 512 KiB is accepted, one byte more is refused", async () => {
    const exact = await own("upload_logo", { image: b64(png(512 * 1024)), content_type: "image/png" }, true);
    expect(exact.ok, JSON.stringify(exact)).toBe(true);
    const key = rows("select value from app__settings where key = 'brand_logo_key'")[0]?.value as string;
    expect(rows("select bytes from renox__files where key = ?", [key])[0]?.bytes).toBe(512 * 1024);
    expectInvalid(await own("upload_logo", { image: b64(png(512 * 1024 + 1)), content_type: "image/png" }), "512 KiB + 1");
    expect(rows("select value from app__settings where key = 'brand_logo_key'")[0]?.value).toBe(key);
  });

  test("a wrong type: the bytes decide, not the declared type", async () => {
    const cases: [string, string, string][] = [
      ["text declared as a PNG", b64(new TextEncoder().encode("this is not an image at all")), "image/png"],
      ["a PNG declared as a JPEG", b64(png(256)), "image/jpeg"],
      ["a GIF declared as a PNG", b64(new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000")), "image/png"],
      ["an HTML page declared as an SVG", b64(new TextEncoder().encode("<html><body>hi</body></html>")), "image/svg+xml"],
      ["a PNG declared as an SVG", b64(png(256)), "image/svg+xml"],
    ];
    for (const [label, image, content_type] of cases) {
      const r = refusal(await own("upload_logo", { image, content_type }));
      expect(r.error, label).toBe("bad_input");
    }
    // A type outside the three is an input error, as is an image that is no base64.
    expectInvalid(await own("upload_logo", { image: b64(png(64)), content_type: "image/webp" }), "invalid logo input");
    expectInvalid(await own("upload_logo", { image: b64(png(64)), content_type: "image/gif" }), "invalid logo input");
    expectInvalid(await own("upload_logo", { image: "not base64 !!", content_type: "image/png" }), "invalid logo input");
    expectInvalid(await own("upload_logo", { image: "", content_type: "image/png" }), "invalid logo input");
    expectInvalid(await own("upload_logo", { content_type: "image/png" }), "invalid logo input");
  });

  test("an SVG goes through the storage module's sanitiser: the script and the handler do not survive", async () => {
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>alert(1)</script><rect width="40" height="40" fill="#e40" onclick="alert(2)"/></svg>';
    const done = await own("upload_logo", { image: b64(new TextEncoder().encode(svg)), content_type: "image/svg+xml" }, true);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    const key = rows("select value from app__settings where key = 'brand_logo_key'")[0]?.value as string;
    expect(key).toMatch(/^app\/brand\/logo-[a-z0-9]+\.svg$/u);
    expect(done.result).toEqual({ logo_url: `/_files/${key}` });
    const served = await t.request("GET", `/_files/${key}`);
    expect(served.status).toBe(200);
    expect(served.html).toContain("<rect");
    expect(served.html).not.toMatch(/<script|onclick|alert/u);
  });
});

describe("list_branches, add_branch and update_branch", () => {
  test("list_branches: the seed's two branches, as the page lists them", async () => {
    const r = await own("list_branches", {});
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toEqual({
      branches: [
        { id: "br_dubai", name: "Dubai", emirate: "dubai" },
        { id: "br_sharjah", name: "Sharjah", emirate: "sharjah" },
      ],
    });
    expectInvalid(await own("list_branches", { all: true }), "an unknown property");
  });

  test("add_branch: today an agent cannot create the organisation (org's services answer a browser session): `unavailable`, nothing written, no confirmation", async () => {
    const args = { branch: { name: "Ajman Marina", emirate: "ajman" } };
    const counts = () => [rows("select count(*) as n from org__orgs")[0]?.n, rows("select count(*) as n from app__branches")[0]?.n, rows("select count(*) as n from app__branch_hours")[0]?.n, rows("select count(*) as n from audit__events where action = 'branch.create'")[0]?.n];
    const before = counts();
    const preview = await own("add_branch", args);
    expect(refusal(preview)).toMatchObject({ error: "unavailable" });
    expect(preview.confirmation).toBeUndefined();
    const done = await own("add_branch", args, true);
    expect(refusal(done)).toMatchObject({ error: "unavailable" });
    expect(counts()).toEqual(before);
  });

  test("add_branch: a taken name, a name with no Latin letter, an unknown emirate and a long name are refused; nothing is written", async () => {
    const before = rows("select count(*) as n from app__branches")[0]?.n;
    expect(refusal(await own("add_branch", { branch: { name: "  Dubai!  ", emirate: "dubai" } }))).toMatchObject({ error: "bad_input" });
    expect(refusal(await own("add_branch", { branch: { name: "عجمان", emirate: "ajman" } }))).toMatchObject({ error: "bad_input" });
    for (const branch of [{ name: "Nowhere", emirate: "atlantis" }, { name: "x".repeat(81), emirate: "dubai" }, { name: "", emirate: "dubai" }, { name: "Nowhere" }, { emirate: "dubai" }, { name: "Nowhere", emirate: "dubai", phone: "1" }]) {
      expectInvalid(await own("add_branch", { branch }), JSON.stringify(branch));
    }
    expectInvalid(await own("add_branch", {}), "no branch");
    expect(rows("select count(*) as n from app__branches")[0]?.n).toBe(before);
  });

  test("update_branch: the first call names the change; the confirmed one renames the branch and changes its emirate, the Arabic name and the address name stay", async () => {
    const args = { id: "br_sharjah", branch: { name: "Sharjah Central", emirate: "ajman" } };
    const preview = await own("update_branch", args);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.preview).toEqual({ would_change: [{ field: "name", from: "Sharjah", to: "Sharjah Central" }, { field: "emirate", from: "sharjah", to: "ajman" }] });
    expect(rows("select name_en from app__branches where id = 'br_sharjah'")[0]?.name_en).toBe("Sharjah");
    const done = await own("update_branch", args, true);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(done.result).toEqual({ id: "br_sharjah", name: "Sharjah Central", emirate: "ajman" });
    expect(rows("select name_en, name_ar, emirate, slug, org_id from app__branches where id = 'br_sharjah'")[0]).toMatchObject({ name_en: "Sharjah Central", name_ar: "الشارقة", emirate: "ajman", slug: "sharjah", org_id: "org_sharjah" });
    expect(((await own("list_branches", {})).result as { branches: { id: string; name: string }[] }).branches.find((b) => b.id === "br_sharjah")?.name).toBe("Sharjah Central");
    // One key alone; an English name that was also the Arabic one drags it along.
    expect((await own("update_branch", { id: "br_dubai", branch: { emirate: "dubai" } }, true)).result).toEqual({ id: "br_dubai", name: "Dubai", emirate: "dubai" });
    expect(rows("select name_ar from app__branches where id = 'br_dubai'")[0]?.name_ar).toBe("دبي");
    expect(rows("select count(*) as n from audit__events where action = 'branch.update'")[0]?.n).toBeGreaterThanOrEqual(2);
  });

  test("update_branch: an unknown id is not_found; bad ids, an empty change and an unknown emirate are input errors", async () => {
    expect(refusal(await own("update_branch", { id: "br_nowhere", branch: { name: "X" } }))).toMatchObject({ error: "not_found" });
    for (const args of [{ id: "BR DUBAI", branch: { name: "X" } }, { id: "br_dubai", branch: {} }, { id: "br_dubai", branch: { emirate: "atlantis" } }, { id: "br_dubai", branch: { name: "x".repeat(81) } }, { branch: { name: "X" } }, { id: "br_dubai" }]) {
      expectInvalid(await own("update_branch", args), JSON.stringify(args));
    }
    expect(rows("select name_en from app__branches where id = 'br_dubai'")[0]?.name_en).toBe("Dubai");
  });

  test("a branch manager is forbidden the branch tools the page forbids (the page needs settings.write)", async () => {
    const manager = await signIn("manager-tools", "manager.dubai@fixit.example");
    for (const [name, args] of [["add_branch", { branch: { name: "Nope", emirate: "dubai" } }], ["update_branch", { id: "br_dubai", branch: { name: "Nope" } }], ["list_branches", {}]] as [string, Record<string, unknown>][]) {
      expect((await t.tool(name, args, { as: manager })).error?.code, name).toBe("RENOX_FORBIDDEN");
    }
  });
});

describe("list_services, add_service and update_service", () => {
  test("list_services: the catalogue with ids, prices in AED and the active flag", async () => {
    const r = await own("list_services", {});
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const services = (r.result as { services: { id: number; name: string; price_aed: number; active: boolean }[] }).services;
    const seeded = rows("select id, name_en, price_fils, active from app__services where branch_id is null order by id");
    expect(services.length).toBe(seeded.length);
    expect(services.map((s) => s.id)).toEqual(seeded.map((s) => Number(s.id)));
    const ac = services.find((s) => s.name === "AC service");
    expect(ac).toMatchObject({ price_aed: Number(rows("select price_fils from app__services where code = 'AC-SERVICE'")[0]?.price_fils) / 100, active: true });
    expect(Object.keys(services[0] ?? {}).sort()).toEqual(["active", "id", "name", "price_aed"]);
    // A dispatcher reads it too (the page's customer.read).
    expect(((await t.tool("list_services", {}, { as: dina })).result as { services: unknown[] }).services).toHaveLength(services.length);
  });

  test("add_service: the first call creates nothing; the confirmed one adds a visit with a code, 5 % VAT, on offer", async () => {
    const args = { service: { name: "Window cleaning", price_aed: 120.5 } };
    const n = rows("select count(*) as n from app__services")[0]?.n;
    const preview = await own("add_service", args);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.preview).toEqual({ would_create: { name: "Window cleaning", price_aed: 120.5 } });
    expect(rows("select count(*) as n from app__services")[0]?.n).toBe(n);
    const done = await own("add_service", args, true);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    const made = done.result as { id: number; name: string; price_aed: number; active: boolean };
    expect(made).toMatchObject({ name: "Window cleaning", price_aed: 120.5, active: true });
    expect(rows("select code, name_en, name_ar, unit, price_fils, vat_rate, active, branch_id from app__services where id = ?", [made.id])[0]).toEqual({ code: "WINDOW-CLEANING", name_en: "Window cleaning", name_ar: "Window cleaning", unit: "visit", price_fils: 12050, vat_rate: 5, active: 1, branch_id: null });
    expect(rows("select count(*) as n from audit__events where action = 'service.create' and resource_id = ?", [String(made.id)])[0]?.n).toBe(1);
    // The same name again gets its own code; a price of zero and the highest price are accepted.
    const again = (await own("add_service", { service: { name: "Window cleaning", price_aed: 0 } }, true)).result as { id: number };
    expect(rows("select code from app__services where id = ?", [again.id])[0]?.code).toBe("WINDOW-CLEANING-2");
    expect((await own("add_service", { service: { name: "Tower", price_aed: 1_000_000 } }, true)).ok).toBe(true);
    expect((((await own("list_services", {})).result as { services: { name: string }[] }).services).map((s) => s.name)).toContain("Window cleaning");
    // The new service is one a job can be created for: the booking catalogue reads the same table.
    expect(rows("select count(*) as n from app__services where active = 1 and code = 'WINDOW-CLEANING'")[0]?.n).toBe(1);
  });

  test("add_service: a negative or too high price, three decimals, a text price, no name and extra keys are input errors", async () => {
    const n = rows("select count(*) as n from app__services")[0]?.n;
    const bad = [{ name: "Nope", price_aed: -1 }, { name: "Nope", price_aed: 1_000_000.01 }, { name: "Nope", price_aed: 10.123 }, { name: "Nope", price_aed: "10" }, { name: "Nope" }, { price_aed: 10 }, { name: "", price_aed: 10 }, { name: "x".repeat(81), price_aed: 10 }, { name: "Nope", price_aed: 10, active: true }];
    for (const service of bad) expectInvalid(await own("add_service", { service }), JSON.stringify(service));
    expectInvalid(await own("add_service", {}), "no service");
    expect(rows("select count(*) as n from app__services")[0]?.n).toBe(n);
  });

  test("update_service: the first call names the price change; the confirmed one changes price, name and the switch", async () => {
    const id = Number(rows("select id from app__services where code = 'AC-SERVICE'")[0]?.id);
    const old = Number(rows("select price_fils from app__services where id = ?", [id])[0]?.price_fils) / 100;
    const preview = await own("update_service", { id, service: { price_aed: 180 } });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.preview).toEqual({ would_change: [{ field: "price_aed", from: old, to: 180 }] });
    expect(rows("select price_fils from app__services where id = ?", [id])[0]?.price_fils).toBe(old * 100);
    const done = await own("update_service", { id, service: { price_aed: 180, active: false, name: "AC servicing" } }, true);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(done.result).toEqual({ id, name: "AC servicing", price_aed: 180, active: false });
    expect(rows("select name_en, price_fils, active, code from app__services where id = ?", [id])[0]).toEqual({ name_en: "AC servicing", price_fils: 18000, active: 0, code: "AC-SERVICE" });
    expect(((await own("list_services", {})).result as { services: { id: number; active: boolean }[] }).services.find((s) => s.id === id)?.active).toBe(false);
    expect(rows("select count(*) as n from audit__events where action = 'service.update' and resource_id = ?", [String(id)])[0]?.n).toBe(1);
    // Switched back on, the price stays.
    expect((await own("update_service", { id, service: { active: true } }, true)).result).toEqual({ id, name: "AC servicing", price_aed: 180, active: true });
  });

  test("update_service: an unknown id is not_found; a service of another branch is not found either; bad input is refused", async () => {
    expect(refusal(await own("update_service", { id: 99999, service: { active: false } }))).toMatchObject({ error: "not_found" });
    for (const args of [{ id: 0, service: { active: false } }, { id: 1.5, service: { active: false } }, { id: "1", service: { active: false } }, { id: 1, service: {} }, { id: 1, service: { price_aed: -5 } }, { id: 1, service: { active: "no" } }, { id: 1, service: { code: "X" } }, { service: { active: false } }]) {
      expectInvalid(await own("update_service", args), JSON.stringify(args));
    }
  });

  test("a branch manager and an accountant are forbidden to change the catalogue", async () => {
    const manager = await signIn("manager-tools-2", "manager.dubai@fixit.example");
    for (const user of [manager, accountant]) {
      for (const [name, args] of [["add_service", { service: { name: "Nope", price_aed: 1 } }], ["update_service", { id: 1, service: { active: false } }]] as [string, Record<string, unknown>][]) {
        expect((await t.tool(name, args, { as: user })).error?.code, name).toBe("RENOX_FORBIDDEN");
      }
    }
  });
});

describe("list_people", () => {
  test("the people of the branch the token acts in, with the contract's roles and no secret", async () => {
    const r = await own("list_people", {});
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const people = (r.result as { people: { email: string; role: string | null; status: string; branch: string }[] }).people;
    expect(people).toEqual(expect.arrayContaining([
      { email: "owner@fixit.example", role: "owner", status: "active", branch: "dubai" },
      { email: "manager.dubai@fixit.example", role: "manager", status: "active", branch: "dubai" },
      { email: "dispatcher.dubai@fixit.example", role: "dispatcher", status: "active", branch: "dubai" },
      { email: "ali.dubai@fixit.example", role: "technician", status: "active", branch: "dubai" },
      { email: "accountant.dubai@fixit.example", role: "accountant", status: "active", branch: "dubai" },
    ]));
    // Only the token's branch: nobody of Sharjah.
    expect(people.map((p) => p.email)).not.toContain("dispatcher.sharjah@fixit.example");
    expect(Object.keys(people[0] ?? {}).sort()).toEqual(["branch", "email", "role", "status"]);
    expect(JSON.stringify(r.result)).not.toMatch(/argon2|password|u_dxb|twofa|token/iu);
  });

  test("an invitation that waits is listed as invited, with the role it will get", async () => {
    // What the people page's ?/invite leaves (its own test sends it with a second factor): an org invitation and this row.
    const db = new Database(t.dbFile);
    db.exec("pragma busy_timeout = 5000");
    db.query("insert into app__staff_invites (branch_id, org_id, email, role, invited_by, created_at, applied_at) values ('br_dubai', 'org_dubai', 'new.hire@example.com', 'branch_manager', 'u_owner', 1793000000, null)").run();
    db.close();
    const people = ((await own("list_people", {})).result as { people: { email: string; role: string | null; status: string; branch: string }[] }).people;
    expect(people.find((p) => p.email === "new.hire@example.com")).toEqual({ email: "new.hire@example.com", role: "manager", status: "invited", branch: "dubai" });
  });

  test("a technician, a dispatcher and an accountant are forbidden the list (the page needs settings.read)", async () => {
    for (const user of [ali, dina, accountant]) expect((await t.tool("list_people", {}, { as: user })).error?.code).toBe("RENOX_FORBIDDEN");
  });
});

describe("invite_staff (#751)", () => {
  const EMAIL = "sara.tech@example.com";
  const args = { email: EMAIL, role: "technician", branch: "dUbAi" };
  const invitesOf = (email: string) => [rows("select count(*) as n from org__invites where email = ?", [email])[0]?.n, rows("select count(*) as n from app__staff_invites where email = ?", [email])[0]?.n];

  test("only the owner's agent may call it: a technician, a dispatcher, a branch manager and an accountant are forbidden (403, no preview)", async () => {
    const manager = await signIn("manager", "manager.dubai@fixit.example");
    for (const user of [ali, dina, manager, accountant]) {
      const r = await t.tool("invite_staff", args, { as: user });
      expect(r.error?.code).toBe("RENOX_FORBIDDEN");
      expect(r.preview).toBeUndefined();
      expect(r.confirmation).toBeUndefined();
    }
    expect(invitesOf(EMAIL)).toEqual([0, 0]);
    const list = await listTools(t, await ownerAgentToken(1));
    expect(list.tools.find((x) => x.name === "invite_staff")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(list.tools.find((x) => x.name === "invite_staff")?.inputSchema.required).toEqual(["email", "role", "branch"]);
  });

  test("an unknown branch names the branches; an unknown role, owner, a bad email and an extra property are refused; nothing is written", async () => {
    const unknown = refusal(await own("invite_staff", { ...args, branch: "Atlantis" }));
    // The names as they are now (an earlier test renamed Sharjah).
    const names = rows("select name_en from app__branches order by created_at, id").map((b) => String(b.name_en));
    expect(unknown).toMatchObject({ error: "bad_input", message: expect.stringContaining(names.join(", ")), branches: names });
    expectInvalid(await own("invite_staff", { ...args, role: "janitor" }), "an unknown role");
    expectInvalid(await own("invite_staff", { ...args, role: "owner" }), "owner");
    expectInvalid(await own("invite_staff", { ...args, email: "not an email" }), "a bad email");
    expectInvalid(await own("invite_staff", { ...args, extra: 1 }), "an extra property");
    expectInvalid(await own("invite_staff", { email: EMAIL, role: "technician" }), "no branch");
    expect(invitesOf(EMAIL)).toEqual([0, 0]);
  });

  test("the first call names the invitation in plain words and writes nothing", async () => {
    const preview = await own("invite_staff", args);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.preview).toMatchObject({ would_invite: { email: EMAIL, role: "technician", branch: "Dubai" }, plan: `Invite ${EMAIL} as a technician in the Dubai branch.` });
    expect(invitesOf(EMAIL)).toEqual([0, 0]);
    expect(rows("select count(*) as n from email__messages where to_address = ?", [EMAIL])[0]?.n).toBe(0);
  });

  test("confirmed: an org invitation, a staff invitation with the role and an audit row; after accepting, the person holds the role in that branch only", async () => {
    const done = await own("invite_staff", args, true);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(done.result).toEqual({ invited: true, email: EMAIL, role: "technician", branch: "Dubai", joined: false });
    expect(rows("select org_id, role, invited_by from org__invites where email = ?", [EMAIL])).toEqual([{ org_id: "org_dubai", role: "member", invited_by: "u_owner" }]);
    expect(rows("select branch_id, role, invited_by, applied_at from app__staff_invites where email = ?", [EMAIL])).toEqual([{ branch_id: "br_dubai", role: "technician", invited_by: "u_owner", applied_at: null }]);
    expect(Number(rows("select count(*) as n from audit__events where action = 'staff.invite'")[0]?.n)).toBeGreaterThanOrEqual(1);
    // The invitation mail carries the accept link on the app's own host (a tool call has no request origin: the
    // email module completes org's path on its app_url, #765); the invitee follows it.
    const mail = rows("select text_body, html_body from email__messages where to_address = ? order by at desc limit 1", [EMAIL])[0] as { text_body: string; html_body: string };
    const link = /https:\/\/home-services\.renoxium\.app\/org\/accept\/[A-Za-z0-9_-]+/u.exec(mail.text_body)?.[0] ?? "";
    expect(link).not.toBe("");
    expect(mail.html_body).toContain(`href="${link}"`);
    const accept = new URL(link).pathname;

    const sara = t.as("sara");
    expect((await sara.action("/auth/register", "default", { email: EMAIL, password: PASSWORD, display_name: "Sara Tech" })).status).toBe(200);
    expect((await sara.action("/auth/login", "default", { email: EMAIL, password: PASSWORD })).status).toBe(303);
    expect((await sara.action(accept, "accept", {})).status).toBe(303);
    let held: Record<string, unknown>[] = [];
    for (let i = 0; i < 100 && held.length === 0; i++) {
      held = rows("select role, scope_type, scope_id from renox__role_assignments where user_id = (select id from auth__users where email = ?)", [EMAIL]);
      if (held.length === 0) await Bun.sleep(50);
    }
    expect(held).toEqual([{ role: "technician", scope_type: "org", scope_id: "org_dubai" }]);
    expect(rows("select applied_at is not null as done from app__staff_invites where email = ?", [EMAIL])).toEqual([{ done: 1 }]);
  });

  test("a branch is found by its Arabic name too, and by its id", async () => {
    const ar = String(rows("select name_ar from app__branches where id = 'br_sharjah'")[0]?.name_ar);
    const by = await own("invite_staff", { email: "mona.mgr@example.com", role: "branch_manager", branch: ` ${ar} ` }, true);
    expect(by.ok, JSON.stringify(by)).toBe(true);
    expect(by.result).toMatchObject({ invited: true, role: "branch_manager", branch: String(rows("select name_en from app__branches where id = 'br_sharjah'")[0]?.name_en) });
    const byId = await own("invite_staff", { email: "omar.acc@example.com", role: "accountant", branch: "br_sharjah" }, true);
    expect(byId.ok, JSON.stringify(byId)).toBe(true);
    expect(rows("select branch_id, role from app__staff_invites where email in ('mona.mgr@example.com', 'omar.acc@example.com') order by email")).toEqual([
      { branch_id: "br_sharjah", role: "branch_manager" },
      { branch_id: "br_sharjah", role: "accountant" },
    ]);
  });
});

// The customer portal's three settings through the owner connector (#779): "let customers book online and confirm
// automatically" is one update_settings call, with the page's ranges and a plan in plain words.
describe("update_settings: the customer portal (#779)", () => {
  const portalRows = () => rows("select key, value from app__settings where key like 'portal_%' order by key");

  test("get_settings shows the portal as it applies (the defaults while nothing is set)", async () => {
    expect((await own("get_settings", {})).result).toMatchObject({ portal: { auto_confirm: false, cutoff_hours: 12, max_reschedules: 2 } });
  });

  test("the first call names each change in plain words and writes nothing; the confirmed one writes, audits and answers", async () => {
    const args = { settings: { portal: { auto_confirm: true, cutoff_hours: 24, max_reschedules: 2 } } };
    const preview = await own("update_settings", args);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    // max_reschedules is already 2 (the default): it is not a change.
    expect(preview.preview).toEqual({
      would_change: [
        { key: "portal_auto_confirm", from: "0", to: "1" },
        { key: "portal_cutoff_hours", from: "12", to: "24" },
      ],
      plan: "Confirm online bookings automatically: off → on; Customers may change a visit until: 12 hours before → 24 hours before.",
    });
    expect(portalRows()).toEqual([]);
    const done = await own("update_settings", args, true);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(done.result).toMatchObject({ portal: { auto_confirm: true, cutoff_hours: 24, max_reschedules: 2 } });
    expect(portalRows()).toEqual([
      { key: "portal_auto_confirm", value: "1" },
      { key: "portal_cutoff_hours", value: "24" },
    ]);
    const audit = JSON.parse(String(rows("select details from audit__events where action = 'settings.update' order by rowid desc limit 1")[0]?.details)) as { keys: string[] };
    expect(audit.keys.sort()).toEqual(["portal_auto_confirm", "portal_cutoff_hours"]);
    // Off again, with the brand in the same call: the plan names both.
    const both = await own("update_settings", { settings: { brand_name: "FixIt Plus", portal: { auto_confirm: false } } });
    expect((both.preview as { plan: string }).plan).toContain("Confirm online bookings automatically: on → off");
    expect((both.preview as { plan: string }).plan).toContain('Company name: "');
    expect((await own("update_settings", { settings: { portal: { auto_confirm: false } } }, true)).result).toMatchObject({ portal: { auto_confirm: false } });
  });

  test("the page's ranges: out of range, not whole, not a boolean or an unknown key is invalid and writes nothing; the limits are accepted", async () => {
    const before = portalRows();
    const bad: Record<string, unknown>[] = [
      { settings: { portal: {} } },
      { settings: { portal: { cutoff_hours: 169 } } },
      { settings: { portal: { cutoff_hours: -1 } } },
      { settings: { portal: { cutoff_hours: 1.5 } } },
      { settings: { portal: { cutoff_hours: "12" } } },
      { settings: { portal: { max_reschedules: 6 } } },
      { settings: { portal: { auto_confirm: "yes" } } },
      { settings: { portal: { waiting_list: true } } },
      { settings: { portal: true } },
    ];
    for (const args of bad) expectInvalid(await own("update_settings", args), JSON.stringify(args));
    expect(portalRows()).toEqual(before);
    expect((await own("update_settings", { settings: { portal: { cutoff_hours: 168, max_reschedules: 0 } } }, true)).result).toMatchObject({ portal: { cutoff_hours: 168, max_reschedules: 0 } });
    expect((await own("update_settings", { settings: { portal: { cutoff_hours: 0, max_reschedules: 5 } } }, true)).result).toMatchObject({ portal: { cutoff_hours: 0, max_reschedules: 5 } });
  });

  test("a dispatcher's agent cannot change the portal", async () => {
    const r = await t.tool("update_settings", { settings: { portal: { auto_confirm: true } } }, { as: dina });
    expect(r.error?.code).toBe("RENOX_FORBIDDEN");
  });
});

// #816: `list_low_stock`, the owner connector's read-only tool for "what are we running out of?": per branch the
// token acts in, the parts under their minimum (SKU, name, unit, on hand, minimum), at most 20 a branch. `stock.read`
// like /admin/stock: a dispatcher's and an accountant's agent read it, a technician's is refused by the cell.
describe("list_low_stock (#816)", () => {
  const DUBAI_LOW = [
    { sku: "FIL-AC-C", name: "AC filter, cassette unit", unit: "piece", on_hand: 4, minimum: 6 },
    { sku: "PVC-TEE-25", name: "PVC tee 25 mm", unit: "piece", on_hand: 25, minimum: 30 },
    { sku: "REF-R22", name: "Refrigerant R22", unit: "kg", on_hand: 2, minimum: 3 },
  ];

  test("a dispatcher's agent gets Dubai's three parts under their minimum; the tool is read only and asks for no confirmation", async () => {
    const list = await t.tools({ as: dina });
    expect(list.tools.find((x) => x.name === "list_low_stock")?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    const r = await t.tool("list_low_stock", {}, { as: dina });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.confirmation).toBeUndefined();
    expect(r.result).toEqual({ branches: [{ branch: "dubai", name: "Dubai", low_parts: DUBAI_LOW, more: 0 }] });
    expect((await t.tool("list_low_stock", {}, { as: accountant })).ok).toBe(true);
  });

  test("the owner's agent (acting in Dubai) gets the same; an unknown property is refused", async () => {
    const r = await own("list_low_stock", {});
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toEqual({ branches: [{ branch: "dubai", name: "Dubai", low_parts: DUBAI_LOW, more: 0 }] });
    expectInvalid(await own("list_low_stock", { branch: "sharjah" }), "an unknown property");
  });

  test("a technician's agent is forbidden (403, no preview, no confirmation)", async () => {
    const r = await t.tool("list_low_stock", {}, { as: ali });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("RENOX_FORBIDDEN");
    expect(r.preview).toBeUndefined();
    expect(r.confirmation).toBeUndefined();
  });

  test("a branch lists at most 20 parts and says how many more there are", async () => {
    const db = new Database(t.dbFile);
    db.exec("pragma busy_timeout = 5000");
    try {
      for (let i = 1; i <= 20; i++) db.run("insert into app__parts (id, sku, name_en, name_ar, unit, cost_fils, sell_fils, vat_rate, min_stock, active, created_at) values (?, ?, ?, ?, 'piece', 100, 200, 5, 5, 1, 1700000000)", [`pt_00000000000e00${i.toString(16).padStart(2, "0")}`, `LOW-${String(i).padStart(2, "0")}`, `Low part ${i}`, `قطعة ${i}`]);
    } finally {
      db.close();
    }
    const r = await t.tool("list_low_stock", {}, { as: dina });
    const dubai = (r.result as { branches: { low_parts: unknown[]; more: number }[] }).branches[0];
    expect(dubai?.low_parts).toHaveLength(20);
    // Three of the demo parts and the twenty added are under their minimum in Dubai: 23 in all.
    expect(dubai?.more).toBe(3);
  });
});
