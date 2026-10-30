// GET /: the rooms the signed-in user may join (#282): public rooms and the
// private rooms they are a member of. Signed out: the login link.
import { auth } from "renox:modules";

interface Ctx {
  db: { query<T>(sql: string, params?: unknown[]): Promise<T[]> };
}

export async function load(ctx: Ctx) {
  const user = (await auth.currentUser()) as { id: string; display_name: string } | null;
  const rooms = user === null ? [] : await ctx.db.query<{ id: string; name: string; private: number }>(
    "select r.id, r.name, r.private from app__rooms r where r.private = 0 or exists (select 1 from app__members m where m.room_id = r.id and m.user_id = ?) order by r.name",
    [user.id],
  );
  return { auth_user: user, rooms, login: (await auth.loginUrl("/")) as string };
}
