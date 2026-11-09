// /ws/dispatch/<branch slug>: the live dispatch board of one branch.
// The route's guard is `job.dispatch` on the branch named in the URL: the
// cell loads the branch by its slug and the policy (policies/app/base.cedar)
// lets in only a dispatcher, branch manager or owner whose active organisation
// is the branch's. Anyone else, and a branch that does not exist, is refused
// at the upgrade (403), before this code runs.
//
// `open` subscribes the connection to `jobs:<branch id>`, which receives the
// change feed of app__jobs (`[realtime.feeds]`) and the re-rendered cards that
// lib/jobs.ts publishes after each change. The board sends nothing.
import type { RealtimeContext } from "@renoxium/sdk";

import { topicOf } from "../../../lib/jobs";

export const guard = { action: "job.dispatch", resource: { type: "Branch", id: ":branch" } };

export const ws = {
  async open(ctx: RealtimeContext) {
    const branch = await ctx.db.queryOne<{ id: string }>("select id from app__branches where slug = ?", [String(ctx.params.branch)]);
    if (branch === null) throw new Error("no such branch");
    await ctx.realtime.subscribe(ctx.conn, topicOf(branch.id));
  },
};
