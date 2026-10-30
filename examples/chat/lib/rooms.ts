// A room as the policy sees it (#282): the row from the database, with
// `member` computed for the signed-in user.

export interface Room {
  id: string;
  name: string;
  private: number;
  member: string;
}

interface Db {
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

const ROOM = /^[a-z0-9-]{1,40}$/u;

export async function room(db: Db, id: unknown, userId: string | null): Promise<Room | null> {
  if (typeof id !== "string" || !ROOM.test(id)) return null;
  return db.queryOne<Room>(
    "select r.id, r.name, r.private, case when exists (select 1 from app__members m where m.room_id = r.id and m.user_id = ?) then 'yes' else 'no' end as member from app__rooms r where r.id = ?",
    [userId ?? "", id],
  );
}

/** The Cedar resource of a room: `type`, `id` and the declared attributes. */
export const asResource = (r: Room) => ({ type: "Room", id: r.id, private: r.private, member: r.member });

export const topic = (id: string): string => `room:${id}`;
