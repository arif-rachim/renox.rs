// Page modules (docs/contracts/ops.md section 14): `pages/**/*.ts` export
// `load` and `actions`. Types identical to docs/contracts/ctx.d.ts;
// tests/contract.test-d.ts enforces it.

import type { Ctx } from "./ctx.ts";
import type { DbStatements } from "./db.ts";

/** The session of the request; F2 carries only the id (ops.md section 14, "Session"). */
export interface Session {
  /** Opaque random id, 22 base64url characters, from the signed `__Host-renox_sid` cookie. */
  readonly id: string;
}

export type TextDirection = "ltr" | "rtl";

export interface LoaderContext extends Ctx {
  /** The fragment the cell will render for this request, or null for the full page. */
  readonly fragment: string | null;
  readonly session: Session;
  /** Sets the page's locale and direction (ops.md section 14, "Locale"); `dir` defaults from the language. */
  setLocale(locale: string, dir?: TextDirection): void;
}

/** The template data a loader returns: a plain object (ops.md section 14, "Loader"). */
export type PageData = Record<string, unknown>;

export type Loader = (ctx: LoaderContext) => PageData | Response | Promise<PageData | Response>;

export interface ActionContext extends Omit<Ctx, "db"> {
  /** The action's own IMMEDIATE transaction: committed when the action resolves, rolled back when it throws. */
  readonly db: DbStatements;
  /** The action name from `?/<name>`, or "default". */
  readonly action: string;
  /** The parsed form body (urlencoded or multipart); empty for other content types. CSRF is checked before. */
  readonly form: FormData;
  readonly fragment: string | null;
  readonly session: Session;
  /** As for the loader. */
  setLocale(locale: string, dir?: TextDirection): void;
}

/**
 * A `Response` is sent as is. An object (or nothing) re-runs `load` and is
 * merged over its result as template data; `fragments` names the extra
 * fragments rendered out of band.
 */
export type ActionResult = Response | (PageData & { fragments?: readonly string[] }) | void;

export type Action = (ctx: ActionContext) => ActionResult | Promise<ActionResult>;

/** Shape of a `pages/**\/*.ts` module. */
export interface PageModule {
  load?: Loader;
  actions?: Readonly<Record<string, Action>>;
}

/**
 * Optional sugar: types a page's `load` and `actions` in one place and
 * returns them unchanged.
 *
 * ```ts
 * export const { load, actions } = definePage({ load: async ({ db }) => ({ ... }), actions: { add: async ({ form }) => ... } });
 * ```
 */
export function definePage<const P extends PageModule>(page: P): P {
  return page;
}
