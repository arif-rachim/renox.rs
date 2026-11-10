# Lighthouse of the home-services dispatch board and technician visit page: 2026-11-10

Commit fa442fc; renox-worker 0.7.1; Lighthouse mobile emulation and throttling (the default phone profile); the app under `renox dev` with `seeds/001_demo.sql` and `busy-day.sql`; 3 runs per target, median per column. Thresholds: accessibility >= 90, performance >= 80.

| Target | Role | Accessibility | Performance | LCP ms | TBT ms | CLS | Total bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| `/dispatch` | dispatcher | 100 | 98 | 1956 | 0 | 0 | 163.4 KiB |
| `/dispatch?lang=ar` | dispatcher | 100 | 97 | 2263 | 0 | 0 | 214.3 KiB |
| `/me/visits/jb_seed_05` | technician | 100 | 99 | 1806 | 0 | 0 | 137.9 KiB |
| `/me/visits/jb_seed_05?lang=ar` | technician | 100 | 98 | 2104 | 0 | 0 | 188.7 KiB |

Every run (accessibility / performance):

- `/dispatch`: 100/98, 100/98, 100/98
- `/dispatch?lang=ar`: 100/97, 100/98, 100/97
- `/me/visits/jb_seed_05`: 100/99, 100/99, 100/99
- `/me/visits/jb_seed_05?lang=ar`: 100/98, 100/98, 100/98
