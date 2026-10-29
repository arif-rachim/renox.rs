export async function currentUser(ctx) { return null; }
export async function requireUser(ctx) { return new Response(null, { status: 303, headers: { location: "/auth/login" } }); }
export async function getUser(ctx, id) { return ctx.db.queryOne("select id, email from auth__users where id = ?", [id]); }
export async function signOut(ctx) {}
