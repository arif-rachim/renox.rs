// The board's tasks. For now a fixed list; chapter 4 moves them into SQLite.

export type Task = {
  id: number;
  title: string;
  done: number;
};

const SAMPLE: Task[] = [
  { id: 3, title: "Invite the team", done: 0 },
  { id: 2, title: "Write the first page", done: 0 },
  { id: 1, title: "Install the renox CLI", done: 1 },
];

/** The tasks, open ones first. */
export function listTasks(): Task[] {
  return [...SAMPLE].sort((a, b) => a.done - b.done || b.id - a.id);
}
