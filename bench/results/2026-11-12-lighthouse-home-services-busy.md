# Lighthouse of the home-services dispatch board and technician visit page: 2026-11-12

Commit a211521; renox-worker 0.8.0; Lighthouse mobile emulation and throttling (the default phone profile); the app under `renox dev` with `seeds/001_demo.sql` and `busy-day.sql`; 3 runs per target, median per column. Thresholds: accessibility >= 90, performance >= 80.

| Target | Role | Accessibility | Performance | LCP ms | TBT ms | CLS | Total bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| `/dispatch` | dispatcher | 100 | 98 | 1953 | 0 | 0 | 163.6 KiB |
| `/dispatch?lang=ar` | dispatcher | 100 | 97 | 2255 | 0 | 0 | 214.5 KiB |
| `/me/visits/jb_seed_05` | technician | 100 | 99 | 1805 | 0 | 0 | 138.1 KiB |
| `/me/visits/jb_seed_05?lang=ar` | technician | 100 | 98 | 2108 | 0 | 0 | 188.9 KiB |

Every run (accessibility / performance):

- `/dispatch`: 100/98, 100/98, 100/98
- `/dispatch?lang=ar`: 100/97, 100/98, 100/97
- `/me/visits/jb_seed_05`: 100/99, 100/99, 100/99
- `/me/visits/jb_seed_05?lang=ar`: 100/99, 100/98, 100/98
