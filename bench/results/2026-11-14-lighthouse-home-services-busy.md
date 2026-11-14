# Lighthouse of the home-services dispatch board, technician visit page and booking page: 2026-11-14

Commit 3550abc; renox-worker 0.10.0; Lighthouse mobile emulation and throttling (the default phone profile); the app under `renox dev` with `seeds/001_demo.sql` and `busy-day.sql`; 3 runs per target, median per column. Thresholds: accessibility >= 90, performance >= 80.

| Target | Role | Accessibility | Performance | LCP ms | TBT ms | CLS | Total bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| `/dispatch` | dispatcher | 100 | 98 | 1957 | 0 | 0 | 171.3 KiB |
| `/dispatch?lang=ar` | dispatcher | 100 | 97 | 2257 | 0 | 0 | 222.3 KiB |
| `/me/visits/jb_seed_05` | technician | 100 | 97 | 2406 | 0 | 0 | 230.8 KiB |
| `/me/visits/jb_seed_05?lang=ar` | technician | 100 | 95 | 2710 | 0 | 0 | 282.7 KiB |
| `/me` | technician | 100 | 95 | 2569 | 0 | 0 | 275.1 KiB |
| `/me?lang=ar` | technician | 100 | 95 | 2556 | 0 | 0 | 275.2 KiB |
| `/book` | visitor | 100 | 99 | 1958 | 0 | 0 | 174.4 KiB |
| `/book?lang=ar` | visitor | 100 | 99 | 1958 | 0 | 0 | 174.3 KiB |

Every run (accessibility / performance):

- `/dispatch`: 100/98, 100/98, 100/98
- `/dispatch?lang=ar`: 100/97, 100/97, 100/97
- `/me/visits/jb_seed_05`: 100/97, 100/97, 100/97
- `/me/visits/jb_seed_05?lang=ar`: 100/95, 100/95, 100/95
- `/me`: 100/95, 100/96, 100/95
- `/me?lang=ar`: 100/95, 100/96, 100/95
- `/book`: 100/99, 100/99, 100/99
- `/book?lang=ar`: 100/99, 100/99, 100/99
