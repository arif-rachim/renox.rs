// GET /sse/board: the live feed of the active team. `[realtime.feeds]` in
// renox.toml sends every committed change of app__tasks to `board:<team>`;
// this route only subscribes the connection to its own team's topic.
interface SseCtx {
  conn: { id: string };
  principal: { attrs: { org?: unknown } } | null;
  realtime: { subscribe(conn: { id: string }, topic: string): Promise<void> };
}

export const guard = { action: "board.view" };

export const sse = {
  async open({ conn, principal, realtime }: SseCtx) {
    const team = principal?.attrs.org;
    if (typeof team !== "string") throw new Error("no active team");
    await realtime.subscribe(conn, `board:${team}`);
  },
};
