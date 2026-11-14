# Seeds

The `.sql` files here are for `renox test --seed seeds/001_demo.sql` and for the demo under `renox dev`. They are never applied to a deployed tenant. Each file is idempotent.

## `001_demo.sql`

The demo company "FixIt Services": two branches (Dubai and Sharjah), their staff (everyone signs in with `correct horse battery`), customers, sites, quotations, jobs, visits, invoices, contracts, and the inventory of waves D (#812 to #816):

- **12 parts** with Arabic names (`pt_00000000000d0001` to `pt_00000000000d000c`): AC filters (`FIL-AC-S`, `FIL-AC-C`), capacitors, refrigerant, PVC fittings, silicone sealant, a kitchen mixer tap and a descaling kit; **2 suppliers**.
- **Opening stock in both branches** (a move `in`, reference `manual`, "opening balance", 40 days before the day the seed is loaded), one **received** purchase order into Sharjah (`PO-DEMO01`) and one **sent** purchase order of Dubai (`PO-DEMO02`, for the parts Dubai is low on), and two visit part lines linked to a stocked part with their `out` moves (the mixer tap of J-000013 in Dubai, the descaling kit of J-000019 in Sharjah). Dubai is under its minimum on three parts (`FIL-AC-C`, `PVC-TEE-25`, `REF-R22`), Sharjah on two (`FIL-AC-S`, `DESCALE-KIT`), so the admin tile says 5.
- The inventory rows are SQL, written the way `lib/stock.ts` would have left them: each move's `balance_after` is the running balance, `app__stock.qty` is the last one and `avg_cost_fils` follows the average-cost rule (`tests/stock-report.test.ts` checks this on the seeded data, and the stock report's totals are asserted against it). The two orders carry the numbers `PO-DEMO01` and `PO-DEMO02`, outside the `PO-000001` sequence, so the first order made on a demo tenant is `PO-000001`.
- Ids of the inventory rows have the shape the pages accept (`pt_` and 16 hex digits), so every row can be opened by its link.
