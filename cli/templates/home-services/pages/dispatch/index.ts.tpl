// GET /dispatch: the board of the active branch (`job.dispatch`). One column
// per status; a card is a job, with its technician and time, ordered by
// technician then time. Unscheduled (`new`) jobs are all shown; scheduled work
// is today's and tomorrow's, plus what is overdue; done is today's. One query
// loads the board (no query per card) and a column renders at most COLUMN_CAP
// cards, with a "Show all <n>" link (?column=<status>&all=1) when it has more (#728).
// The page opens /ws/dispatch/<branch slug>, which pushes each changed card
// (partials/job-card.html) as out-of-band swaps.
import type { LoaderContext } from "@renoxium/sdk";

import { type JobStatus } from "../../lib/jobs";
import { shell } from "../../lib/page";
import { OFFSET_MS, clock } from "../../lib/booking-sync";
import { day } from "../../lib/quotes";
import { branchOf, noBranch, scopedDb } from "../../lib/scope";
import { memberNames } from "../../lib/technicians";

export const guard = { action: "job.dispatch" };

const COLUMNS: readonly JobStatus[] = ["new", "scheduled", "en_route", "in_progress", "done"];

/** A column renders at most this many cards; `?column=<status>&all=1` renders every one (#728). */
export const COLUMN_CAP = 30;

type Row = { id: string; number: string; status: JobStatus; priority: string; scheduled_start: number | null; technician_user_id: string | null; customer: string | null; service: string | null };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const branch = await branchOf(ctx);
  if (branch === null) return noBranch();
  const scoped = scopedDb(ctx.db, branch);
  // Local midnights (UTC+4) as unix seconds.
  const today = Math.floor((Math.floor((Date.now() + OFFSET_MS) / 86_400_000) * 86_400_000 - OFFSET_MS) / 1000);
  // One query for the whole board: the board's jobs with their customer and service names. Unscheduled jobs
  // are all shown, done is today's, other scheduled work is today's and tomorrow's plus what is overdue.
  const rows = await scoped.query<Row>(
    `select j.id as id, j.number as number, j.status as status, j.priority as priority, j.scheduled_start as scheduled_start, j.technician_user_id as technician_user_id, c.name as customer, s.name_en as service
     from app__jobs j left join app__customers c on c.id = j.customer_id left join app__services s on s.id = j.service_id
     where (j.status = 'new' or (j.scheduled_start is not null and ((j.status = 'done' and j.scheduled_start >= ?1 and j.scheduled_start < ?1 + 86400) or (j.status in ('scheduled', 'en_route', 'in_progress') and j.scheduled_start < ?1 + 172800))))
     order by coalesce(j.scheduled_start, j.created_at), j.number`,
    [today],
  );
  const names = await memberNames(ctx.db, branch);
  const cards = rows.map((j) => ({
    at: j.scheduled_start ?? 0,
    card: {
      id: j.id,
      number: j.number,
      status: j.status,
      priority: j.priority,
      customer: j.customer ?? "",
      service: j.service ?? "",
      technician: j.technician_user_id === null ? "" : (names.get(j.technician_user_id) ?? j.technician_user_id),
      start: j.scheduled_start === null ? "" : `${day(j.scheduled_start)} ${clock(j.scheduled_start)}`,
    },
  }));
  cards.sort((a, b) => a.card.technician.localeCompare(b.card.technician) || a.at - b.at || a.card.number.localeCompare(b.card.number));
  const wanted = ctx.url.searchParams.get("column");
  const lang = ctx.url.searchParams.get("lang");
  const keep = lang === "ar" || lang === "en" ? `&lang=${lang}` : "";
  const everything = ctx.url.searchParams.get("all") === "1";
  return {
    ...page,
    socket: `/ws/dispatch/${branch.slug}`,
    columns: COLUMNS.map((s) => {
      const all = cards.filter((c) => c.card.status === s).map((c) => c.card);
      const full = everything && wanted === s;
      return { status: s, jobs: full ? all : all.slice(0, COLUMN_CAP), total: all.length, more: !full && all.length > COLUMN_CAP, all_href: `/dispatch?column=${s}&all=1${keep}` };
    }),
  };
}
