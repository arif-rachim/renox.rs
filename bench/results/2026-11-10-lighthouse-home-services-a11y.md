# Lighthouse of the home-services dispatch board and technician visit page, after the accessibility pass (#727): 2026-11-10

Commit 2e13905; renox-worker 0.7.1; Lighthouse mobile emulation and throttling (the default phone profile); the app under `renox dev` with `seeds/001_demo.sql`; 3 runs per target, median per column. Thresholds: accessibility >= 90, performance >= 80.

| Target | Role | Accessibility | Performance | LCP ms | TBT ms | CLS | Total bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| `/dispatch` | dispatcher | 100 | 100 | 1506 | 5 | 0 | 76.7 KiB |
| `/dispatch?lang=ar` | dispatcher | 100 | 100 | 1508 | 87 | 0 | 76.9 KiB |
| `/me/visits/jb_seed_05` | technician | 100 | 100 | 1504 | 0 | 0 | 78.0 KiB |
| `/me/visits/jb_seed_05?lang=ar` | technician | 100 | 100 | 1504 | 43 | 0 | 78.1 KiB |

Every run (accessibility / performance):

- `/dispatch`: 100/100, 100/100, 100/100
- `/dispatch?lang=ar`: 100/97, 100/100, 100/100
- `/me/visits/jb_seed_05`: 100/100, 100/100, 100/100
- `/me/visits/jb_seed_05?lang=ar`: 100/100, 100/100, 100/100
