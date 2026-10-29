// #237 on the worker: Kysely and Drizzle over ctx.db, the same queries on
// the app's own table and on a table outside its prefix (renox__migrations,
// the platform's), whose refusal must equal the raw path's.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { type Ctx, isRenoxError } from "renox";
import { drizzle } from "renox/drizzle";
import { kysely } from "renox/kysely";

interface Tables {
  app__items: { id: number; name: string; qty: number };
  renox__migrations: { module: string; name: string };
}

const items = sqliteTable("app__items", { id: integer("id").primaryKey(), name: text("name").notNull(), qty: integer("qty").notNull() });
const migrations = sqliteTable("renox__migrations", { module: text("module"), name: text("name") });

// Drizzle wraps a failed statement in its DrizzleQueryError; the platform's error is its cause.
const unwrap = (e: unknown): unknown => (e instanceof Error && isRenoxError(e.cause) ? e.cause : e);
const error = (e: unknown) => {
  const u = unwrap(e);
  return isRenoxError(u) ? { code: u.code, details: u.details ?? null } : { message: String(u) };
};

async function attempt<T>(f: () => Promise<T>): Promise<unknown> {
  try {
    return { ok: await f() };
  } catch (e) {
    return { error: error(e) };
  }
}

export async function GET(ctx: Ctx): Promise<Response> {
  const k = kysely<Tables>(ctx);
  const d = drizzle(ctx);
  const which = ctx.url.searchParams.get("case");
  switch (which) {
    case "own": {
      await k.insertInto("app__items").values({ id: 1, name: "dates", qty: 3 }).execute();
      await d.insert(items).values({ id: 2, name: "saffron", qty: 5 });
      const viaKysely = await k.selectFrom("app__items").select(["id", "name"]).where("qty", ">", 2).where("name", "!=", "x").orderBy("id").execute();
      const viaDrizzle = await d.select().from(items).where(eq(items.name, "saffron"));
      return Response.json({ viaKysely, viaDrizzle });
    }
    case "foreign":
      return Response.json({
        raw: await attempt(() => ctx.db.query("select * from renox__migrations")),
        kysely: await attempt(() => k.selectFrom("renox__migrations").selectAll().execute()),
        drizzle: await attempt(() => d.select().from(migrations)),
      });
    case "rollback": {
      const r = await attempt(() =>
        k.transaction().execute(async (tx) => {
          await tx.insertInto("app__items").values({ id: 10, name: "rolled back", qty: 1 }).execute();
          throw new Error("boom");
        }),
      );
      const d2 = await attempt(() =>
        ctx.db.transaction(async (tx) => {
          await drizzle({ db: tx }).insert(items).values({ id: 11, name: "rolled back too", qty: 1 });
          throw new Error("boom");
        }),
      );
      await k.transaction().execute(async (tx) => {
        await tx.insertInto("app__items").values({ id: 12, name: "kept", qty: 1 }).execute();
      });
      const left = await k.selectFrom("app__items").select("id").where("id", ">=", 10).execute();
      return Response.json({ r, d2, left });
    }
    default:
      return new Response("unknown case", { status: 400 });
  }
}
