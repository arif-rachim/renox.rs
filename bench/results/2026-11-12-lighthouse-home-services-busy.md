# Lighthouse of the home-services dispatch board and technician visit page: 2026-11-12

Commit 5c2a30e; renox-worker 0.8.0; Lighthouse mobile emulation and throttling (the default phone profile); the app under `renox dev` with `seeds/001_demo.sql` and `busy-day.sql`; 3 runs per target, median per column. Thresholds: accessibility >= 90, performance >= 80.

| Target | Role | Accessibility | Performance | LCP ms | TBT ms | CLS | Total bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| `/dispatch` | dispatcher | 100 | 98 | 1954 | 0 | 0 | 164.5 KiB |
| `/dispatch?lang=ar` | dispatcher | 100 | 97 | 2276 | 0 | 0 | 216.4 KiB |
| `/me/visits/jb_seed_05` | technician | 100 | 99 | 1809 | 0 | 0 | 140.2 KiB |
| `/me/visits/jb_seed_05?lang=ar` | technician | 100 | 98 | 2110 | 0 | 0 | 191.2 KiB |

Every run (accessibility / performance):

- `/dispatch`: 100/98, 100/98, 100/98
- `/dispatch?lang=ar`: 100/97, 100/99, 100/97
- `/me/visits/jb_seed_05`: 100/99, 100/99, 100/99
- `/me/visits/jb_seed_05?lang=ar`: 100/98, 100/98, 100/99
