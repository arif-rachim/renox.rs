// Typed module APIs (docs/contracts/ops.md section 15; docs/10-modules.md).
// `Ctx.services`, `events`, `hooks` and `config` are untyped in the
// contract; the CLI generates `.renox/types/modules.d.ts` from the installed
// manifests (#236), and `ModuleCtx` narrows the contract's `Ctx` with it.
//
//   import type { ModuleCtx } from "../.renox/types/modules";
//   export const services = defineServices({
//     async getActivePlan(ctx: ModuleCtx<"billing">, userId: string) {
//       const user = await ctx.services.auth.currentUser();   // typed from auth's services.ts
//       await ctx.events.emit("billing.invoice_paid", { invoice_id: "i1", user_id: userId }); // payload checked
//     },
//   });

import type { ConfigValue, Ctx, DeliveredEvent, EmitOptions, EventContext, HookFiller, HookFillerResult, HookRunResult } from "./ctx.ts";

/** What the generated types say about one module. */
export interface ModuleSpec {
  /** Caller-side services (the broker supplies the callee's ctx). */
  services: object;
  /** Event name → payload type, for the events the module exports. */
  events: object;
  /** Hook name → `{ args, result }`, for the hook points the module exports. */
  hooks: object;
  /** Config key → value type. */
  config: object;
}

/** Installed module name → its spec; `app` has no events, hooks, or config. */
export type ModuleMap = Record<string, ModuleSpec>;

/**
 * A `services.ts` export as a caller sees it: the leading `ctx` parameter is
 * dropped and the result is a promise (ops.md section 15.2).
 */
export type ServiceProxy<F> = F extends (ctx: never, ...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

/** All the services of a `services.ts` module, as proxies. */
export type ServicesOf<T> = { readonly [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: ServiceProxy<T[K]> };

/** `ctx.events` with the module's own event names and payloads. */
export interface TypedEvents<E> {
  emit<N extends keyof E & string>(name: N, payload: E[N], options?: EmitOptions): Promise<string>;
}

/** `ctx.hooks` with the module's own hook points. */
export interface TypedHooks<H> {
  run<N extends keyof H & string>(name: N, args: H[N] extends { args: infer A } ? A : unknown): Promise<HookRunResult>;
}

/**
 * The ctx of module `M`: the contract's `Ctx` with `services` typed for every
 * installed module, `events` and `hooks` for `M`'s own exports, and `config`
 * for `M`'s `[config]`.
 */
export type ModuleCtx<Ms extends ModuleMap, M extends keyof Ms | "app"> = Omit<Ctx, "services" | "events" | "hooks" | "config"> & {
  readonly services: { readonly [K in keyof Ms]: Ms[K]["services"] };
  readonly events: TypedEvents<M extends keyof Ms ? Ms[M]["events"] : Record<never, never>>;
  readonly hooks: TypedHooks<M extends keyof Ms ? Ms[M]["hooks"] : Record<never, never>>;
  readonly config: Readonly<M extends keyof Ms ? Ms[M]["config"] : Record<string, ConfigValue>>;
};

/** The shape `services.ts` exports: each service takes the callee's ctx first. */
export type ServiceDefinitions = Record<string, (ctx: never, ...args: never[]) => unknown>;

/**
 * Types a `services.ts` module's exports in one place and returns them
 * unchanged: `export const { getActivePlan } = defineServices({ ... })`.
 */
export function defineServices<const S extends ServiceDefinitions>(services: S): S {
  return services;
}

/** One hook filler, typed by its args. */
export interface HookFillerOf<A> {
  readonly priority?: number;
  handle(ctx: Ctx, args: A): HookFillerResult | Promise<HookFillerResult>;
}

/** One event handler, typed by its payload. */
export type EventHandlerOf<P> = (ctx: EventContext, e: DeliveredEvent<P>) => void | Promise<void>;

/** What `hooks.ts` exports: `{ hooks, on }` (ops.md sections 15.3 and 15.4). */
export interface HooksDefinition {
  hooks?: Readonly<Record<string, HookFiller | HookFillerOf<never>>>;
  on?: Readonly<Record<string, EventHandlerOf<never>>>;
}

/**
 * Types a `hooks.ts` module in one place and returns it unchanged:
 * `export const { hooks, on } = defineHooks({ hooks: { ... }, on: { ... } })`.
 */
export function defineHooks<const H extends HooksDefinition>(definition: H): H {
  return definition;
}

/** A typed event handler for the `on` map: `on: { "billing.invoice_paid": on<Paid>(async (ctx, e) => ...) }`. */
export function on<P>(handler: EventHandlerOf<P>): EventHandlerOf<P> {
  return handler;
}
