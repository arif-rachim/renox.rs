// GET /api/notes, POST /api/notes
export const GET = async ({ db }) => Response.json(await db.query("select id, body from app__notes order by id desc limit 50"));
export const POST = async ({ req, db }) => {
  const { body } = await req.json();
  const info = await db.execute("insert into app__notes (body) values (?)", [String(body)]);
  return Response.json({ id: info.lastInsertRowid }, { status: 201 });
};
