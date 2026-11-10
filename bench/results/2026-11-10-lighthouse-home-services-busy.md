# Lighthouse of the home-services dispatch board and technician visit page on a busy day: 2026-11-10 (#728)

`make lighthouse` now runs with `--busy` (`bench/lighthouse/busy-day.sql`, applied after `seeds/001_demo.sql`): 200 jobs of the Dubai branch for today (80 new, 60 scheduled, 12 en route, 18 in progress, 30 done) spread over six technicians, and a checked-in visit with 12 photos (6 before, 6 after) on the technician's first scheduled job (`jb_seed_05`). The photos use the demo seed's placeholder (a file key with no stored object, width and height null), so the page renders them as "not stored" and the visit page weighs about 10 KiB more than with the demo seed.

Setup of both runs: renox-worker 0.7.1; Lighthouse mobile emulation and throttling (the default phone profile); the app under `renox dev`; 3 runs per target, median per column. Thresholds: accessibility >= 90, performance >= 80, CLS <= 0.1. Raw reports are not committed (as in #727).

## Before: the busy seed on `a7d2adf` (no change of #728 applied)

| Target | Role | Accessibility | Performance | LCP ms | TBT ms | CLS | Total bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| `/dispatch` | dispatcher | 100 | 99 | 1809 | 0 | 0 | 134.8 KiB |
| `/dispatch?lang=ar` | dispatcher | 100 | 99 | 1814 | 0 | 0 | 135.9 KiB |
| `/me/visits/jb_seed_05` | technician | 100 | 100 | 1522 | 4 | 0 | 84.8 KiB |
| `/me/visits/jb_seed_05?lang=ar` | technician | 100 | 99 | 1654 | 0 | 0 | 85.5 KiB |

Every run (accessibility / performance):

- `/dispatch`: 100/99, 100/99, 100/99
- `/dispatch?lang=ar`: 100/99, 100/98, 100/99
- `/me/visits/jb_seed_05`: 100/100, 100/100, 100/99
- `/me/visits/jb_seed_05?lang=ar`: 100/99, 100/99, 100/99

## After: the busy seed with tasks 3 to 7 applied

Commit `a7d2adf` plus the working tree of this change.

| Target | Role | Accessibility | Performance | LCP ms | TBT ms | CLS | Total bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| `/dispatch` | dispatcher | 100 | 99 | 1654 | 16 | 0 | 111.3 KiB |
| `/dispatch?lang=ar` | dispatcher | 100 | 99 | 1655 | 0 | 0 | 112.1 KiB |
| `/me/visits/jb_seed_05` | technician | 100 | 100 | 1502 | 0 | 0 | 85.8 KiB |
| `/me/visits/jb_seed_05?lang=ar` | technician | 100 | 100 | 1503 | 19 | 0 | 86.6 KiB |

Every run (accessibility / performance):

- `/dispatch`: 100/99, 100/99, 100/99
- `/dispatch?lang=ar`: 100/99, 100/99, 100/100
- `/me/visits/jb_seed_05`: 100/100, 100/100, 100/100
- `/me/visits/jb_seed_05?lang=ar`: 100/100, 100/100, 100/100

## Reading the tables

- The thresholds were already met with the busy seed before the change: the scores are within noise of each other (a point or two), and this run, on a local dev server, cannot show a gain in the score. What moved is the weight and the server work: the board is 24 KiB lighter (111 KiB against 135 KiB; the 30-card cap leaves 140 of the 200 cards behind the "Show all" links), LCP of the board is 150 ms lower, and the board's loader now runs one query for the jobs of the board plus one for the names of the branch's members, instead of three queries per card (about 600 for 200 jobs).
- CLS is 0 on all four targets in both runs. The header logo has `width="32" height="32"` and a fixed box in `app.css`.
- Accessibility stays at 100 on all four targets (same run).
- `/theme` is answered with `Cache-Control: private, max-age=300` and an ETag, and 304 to a matching `If-None-Match`; Lighthouse's first load does not see the saving (cold cache), a repeat view does.
