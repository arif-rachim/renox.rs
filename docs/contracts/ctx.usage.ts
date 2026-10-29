// Type-level examples for ctx.d.ts: compiled by `tsc --noEmit -p docs/contracts`,
// never run. Valid uses must compile; each `@ts-expect-error` line must fail.
import type {
  Action,
  ActionContext,
  Ctx,
  EventHandler,
  FetchBlockedError,
  ForbiddenError,
  Guard,
  HookFiller,
  HooksModule,
  JobContext,
  JobModule,
  MessageContext,
  ModuleServiceError,
  FunctionModule,
  Handler,
  Loader,
  LoaderContext,
  Ops,
  PageModule,
  PageResult,
  RealtimeContext,
  RealtimeEnvelope,
  Row,
  ServicesModule,
  SseModule,
  Tool,
  ToolDefinition,
  ToolEnvelope,
  WsModule,
} from "./ctx.d.ts";
// The builder is declared in ctx.d.ts; a declaration file cannot be value-imported.
declare const tool: typeof import("./ctx.d.ts").tool;

interface Product extends Row {
  id: string;
  name: string;
  stock: number;
}

export const GET: Handler = async ({ db, url, log, deadline }: Ctx) => {
  const rows = await db.query<Product>("select id, name, stock from shop__products where org_id = ? limit ?", [
    url.searchParams.get("org"),
    50,
  ]);
  const one = await db.queryOne<Product>("select id, name, stock from shop__products where id = ?", ["p1"]);
  await db.transaction(async (tx) => {
    const info = await tx.execute("update shop__products set stock = stock - 1 where id = ? and stock > 0", ["p1"]);
    if (info.changes === 0) throw new Error("out of stock");
  });
  log.info("listed", { count: rows.length, first: one?.name ?? null, leftMs: deadline.remainingMs() });
  return Response.json(rows);
};

export const POST: Handler = async ({ fetch, secrets, req }) => {
  const res = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: { authorization: `Bearer ${secrets.STRIPE_KEY ?? ""}` },
    body: await req.text(),
  });
  return new Response(res.body, { status: res.status });
};

export const mod: FunctionModule = { GET, POST };

export function describe(e: FetchBlockedError): string {
  return `${e.details.host}: ${e.details.reason}`;
}

// Pages (ops.md section 14).
export const load: Loader = async ({ params, db, fragment, session }: LoaderContext) => {
  const product = await db.queryOne<Product>("select id, name, stock from app__products where id = ?", [
    String(params.id),
  ]);
  if (!product) return new Response(null, { status: 404 });
  if (fragment === "cart_badge") return { cartFor: session.id };
  return { product, inStock: product.stock > 0 };
};

const addToCart: Action = async ({ form, db, session }: ActionContext) => {
  const productId = form.get("productId");
  if (typeof productId !== "string") return new Response("bad request", { status: 400 });
  await db.execute("insert into app__cart_items (session_id, product_id) values (?, ?)", [session.id, productId]);
  return { fragments: ["cart_badge", `product_${productId}`] };
};

export const page: PageModule = { load, actions: { addToCart } };

export const rendered: PageResult = { type: "render", data_json: '{"inStock":true}', fragments: [] };

export async function pageNegatives(ctx: ActionContext, lctx: LoaderContext): Promise<void> {
  // @ts-expect-error an action's db is its transaction: no nested transaction()
  await ctx.db.transaction(async () => undefined);
  // @ts-expect-error loaders get no form
  lctx.form.get("x");
  // @ts-expect-error the session id is read-only
  ctx.session.id = "x";
  // @ts-expect-error a loader returns an object or a Response
  const badLoad: Loader = () => 42;
  void badLoad;
  // @ts-expect-error fragments are names
  const badAction: Action = () => ({ fragments: [1] });
  void badAction;
  // @ts-expect-error a render result carries the data as JSON text
  const badResult: PageResult = { type: "render", data_json: { a: 1 }, fragments: [] };
  void badResult;
}

export async function negatives(ctx: Ctx, ops: Ops): Promise<void> {
  // @ts-expect-error objects are not SQL parameters
  await ctx.db.query("select 1 where ? = 1", [{ a: 1 }]);
  // @ts-expect-error undefined is not a parameter (use null)
  await ctx.db.execute("insert into app__t values (?)", [undefined]);
  // @ts-expect-error secrets are read-only
  ctx.secrets.STRIPE_KEY = "x";
  // @ts-expect-error a resource is an object with type and id (section 17)
  ctx.authz.require("x", "y");
  // @ts-expect-error ai is reserved for F7
  ctx.ai.chat("x");
  // @ts-expect-error log fields must be JSON values
  ctx.log.info("bad", { when: new Date() });
  // @ts-expect-error a handler must return a Response
  const bad: Handler = () => ({ ok: true });
  void bad;
  // @ts-expect-error transaction handles are numbers
  await ops.op_db_tx_commit("tx1");
  // @ts-expect-error only deferred and immediate transactions exist
  await ops.op_db_tx_begin("exclusive");
}

// Modules (ops.md section 15, 1.3.0).
export const services: ServicesModule = {
  async currentUser(ctx: Ctx) {
    const sid = ctx.req.headers.get("cookie") ?? "";
    return ctx.db.queryOne("select id, email from auth__users where session = ?", [sid]);
  },
};

export async function useModules(ctx: Ctx): Promise<Response> {
  const user = await ctx.services.auth?.currentUser?.();
  const minLength = ctx.config.password_min_length;
  const hash = await ctx.password.hash("correct horse battery staple");
  const ok: boolean = await ctx.password.verify("correct horse battery staple", hash);
  const id: string = await ctx.events.emit("auth.user_registered", { user_id: "u_1" });
  await ctx.events.emit("auth.cart_changed", { cart_id: "c1" }, { durable: false });
  const r = await ctx.hooks.run("auth.after_login", { user_id: "u_1" });
  if (r.halt) return r.response;
  try {
    await ctx.db.transaction(async () => ctx.services.billing?.charge?.("u_1", 4200));
  } catch (e) {
    const err = e as ModuleServiceError;
    ctx.log.warn("charge failed", { module: err.module, service: err.service, cause: err.details.cause_code });
  }
  return Response.json({ user: user ?? null, minLength: minLength ?? null, ok, id, module: ctx.module });
}

const afterLogin: HookFiller = {
  priority: 10,
  handle: (_ctx, _args: { user_id: string }) => ({ halt: true, response: Response.redirect("/2fa", 303) }),
};
const onPaid: EventHandler = async (ctx, e: { id: string; name: string; attempt: number; payload: { invoice_id: string } }) => {
  await ctx.db.execute("insert into email__sent (event_id, invoice_id) values (?, ?)", [e.id, e.payload.invoice_id]);
  ctx.log.info("sent", { attempt: ctx.event.attempt });
};
export const hooksModule: HooksModule = { hooks: { "auth.after_login": afterLogin }, on: { "billing.invoice_paid": onPaid } };

export const localized: Loader = ({ setLocale }) => {
  setLocale("ar-AE");
  setLocale("ar", "rtl");
  return {};
};

// Authorization (ops.md section 17, 1.5.0).
export const guard: Guard = { action: "invoice.read", resource: { type: "Invoice", id: ":id" } };

interface Invoice extends Row {
  id: string;
  amount: number;
  org: string;
  status: string;
}

export const refund: Action = async ({ db, authz, principal, params, log }: ActionContext) => {
  const invoice = await db.queryOne<Invoice>("select id, amount, org, status from billing__invoices where id = ?", [String(params.id)]);
  if (!invoice) return new Response(null, { status: 404 });
  // The row is the resource; only the declared [authz.entities] attributes are kept. Uncaught, a deny is 403.
  await authz.require("invoice.refund", { type: "Invoice", ...invoice });
  const allowed = await authz.canBatch("invoice.refund", [{ type: "Invoice", ...invoice }]);
  log.info("refund", { by: principal?.id ?? "anonymous", mfa: principal?.attrs.mfa_verified ?? false, allowed: allowed[0] ?? false });
  return { refunded: true };
};

export async function roles(ctx: Ctx): Promise<void> {
  await ctx.authz.roles.assign("u_2", "finance", { type: "org", id: "o_1" });
  const mine = await ctx.authz.roles.list("u_2");
  const scoped = ctx.db.scoped({ user_id: "u_2", org_id: "o_1" });
  await scoped.execute("insert into shop__orders (id, total) values (?, ?)", ["ord_9", 4200]); // the owner columns are filled in
  if (!(await ctx.authz.can("invoice.read"))) ctx.log.warn("viewer", { roles: mine.length });
}

export function denied(e: ForbiddenError): string {
  return `${e.details.action}: ${e.details.reason}${e.details.policy ? ` (${e.details.policy})` : ""}`;
}

// Realtime (ops.md section 18, 1.5.0).
export const ws: WsModule = {
  async open({ conn, params, realtime }: RealtimeContext) {
    await realtime.subscribe(conn, `room:${String(params.room)}`); // the Cedar action realtime.subscribe, fail closed
  },
  async message({ conn, data, params, realtime, principal }: MessageContext) {
    const text = typeof data === "string" ? data : "(binary)";
    await realtime.publish(`room:${String(params.room)}`, { fragment: "partials/chat-message", data: { text, user: principal?.id ?? null } });
    await realtime.send(conn, { json: { ok: true } });
  },
  close({ close, log }) {
    log.info("closed", { code: close.code });
  },
};
export const sse: SseModule = {
  async open({ conn, realtime, principal }) {
    if (principal === null) return realtime.close(conn, 1008, "sign in");
    await realtime.subscribe(conn, `user:${principal.id}:inbox`);
  },
};
export const openEnvelope: RealtimeEnvelope = { kind: "realtime", phase: "open", transport: "ws", conn: "c_01JBQ3Z7MA00000000000001", route: "/ws/chat/:room", params: { room: "42" }, session: { id: "Q2hhbmdlTWVQbGVhc2UxMg" } };

// App MCP tools (ops.md section 19, 1.5.0).
const createInvoiceInput = { "~standard": { version: 1 as const, vendor: "renox", validate: (v: unknown) => v }, __input: undefined as { customerId: string } | undefined };
export const createInvoice: Tool<{ customerId: string }> = tool({
  name: "create_invoice",
  description: "Create a draft invoice for a customer",
  input: createInvoiceInput,
  action: "invoice.create",
  async run({ tool: t, services }) {
    if (t.preview) return { would_create_for: t.input.customerId };
    return services.billing?.createInvoice?.(t.input.customerId);
  },
});
export const toolEnvelope: ToolEnvelope = { kind: "tool", name: "create_invoice", input: { customerId: "c_7" }, principal: { id: "u_1", kind: "user", roles: [], attrs: {} }, client: { name: "claude-desktop" }, preview: false, request_id: "01JBQ3Z7MA0000000000000301" };

// Jobs (ops.md section 20, 1.5.0).
export const schedule = "0 3 * * *";
export const nightly: JobModule = {
  schedule,
  tz: "Asia/Dubai",
  async run({ db, job, jobs, principal }: JobContext) {
    const rows = await db.query("select id from app__reports where sent = 0");
    for (const r of rows) await jobs.enqueue("send-report", { report: r.id }, { runAt: job.tick + 60_000 });
    if (principal?.kind !== "system") throw new Error("a job runs as the System principal");
  },
};

export async function f5Negatives(ctx: Ctx, rctx: RealtimeContext, ops: Ops): Promise<void> {
  // @ts-expect-error the principal is read-only
  ctx.principal = null;
  // @ts-expect-error a scope has user_id, org_id and session_id only
  ctx.db.scoped({ tenant_id: "t_1" });
  // @ts-expect-error canBatch takes an array of resources
  await ctx.authz.canBatch("invoice.read", { type: "Invoice", id: "1" });
  // @ts-expect-error a role scope is { type, id }
  await ctx.authz.roles.assign("u_2", "finance", "org");
  // @ts-expect-error a payload is a string, text, json, or fragment
  await ctx.realtime.publish("room:1", { html: "<li>hi</li>" });
  // @ts-expect-error subscribe needs the connection handle, not its id
  await ctx.realtime.subscribe("c_1", "room:1");
  // @ts-expect-error a function handler has no conn
  ctx.conn.id;
  // @ts-expect-error the frame is read-only
  rctx.conn.id = "x";
  // @ts-expect-error a tool needs an action
  const badTool: ToolDefinition<unknown> = { name: "x", description: "x", input: createInvoiceInput, run: () => null };
  void badTool;
  // @ts-expect-error runAt is a number (Unix ms)
  await ctx.jobs.enqueue("send-report", {}, { runAt: "tomorrow" });
  // @ts-expect-error a job module exports run
  const badJob: JobModule = { schedule: "0 3 * * *" };
  void badJob;
  // @ts-expect-error the principal is never an op argument
  await ops.op_authz_check("invoice.read", null, null, "billing", { id: "u_1" });
  // @ts-expect-error a wire payload carries json as text
  await ops.op_realtime_publish("room:1", { type: "json", json_text: { ok: true } }, null);
}

export async function moduleNegatives(ctx: Ctx, lctx: LoaderContext, ops: Ops): Promise<void> {
  // @ts-expect-error config is frozen
  ctx.config.password_min_length = 8;
  // @ts-expect-error an event payload is an object
  await ctx.events.emit("auth.login", "u_1");
  // @ts-expect-error durable is a boolean
  await ctx.events.emit("auth.login", {}, { durable: "yes" });
  // @ts-expect-error dir is ltr or rtl
  lctx.setLocale("ar", "auto");
  // @ts-expect-error function handlers have no page locale
  ctx.setLocale("ar");
  // @ts-expect-error verify needs the stored hash
  await ctx.password.verify("x");
  // @ts-expect-error a hook filler returns undefined or a halt with a response
  const badFiller: HookFiller = { handle: () => ({ halt: true }) };
  void badFiller;
  // @ts-expect-error savepoint handles are numbers
  await ops.op_db_savepoint_release(1, "renox_sp_1");
}
