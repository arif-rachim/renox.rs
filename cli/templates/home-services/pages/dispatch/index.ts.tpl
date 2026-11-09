// GET /dispatch: the board of the active branch (`job.dispatch`). One column
// per status; a card is a job, with its technician and time, ordered by
// technician then time. Unscheduled (`new`) jobs are all shown; scheduled work
// is today's and tomorrow's, plus what is overdue; done is today's.
// The page opens /ws/dispatch/<branch slug>, which pushes each changed card
// (partials/job-card.html) as out-of-band swaps.
import type { LoaderContext } from "@renoxium/sdk";

import { cardOf, listJobs, type JobRow, type JobStatus } from "../../lib/jobs";
import { shell } from "../../lib/page";
import { OFFSET_MS } from "../../lib/booking-sync";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";

export const guard = { action: "job.dispatch" };

const COLUMNS: readonly JobStatus[] = ["new", "scheduled", "en_route", "in_progress", "done"];

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const scoped = scopedDb(ctx.db, branch);
  const all = await listJobs(scoped, { status: "", technician: "", day: "" }, null);
  // Local midnights (UTC+4) as unix seconds.
  const today = Math.floor((Math.floor((Date.now() + OFFSET_MS) / 86_400_000) * 86_400_000 - OFFSET_MS) / 1000);
  const shown = (j: JobRow): boolean => {
    if (j.status === "new") return true;
    if (j.scheduled_start === null) return false;
    return j.status === "done" ? j.scheduled_start >= today && j.scheduled_start < today + 86_400 : j.scheduled_start < today + 2 * 86_400;
  };
  const cards = await Promise.all(all.filter((j) => COLUMNS.includes(j.status) && shown(j)).map(async (j) => ({ at: j.scheduled_start ?? 0, card: await cardOf(ctx, branch, scoped, j) })));
  cards.sort((a, b) => a.card.technician.localeCompare(b.card.technician) || a.at - b.at || a.card.number.localeCompare(b.card.number));
  return {
    ...page,
    socket: `/ws/dispatch/${branch.slug}`,
    columns: COLUMNS.map((s) => ({ status: s, jobs: cards.filter((c) => c.card.status === s).map((c) => c.card) })),
  };
}
