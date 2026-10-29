// ops/observability/check.ts (#296): the committed dashboards and rules
// pass, and each kind of mistake it exists for is reported.
import { expect, test } from "bun:test";

import { checkAll, checkDashboard, checkRules, failureModes, metricsOf, tableNames } from "./check.ts";

const KNOWN = new Set(["renox_cp_up", "renox_worker_request_duration_seconds", "renox_cp_node_healthy"]);
const MODES = new Set(["Node dies"]);

const panel = (over: Record<string, unknown> = {}) => ({
  id: 1,
  title: "p",
  type: "timeseries",
  datasource: { type: "prometheus", uid: "renox-prometheus" },
  gridPos: { x: 0, y: 0, w: 12, h: 8 },
  targets: [{ refId: "A", expr: "renox_cp_up" }],
  ...over,
});
const dashboard = (panels: unknown[]) => JSON.stringify({ uid: "u", title: "t", schemaVersion: 39, panels });
const rule = (over: Record<string, unknown> = {}) => ({
  alert: "RenoxThing",
  expr: "renox_cp_node_healthy == 0",
  labels: { severity: "page" },
  annotations: { summary: "s", failure_mode: "Node dies" },
  ...over,
});
const rules = (rs: unknown[]) => JSON.stringify({ groups: [{ name: "g", rules: rs }] });

test("the committed dashboards and rules match the README", () => {
  expect(checkAll()).toEqual([]);
});

test("metric names are read out of PromQL; labels, strings, durations and functions are not", () => {
  expect(
    metricsOf('histogram_quantile(0.95, sum by (le, tenant_id) (rate(renox_worker_request_duration_seconds_bucket{tenant_id="$t", x="a b"}[5m]))) > 0.1').sort(),
  ).toEqual(["renox_worker_request_duration_seconds_bucket"]);
  expect(metricsOf("a / on (node_id) b or up{job=\"x\"} == 0").sort()).toEqual(["a", "b", "up"]);
  expect(metricsOf("label_values(renox_cp_node_healthy, node_id)")).toEqual(["renox_cp_node_healthy"]);
});

test("dashboard mistakes are reported", () => {
  expect(checkDashboard("d", dashboard([panel()]), KNOWN)).toEqual([]);
  expect(checkDashboard("d", "{", KNOWN)[0]).toContain("not JSON");
  const cases: [unknown[], string][] = [
    [[panel(), panel({ gridPos: { x: 12, y: 0, w: 12, h: 8 } })], "duplicate id"],
    [[panel(), panel({ id: 2, gridPos: { x: 6, y: 4, w: 12, h: 8 } })], "overlaps panel 1"],
    [[panel({ gridPos: { x: 20, y: 0, w: 12, h: 8 } })], "24-column grid"],
    [[panel({ datasource: { uid: "other" } })], "data source"],
    [[panel({ targets: [{ refId: "A" }] })], "without an expression"],
    [[panel({ targets: [{ refId: "A", expr: "renox_unknown_total" }] })], "reads renox_unknown_total"],
    [[], "no panels"],
  ];
  for (const [panels, want] of cases) {
    expect(checkDashboard("d", dashboard(panels), KNOWN).join("\n")).toContain(want);
  }
  // A histogram family covers its _bucket series.
  expect(checkDashboard("d", dashboard([panel({ targets: [{ refId: "A", expr: "rate(renox_worker_request_duration_seconds_count[5m])" }] })]), KNOWN)).toEqual([]);
});

test("rule mistakes are reported", () => {
  expect(checkRules("r", rules([rule()]), KNOWN, MODES)).toEqual({ problems: [], alerts: ["RenoxThing"] });
  const cases: [Record<string, unknown>, string][] = [
    [{ alert: "thing" }, "Renox<Name>"],
    [{ labels: { severity: "critical" } }, "page or ticket"],
    [{ annotations: { failure_mode: "Node dies" } }, "no summary"],
    [{ annotations: { summary: "s", failure_mode: "Something else" } }, "not a row of docs/23"],
    [{ expr: "renox_unknown == 1" }, "reads renox_unknown"],
  ];
  for (const [over, want] of cases) {
    expect(checkRules("r", rules([rule(over)]), KNOWN, MODES).problems.join("\n")).toContain(want);
  }
});

test("the README tables and docs/23 rows are read", () => {
  const readme = "x\n\n| Family | Type |\n| --- | --- |\n| `a_b` | gauge |\n| `c` | counter |\n\nafter";
  expect(tableNames(readme, "Family")).toEqual(["a_b", "c"]);
  expect(tableNames(readme, "Rule")).toEqual([]);
  const doc = "| Failure | Detected by |\n| --- | --- |\n| Node dies | Heartbeat |\n";
  expect([...failureModes(doc)]).toEqual(["Node dies"]);
});
