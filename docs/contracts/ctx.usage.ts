// Type-level examples for ctx.d.ts: compiled by `tsc --noEmit -p docs/contracts`,
// never run. Valid uses must compile; each `@ts-expect-error` line must fail.
import type {
  Action,
  ActionContext,
  Ctx,
  EventHandler,
  FetchBlockedError,
  HookFiller,
  HooksModule,
  ModuleServiceError,
  FunctionModule,
  Handler,
  Loader,
  LoaderContext,
  Ops,
  PageModule,
  PageResult,
  Row,
  ServicesModule,
} from "./ctx.d.ts";

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
  // @ts-expect-error authz is reserved for F5
  ctx.authz.require("x", "y");
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
