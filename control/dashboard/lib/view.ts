// Formatting for the templates. The expression language has no function
// calls (docs/08-template-engine.md), so loaders hand the templates finished
// strings and numbers.

import type { Deployment, DeploymentState, UsageHour } from "./api.ts";

export const shortHash = (hash: string | null): string => (hash === null ? "—" : hash.slice(0, 7));

/** "12s ago", "3m ago", "5h ago", "2d ago". */
export function ago(ts: number | null, now: number): string {
  if (ts === null) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** "2026-10-29 12:01:33.120" in UTC. */
export const clock = (ts: number): string => new Date(ts).toISOString().replace("T", " ").replace("Z", "");

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const STATE_LABEL: Record<DeploymentState, string> = {
  uploaded: "uploaded",
  validated: "validated",
  rejected: "✗ rejected",
  activating: "activating…",
  active: "● live",
  superseded: "superseded",
  suspended: "suspended",
  pruned: "pruned",
};

/** One row of a deployment table, with the actions its state allows. */
export interface DeploymentRow {
  hash: string;
  short: string;
  state: DeploymentState;
  label: string;
  when: string;
  size: string;
  /** `validated` or `superseded`: can be made live (activate / promote). */
  can_activate: boolean;
  /** The live deployment, when an earlier one exists to go back to. */
  can_rollback: boolean;
  error: string | null;
}

export function deploymentRows(list: Deployment[], now: number): DeploymentRow[] {
  const hasEarlier = list.some((d) => d.state === "superseded");
  return list.map((d) => ({
    hash: d.hash,
    short: shortHash(d.hash),
    state: d.state,
    label: STATE_LABEL[d.state] ?? d.state,
    when: ago(d.created_at, now),
    size: bytes(d.size_bytes),
    can_activate: d.state === "validated" || d.state === "superseded",
    can_rollback: d.state === "active" && hasEarlier,
    error:
      d.state === "rejected"
        ? `${d.violations?.length ?? 0} violation(s)`
        : d.last_error === null
          ? null
          : `${d.last_error.stage}: ${d.last_error.reason}`.slice(0, 200),
  }));
}

/** One bar of the hourly chart: SVG geometry computed here, labels for the table. */
export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export const CHART = { width: 720, height: 120, gap: 2 } as const;

/**
 * Bars for `hours` over the `slots` hours ending at `to` (hours without
 * records are absent from the API's answer: they are zero-height bars).
 */
export function hourlyBars(hours: UsageHour[], to: number, slots: number, value: (h: UsageHour) => number, unit: string): Bar[] {
  const end = Math.floor(to / 3_600_000) * 3_600_000;
  const byHour = new Map(hours.map((h) => [h.hour_start, h]));
  const values: { start: number; v: number }[] = [];
  for (let i = slots - 1; i >= 0; i--) {
    const start = end - i * 3_600_000;
    const h = byHour.get(start);
    values.push({ start, v: h === undefined ? 0 : value(h) });
  }
  const max = Math.max(1, ...values.map((x) => x.v));
  const width = CHART.width / slots;
  return values.map((x, i) => {
    const height = Math.round((x.v / max) * (CHART.height - 4) * 10) / 10;
    return {
      x: Math.round(i * width * 10) / 10,
      y: Math.round((CHART.height - height) * 10) / 10,
      width: Math.max(1, Math.round((width - CHART.gap) * 10) / 10),
      height,
      label: `${clock(x.start).slice(0, 13)}:00 UTC: ${round(x.v)} ${unit}`,
    };
  });
}

export const round = (n: number): string => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 1 }));

/** "38%" of a quota, capped for the meter width. */
export const percent = (used: number, limit: number): number => (limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100)));
