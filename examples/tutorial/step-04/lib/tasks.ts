// The board's tasks: the queries the page runs, always with parameters
// (`?`), never with a value pasted into the SQL.
import type { DbStatements } from "@renoxium/sdk";

export type Task = {
  id: number;
  title: string;
  done: number;
};

/** The tasks, open ones first. */
export function listTasks(db: DbStatements): Promise<Task[]> {
  return db.query<Task>("select id, title, done from app__tasks order by done, id desc limit ?", [200]);
}
