import type { Handler } from "renox";
import { greet } from "../../lib/greet.ts";

interface Item { id: number; name: string }

export const GET: Handler = async ({ db }) => {
  const rows = await db.query<Item & Record<string, number | string>>("select id, name from app__items where name like ? limit ?", ["%a%", 10]);
  return Response.json({ greeting: greet("world"), rows });
};

export const POST: Handler = async ({ db, req }) => {
  const { name } = (await req.json()) as { name: string };
  await db.execute("insert into app__items (name) values (?)", [name]);
  const ok = await fetch("https://api.example.com/ping");
  return Response.json({ ok: ok.ok }, { status: 201 });
};
