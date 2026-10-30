// The tier state machine (#325; deploy-api.md 0.5 section 20,
// `x-renox-state-machines.tier`) and the anomaly rule.
//
// | State | Next |
// | --- | --- |
// | active | over_quota, suspended |
// | over_quota | active, grace (still over after 24 h) |
// | grace | active, suspended (7 days, or an invoice unpaid 14 days) |
// | suspended | active |

export type TierState = "active" | "over_quota" | "grace" | "suspended";

export const TRANSITIONS: Record<TierState, TierState[]> = {
  active: ["over_quota", "suspended"],
  over_quota: ["active", "grace"],
  grace: ["active", "suspended"],
  suspended: ["active"],
};

export const DAY_MS = 86_400_000;
export const OVER_QUOTA_TO_GRACE_MS = DAY_MS;
export const GRACE_MS = 7 * DAY_MS;
export const UNPAID_SUSPEND_MS = 14 * DAY_MS;

export interface TierInput {
  state: TierState;
  since: number;
  now: number;
  /** A free plan over a quota this period. */
  overQuota: boolean;
  /** A paid plan: overage is billed, never over_quota. */
  paid: boolean;
  /** The oldest unpaid invoice's issue time, or null. */
  unpaidSince: number | null;
  /** A dispute, chargeback or operator action. */
  forceSuspend?: boolean;
}

/** The next state, or the same state when nothing changes. */
export function nextState(i: TierInput): TierState {
  if (i.forceSuspend) return "suspended";
  const unpaid = i.unpaidSince !== null && i.now - i.unpaidSince >= UNPAID_SUSPEND_MS;
  switch (i.state) {
    case "active":
      return !i.paid && i.overQuota ? "over_quota" : unpaid ? "suspended" : "active";
    case "over_quota":
      if (!i.overQuota || i.paid) return "active";
      return i.now - i.since >= OVER_QUOTA_TO_GRACE_MS ? "grace" : "over_quota";
    case "grace":
      if ((!i.overQuota || i.paid) && !unpaid) return "active";
      return i.now - i.since >= GRACE_MS || unpaid ? "suspended" : "grace";
    case "suspended":
      // Only a payment, an upgrade or an operator ends it (`reinstate`).
      return "suspended";
  }
}

/** Reinstatement: a payment or an upgrade ends a suspension. */
export const reinstate = (state: TierState): TierState => (state === "suspended" || state === "grace" || state === "over_quota" ? "active" : state);

/**
 * The anomaly rule: an hour more than `factor` times the tenant's own
 * 7-day hourly median (at least `floor`) on one dimension.
 */
export function anomalous(hours: readonly number[], latest: number, factor = 10, floor = 100): boolean {
  if (hours.length === 0) return latest >= floor * factor;
  const sorted = [...hours].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  return latest > Math.max(median, floor) * factor;
}
