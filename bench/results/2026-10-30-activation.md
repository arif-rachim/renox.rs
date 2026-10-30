# Activation path — 2026-10-30

The scripted run of #326's acceptance criterion: sign-up to the first deploy with the `shop` template, under 10 minutes on the dev container (`docs/19-platform-wireframes.md` section 1, "Activation metric").

**Hardware.** This machine (Intel Core i7-6700 @ 3.40 GHz, 8 threads), git `cb85f12` plus the `www/` commit of batch F67-B, Bun 1.4.4. The shop template was built with a release `renox-worker` (template compilation).

**Method.** One script (kept with the session) runs every machine step of the path in order and times each one:
1. The control API in process (PGlite) with one registered node.
2. `examples/shop` built into `CONTROL_TEMPLATES_DIR`, as `bun control/api/src/signup/templates.ts <out>` does.
3. `signup` with `dpa_accepted`.
4. `verifyEmail` with the emailed token: the link of the email, which signs the user in.
5. A token, as `renox login` creates one.
6. `createAppFromTemplate` with `{ name: "my-shop", template: "shop" }`.
7. `getTenant`, which must show `first_deploy_at`.

## Result

| Step | Wall time |
| --- | --- |
| Control API ready (PGlite, one node) | 2,015 ms |
| `shop` template built from `examples/` | 168 ms |
| Sign-up (202 `check_email`) | 61 ms |
| Verification link opened (session) | 11 ms |
| Token created (`renox login`) | 2 ms |
| `createAppFromTemplate`: app created, artifact uploaded, validated and activated | 93 ms |
| `getTenant`: `first_deploy_at` set | 5 ms |
| **Total** | **2,354 ms** |

The app answered `https://my-shop.renox.app` with hash `6377dda1…`, and `first_deploy_at` was set.

**Verdict: met.** The machine part of sign-up to first deploy takes about 2.4 s. The rest of the 10 minutes belongs to the person: reading the email, opening the link, and choosing a name and template. Those are a few clicks with the dashboard pages of #326 (`/signup`, `/signup/verify`, `/apps/new`).

## What this run does not cover

- **The node.** The node is the harness's registered node, so the activation's prepare step is the harness's, not a real worker loading the artifact. A real worker's load and probe are measured by B15 (`renox deploy` to live), which targets 30 s or less.
- **Email delivery.** The time to deliver the email is the provider's and is not included.
- **The production funnel.** `control/api/src/signup/funnel.ts` reports sign-ups, verified owners, apps, deploys and deploys within 10 minutes, with the median, from the control plane's own records. That report, not this run, is where the production number comes from.
