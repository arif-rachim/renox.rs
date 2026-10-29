// unvalidated-body fixture (#275): every line marked FLAG is a warning.
import type { Ctx } from "renox";

export async function POST({ req, db }: Ctx): Promise<Response> {
  const body = await req.json(); // FLAG
  await db.execute("insert into notes (text) values (?)", [body.text]);
  return new Response(null, { status: 201 });
}

export async function PUT(ctx: Ctx): Promise<Response> {
  const { name, email } = await ctx.req.json(); // FLAG
  return Response.json({ name, email });
}

export async function PATCH({ request }: { request: Request }): Promise<Response> {
  const form = await request.formData(); // FLAG
  return Response.json({ title: String(form.get("title")) });
}

export async function DELETE({ req }: Ctx): Promise<Response> {
  return Response.json(await req.json()); // FLAG
}
