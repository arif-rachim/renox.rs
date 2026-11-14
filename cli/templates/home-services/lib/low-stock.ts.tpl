// What is running out (#816, wave D): the parts under their minimum in a branch. Three readers use it: the number on
// the admin tile (lib/admin-tile.ts, "Parts low on stock"), the daily job (jobs/low-stock.ts) that tells a branch's
// managers and the owner, and the owner connector's tool `list_low_stock` (functions/tools/list_low_stock.ts).
// The rule is `listStock`'s (lib/stock.ts): a part is low in a branch when what the branch has on hand (nothing, for
// a part it never held) is under the part's minimum; a part with no minimum is never low. Reads only: the stock
// tables are written by lib/stock.ts.
import type { Authz, DbStatements } from "@renoxium/sdk";
import { i18n, notifications } from "renox:modules";

import { lookup } from "./invalid";
import { tokenHash } from "./links";
import type { Branch, Scopable } from "./scope";
import { listStock, qtyText, type StockLine } from "./stock";

/** How many parts one notification lists. */
export const NOTICE_PARTS = 10;

/** The branch's parts under their minimum, by SKU. */
export async function lowParts(db: Scopable, branchId: string): Promise<StockLine[]> {
  return listStock(db, branchId, { lowOnly: true });
}

/** How many (branch, part) pairs are under their minimum, over these branches. */
export async function lowCount(db: Scopable, branchIds: readonly string[]): Promise<number> {
  let n = 0;
  for (const id of branchIds) n += (await lowParts(db, id)).length;
  return n;
}

interface RolesCtx {
  readonly db: DbStatements;
  readonly authz: Pick<Authz, "roles">;
}

/** The members of the branch's organisation who hold `owner` or `branch_manager` (global, or for that branch). */
export async function managersOf(ctx: RolesCtx, branch: Pick<Branch, "org_id">): Promise<string[]> {
  const members = await ctx.db.query<{ user_id: string }>("select user_id from org__public_members_v1 where org_id = ? order by user_id", [branch.org_id]);
  const out: string[] = [];
  for (const m of members) {
    const roles = await ctx.authz.roles.list(m.user_id);
    if (roles.some((r) => (r.role === "owner" || r.role === "branch_manager") && (r.scope_type === "global" || r.scope_id === branch.org_id))) out.push(m.user_id);
  }
  return out;
}

/** The settings key that holds the hash of the list a branch was last told. */
export const hashKey = (branchId: string): string => `low_stock_hash_${branchId}`;

/** What identifies a list: every part's SKU, quantity on hand and minimum, in SKU order (the whole list, not only the ten shown). */
async function hashOfList(lines: readonly StockLine[]): Promise<string> {
  return tokenHash(lines.map((l) => `${l.part.sku}:${qtyText(l.qty)}:${qtyText(l.part.min_stock)}`).join("|"));
}

type Lang = "en" | "ar";
const say = (lang: Lang, key: string): string => lookup(lang, key) ?? key;
const fill = (text: string, values: Record<string, string | number>): string => text.replace(/\{(\w+)\}/gu, (all, k: string) => String(values[k] ?? all));

/** The notification a recipient reads: the title with the number of parts and, in the body, up to ten of them (SKU, name, on hand, minimum). */
export function noticeOf(lang: Lang, branch: Pick<Branch, "id" | "name_en" | "name_ar">, lines: readonly StockLine[]): { title: string; body: string; link: string } {
  const name = lang === "ar" ? branch.name_ar : branch.name_en;
  const listed = lines.slice(0, NOTICE_PARTS).map((l) => fill(say(lang, "stock.low_notice.line"), { sku: l.part.sku, name: lang === "ar" ? l.part.name_ar : l.part.name_en, qty: qtyText(l.qty), min: qtyText(l.part.min_stock) }));
  const more = lines.length > NOTICE_PARTS ? [fill(say(lang, "stock.low_notice.more"), { n: lines.length - NOTICE_PARTS })] : [];
  return {
    title: fill(say(lang, "stock.low_notice.title"), { branch: name, n: lines.length }).slice(0, 200),
    body: [...listed, ...more].join("\n").slice(0, 2000),
    link: `/admin/stock?branch=${branch.id}&low=1`,
  };
}

interface JobCtx extends RolesCtx {
  readonly db: Scopable;
}

/**
 * The daily run: for each branch with parts under their minimum, one in-app notification to its managers and the
 * owner, unless the list is the one told last time (its hash is kept in `app__settings`). A branch with nothing low
 * forgets the hash, so a list that comes back is told again. Returns the number of notifications sent.
 */
export async function notifyLowStock(ctx: JobCtx): Promise<number> {
  const branches = await ctx.db.query<Branch>("select id, org_id, name_en, name_ar, slug, emirate, area from app__branches order by created_at, id", []);
  let sent = 0;
  for (const branch of branches) {
    const lines = await lowParts(ctx.db, branch.id);
    const key = hashKey(branch.id);
    if (lines.length === 0) {
      await ctx.db.execute("delete from app__settings where key = ?", [key]);
      continue;
    }
    const hash = await hashOfList(lines);
    const last = await ctx.db.queryOne<{ value: string }>("select value from app__settings where key = ?", [key]);
    if (last?.value === hash) continue;
    for (const user of await managersOf(ctx, branch)) {
      const lang: Lang = (await i18n.detectLocale({ user_id: user, org_locale: null })).locale === "ar" ? "ar" : "en";
      const n = noticeOf(lang, branch, lines);
      await notifications.notify(user, { category: "stock", title: n.title, body: n.body, link: n.link });
      sent += 1;
    }
    await ctx.db.execute("insert or replace into app__settings (key, value) values (?, ?)", [key, hash]);
  }
  return sent;
}
