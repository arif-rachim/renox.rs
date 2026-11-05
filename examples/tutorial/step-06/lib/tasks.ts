// The board's tasks: the queries the page runs, always with parameters
// (`?`), never with a value pasted into the SQL. Every query names the
// team: a task of another team is never read or changed.
import type { DbStatements } from "@renoxium/sdk";

export type Task = {
  id: number;
  title: string;
  done: number;
  team_id: string;
};

export const MAX_TITLE = 200;

/** The team's tasks, open ones first. */
export function listTasks(db: DbStatements, team: string): Promise<Task[]> {
  return db.query<Task>("select id, title, done, team_id from app__tasks where team_id = ? order by done, id desc limit 200", [team]);
}

/** One task of the team, or null. */
export function findTask(db: DbStatements, team: string, id: unknown): Promise<Task | null> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) return Promise.resolve(null);
  return db.queryOne<Task>("select id, title, done, team_id from app__tasks where id = ? and team_id = ?", [n, team]);
}

/** A title as typed, or the i18n key of the reason it cannot be one. */
export function parseTitle(raw: FormDataEntryValue | null): { title: string } | { error: string } {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (title === "") return { error: "board.error.empty" };
  if (title.length > MAX_TITLE) return { error: "board.error.long" };
  return { title };
}
