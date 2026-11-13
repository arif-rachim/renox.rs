# Lighthouse of the home-services dispatch board, technician visit page and booking page: 2026-11-13

Commit 3b46ef3; renox-worker 0.9.0; Lighthouse mobile emulation and throttling (the default phone profile); the app under `renox dev` with `seeds/001_demo.sql` and `busy-day.sql`; 3 runs per target, median per column. Thresholds: accessibility >= 90, performance >= 80.

| Target | Role | Accessibility | Performance | LCP ms | TBT ms | CLS | Total bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| `/dispatch` | dispatcher | 100 | 98 | 1958 | 0 | 0 | 163.7 KiB |
| `/dispatch?lang=ar` | dispatcher | 100 | 97 | 2255 | 0 | 0 | 214.8 KiB |
| `/me/visits/jb_seed_05` | technician | 100 | 99 | 1804 | 0 | 0 | 137.9 KiB |
| `/me/visits/jb_seed_05?lang=ar` | technician | 100 | 98 | 2105 | 0 | 0 | 188.8 KiB |
| `/book` | visitor | 100 | 99 | 1808 | 0 | 0 | 122.7 KiB |
| `/book?lang=ar` | visitor | 100 | 99 | 1960 | 0 | 0 | 173.3 KiB |

Every run (accessibility / performance):

- `/dispatch`: 100/98, 100/98, 100/98
- `/dispatch?lang=ar`: 100/97, 100/97, 100/97
- `/me/visits/jb_seed_05`: 100/99, 100/99, 100/99
- `/me/visits/jb_seed_05?lang=ar`: 100/98, 100/98, 100/98
- `/book`: 100/99, 100/99, 100/99
- `/book?lang=ar`: 100/99, 100/99, 100/99
