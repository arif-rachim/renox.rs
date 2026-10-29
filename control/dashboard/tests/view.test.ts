// lib/view.ts: the hourly chart and the deployment rows the templates show.
import { expect, test } from "bun:test";

import type { Deployment, UsageHour } from "../lib/api.ts";
import { parseLogEvents } from "../lib/api.ts";
import { CHART, deploymentRows, hourlyBars, percent } from "../lib/view.ts";

const H = 3_600_000;
const hour = (start: number, requests: number): UsageHour => ({ hour_start: start, requests, cpu_ms: 0, wall_ms: 0, egress_bytes: 0, fetch_sent_bytes: 0, db_ms: 0, db_rows: 0, render_fuel: 0 });

test("hourly bars: one per slot ending at `to`, missing hours at zero, the largest at full height", () => {
  const to = 1_793_318_400_000;
  const bars = hourlyBars([hour(to, 10), hour(to - 2 * H, 5)], to, 4, (h) => h.requests, "requests");
  expect(bars.map((b) => b.height)).toEqual([0, CHART.height - 4 - (CHART.height - 4) / 2, 0, CHART.height - 4]);
  expect(bars.map((b) => b.x)).toEqual([0, 180, 360, 540]);
  expect(bars.every((b) => b.y + b.height === CHART.height)).toBe(true);
  expect(bars[3]?.label).toBe("2026-10-30 00:00 UTC: 10 requests");
  expect(percent(5, 0)).toBe(0);
  expect(percent(150, 100)).toBe(100);
});

test("deployment rows: promote for validated and superseded, rollback on the live one when an earlier exists", () => {
  const d = (hash: string, state: Deployment["state"]): Deployment => ({
    app: "a", hash: hash.repeat(64), state, created_at: 0, updated_at: 0, size_bytes: 2048, permissions: { network: [], secrets: [] },
    secrets_version: null, activated_at: null, last_error: null, violations: state === "rejected" ? [{ rule: "T1", reason: "x" }] : null,
  });
  const rows = deploymentRows([d("a", "active"), d("b", "superseded"), d("c", "validated"), d("d", "rejected")], 0);
  expect(rows.map((r) => [r.state, r.can_activate, r.can_rollback, r.error])).toEqual([
    ["active", false, true, null],
    ["superseded", true, false, null],
    ["validated", true, false, null],
    ["rejected", false, false, "1 violation(s)"],
  ]);
  expect(deploymentRows([d("a", "active")], 0)[0]?.can_rollback).toBe(false);
});

test("log events: only `log` events with a valid line; comments, other events and bad JSON are skipped", () => {
  const line = { ts: 1, tenant_id: "t", deployment_hash: "a".repeat(64), request_id: null, module: "m", level: "info", message: "hi", fields: null, source: "server" };
  const body = `: keep-alive\n\nevent: log\nid: 1-0\ndata: ${JSON.stringify(line)}\n\nevent: other\ndata: {}\n\nevent: log\ndata: {not json\n\r\nevent: log\r\ndata: ${JSON.stringify({ ...line, message: "crlf" })}\r\n\r\n`;
  expect(parseLogEvents(body).map((l) => l.message)).toEqual(["hi", "crlf"]);
});
