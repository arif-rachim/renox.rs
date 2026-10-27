// GET /api/notes/:id, DELETE /api/notes/:id
export const GET = async ({ db, params }) => {
  const note = await db.queryOne("select id, body from app__notes where id = ?", [params.id]);
  return note ? Response.json(note) : new Response(null, { status: 404 });
};
export const DELETE = async ({ db, params }) => {
  await db.execute("delete from app__notes where id = ?", [params.id]);
  return new Response(null, { status: 204 });
};
