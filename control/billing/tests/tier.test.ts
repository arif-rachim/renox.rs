// #325: the tier state machine (the contract's `tier` table) and the anomaly rule.
import { expect, test } from "bun:test";

import { anomalous, GRACE_MS, nextState, reinstate, TRANSITIONS } from "../src/index.ts";
import spec from "../../../docs/contracts/schemas/deploy-api.yaml";

const H = 3_600_000;
const base = { since: 0, paid: false, unpaidSince: null as number | null, overQuota: false };

test("the transitions are deploy-api.yaml's tier machine", () => {
  const machine = (spec as any)["x-renox-state-machines"].tier.transitions;
  for (const [s, to] of Object.entries(TRANSITIONS)) expect([...to].sort() as string[]).toEqual([...(machine[s] as string[])].sort());
});

test("free over quota: over_quota, grace after 24 h, suspended after 7 days; back on upgrade", () => {
  expect(nextState({ ...base, state: "active", now: 0, overQuota: true })).toBe("over_quota");
  expect(nextState({ ...base, state: "over_quota", now: 23 * H, overQuota: true })).toBe("over_quota");
  expect(nextState({ ...base, state: "over_quota", now: 24 * H, overQuota: true })).toBe("grace");
  expect(nextState({ ...base, state: "grace", now: GRACE_MS - 1, overQuota: true })).toBe("grace");
  expect(nextState({ ...base, state: "grace", now: GRACE_MS, overQuota: true })).toBe("suspended");
  expect(nextState({ ...base, state: "grace", now: H, overQuota: false })).toBe("active");
  expect(nextState({ ...base, state: "suspended", now: GRACE_MS * 2 })).toBe("suspended");
  expect(reinstate("suspended")).toBe("active");
});

test("paid plans are billed for overage; an invoice unpaid 14 days suspends; a dispute at once", () => {
  expect(nextState({ ...base, state: "active", now: 0, overQuota: true, paid: true })).toBe("active");
  expect(nextState({ ...base, state: "active", now: 14 * 24 * H, paid: true, unpaidSince: 0 })).toBe("suspended");
  expect(nextState({ ...base, state: "active", now: 0, paid: true, forceSuspend: true })).toBe("suspended");
});

test("the anomaly rule flags a spike against the tenant's own baseline", () => {
  const week = Array.from({ length: 168 }, () => 1000);
  expect(anomalous(week, 9_000)).toBe(false);
  expect(anomalous(week, 50_000)).toBe(true);
  expect(anomalous([], 500)).toBe(false);
});
