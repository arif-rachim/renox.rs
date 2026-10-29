// Checks the dashboards and the alert rules of ops/observability against its
// README (#296): the structure Grafana and Prometheus need, the metric
// families each expression reads, and the docs/23 row each rule names.
// `promtool check rules` checks the PromQL itself; this checks what promtool
// cannot know. Run: bun ops/observability/check.ts (CI's lint job).
//
// Exit 0 when clean; otherwise one line per problem and exit 1.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const REPO = join(HERE, "../..");
const DATASOURCE = "renox-prometheus";

type Problem = string;

/** The backticked names in the first column of the README table whose header starts with `header`. */
export function tableNames(readme: string, header: string): string[] {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`| ${header} |`));
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const m = /^\| `([^`]+)` \|/u.exec(line);
    if (m?.[1] !== undefined) names.push(m[1]);
  }
  return names;
}

/** The failure names of docs/23: the first cell of every table row. */
export function failureModes(doc: string): Set<string> {
  const out = new Set<string>();
  for (const line of doc.split("\n")) {
    const m = /^\| ([^|]+?) \|/u.exec(line);
    if (m?.[1] !== undefined && !/^-+$/u.test(m[1]) && m[1] !== "Failure") out.add(m[1].trim());
  }
  return out;
}

const PROMQL_WORDS = new Set([
  "sum", "max", "min", "avg", "count", "rate", "increase", "irate", "histogram_quantile", "by", "without", "on", "ignoring",
  "and", "or", "unless", "group_left", "group_right", "offset", "bool", "label_values", "abs", "clamp_min", "clamp_max", "le",
]);

/** The metric names an expression reads (identifiers that are not PromQL words, labels, strings or durations). */
export function metricsOf(expr: string): string[] {
  const stripped = expr
    // Grafana's `label_values(metric, label)`: the second argument is a label.
    .replace(/label_values\(([^,()]+),[^)]*\)/gu, "$1")
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/\{[^}]*\}/gu, "{}")
    .replace(/\[[^\]]*\]/gu, "[]")
    .replace(/\b(by|without|on|ignoring)\s*\([^)]*\)/gu, "");
  const names = new Set<string>();
  for (const m of stripped.matchAll(/\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b/gu)) {
    const n = m[1] as string;
    if (PROMQL_WORDS.has(n) || /^\d/u.test(n)) continue;
    names.add(n);
  }
  return [...names];
}

/** A histogram's series are `<family>_bucket`, `_sum`, `_count`. */
function family(name: string, known: Set<string>): string | null {
  if (known.has(name)) return name;
  for (const suffix of ["_bucket", "_sum", "_count"]) {
    if (name.endsWith(suffix) && known.has(name.slice(0, -suffix.length))) return name.slice(0, -suffix.length);
  }
  return null;
}

interface Panel {
  id?: unknown;
  title?: unknown;
  type?: unknown;
  datasource?: { uid?: unknown };
  gridPos?: { x: number; y: number; w: number; h: number };
  targets?: { expr?: unknown; datasource?: { uid?: unknown } }[];
}

export function checkDashboard(file: string, text: string, known: Set<string>): Problem[] {
  const out: Problem[] = [];
  let d: { uid?: unknown; title?: unknown; schemaVersion?: unknown; panels?: Panel[]; templating?: { list?: { query?: { query?: unknown }; datasource?: { uid?: unknown } }[] } };
  try {
    d = JSON.parse(text);
  } catch (e) {
    return [`${file}: not JSON (${(e as Error).message})`];
  }
  for (const k of ["uid", "title", "schemaVersion"] as const) if (d[k] === undefined) out.push(`${file}: no ${k}`);
  if (!Array.isArray(d.panels) || d.panels.length === 0) return [...out, `${file}: no panels`];
  const ids = new Set<unknown>();
  const boxes: { id: unknown; x: number; y: number; w: number; h: number }[] = [];
  for (const p of d.panels) {
    const where = `${file}: panel ${String(p.id)} "${String(p.title)}"`;
    if (typeof p.id !== "number") out.push(`${where}: no numeric id`);
    if (ids.has(p.id)) out.push(`${where}: duplicate id`);
    ids.add(p.id);
    if (typeof p.title !== "string" || typeof p.type !== "string") out.push(`${where}: needs a title and a type`);
    if (p.datasource?.uid !== DATASOURCE) out.push(`${where}: data source must be ${DATASOURCE}`);
    const g = p.gridPos;
    if (g === undefined || g.w <= 0 || g.h <= 0 || g.x < 0 || g.x + g.w > 24) out.push(`${where}: gridPos outside the 24-column grid`);
    else {
      for (const b of boxes) {
        if (g.x < b.x + b.w && b.x < g.x + g.w && g.y < b.y + b.h && b.y < g.y + g.h) out.push(`${where}: overlaps panel ${String(b.id)}`);
      }
      boxes.push({ id: p.id, ...g });
    }
    if (!Array.isArray(p.targets) || p.targets.length === 0) out.push(`${where}: no targets`);
    for (const t of p.targets ?? []) {
      if (typeof t.expr !== "string" || t.expr.trim() === "") {
        out.push(`${where}: a target without an expression`);
        continue;
      }
      if (t.datasource !== undefined && t.datasource.uid !== DATASOURCE) out.push(`${where}: target data source must be ${DATASOURCE}`);
      for (const m of metricsOf(t.expr)) if (family(m, known) === null) out.push(`${where}: reads ${m}, which is not in the README's family table`);
    }
  }
  for (const v of d.templating?.list ?? []) {
    const q = v.query?.query;
    if (typeof q === "string") for (const m of metricsOf(q)) if (family(m, known) === null) out.push(`${file}: variable reads ${m}, which is not in the README's family table`);
  }
  return out;
}

interface Rule {
  alert?: unknown;
  expr?: unknown;
  labels?: { severity?: unknown };
  annotations?: { summary?: unknown; failure_mode?: unknown };
}

export function checkRules(file: string, text: string, known: Set<string>, modes: Set<string>): { problems: Problem[]; alerts: string[] } {
  const out: Problem[] = [];
  const alerts: string[] = [];
  let doc: { groups?: { name?: unknown; rules?: Rule[] }[] };
  try {
    doc = Bun.YAML.parse(text) as typeof doc;
  } catch (e) {
    return { problems: [`${file}: not YAML (${(e as Error).message})`], alerts };
  }
  if (!Array.isArray(doc?.groups) || doc.groups.length === 0) return { problems: [`${file}: no groups`], alerts };
  for (const g of doc.groups) {
    if (typeof g.name !== "string") out.push(`${file}: a group without a name`);
    for (const r of g.rules ?? []) {
      const where = `${file}: ${String(r.alert)}`;
      if (typeof r.alert !== "string" || !/^Renox[A-Z][A-Za-z0-9]+$/u.test(r.alert)) {
        out.push(`${where}: alert name must be Renox<Name>`);
        continue;
      }
      alerts.push(r.alert);
      if (typeof r.expr !== "string") out.push(`${where}: no expr`);
      else for (const m of metricsOf(r.expr)) if (family(m, known) === null) out.push(`${where}: reads ${m}, which is not in the README's family table`);
      if (r.labels?.severity !== "page" && r.labels?.severity !== "ticket") out.push(`${where}: severity must be page or ticket`);
      if (typeof r.annotations?.summary !== "string") out.push(`${where}: no summary`);
      const fm = r.annotations?.failure_mode;
      if (typeof fm !== "string" || !modes.has(fm)) out.push(`${where}: failure_mode ${JSON.stringify(fm)} is not a row of docs/23-failure-modes.md`);
    }
  }
  return { problems: out, alerts };
}

export function checkAll(): Problem[] {
  const readme = readFileSync(join(HERE, "README.md"), "utf8");
  const known = new Set(tableNames(readme, "Family"));
  const documented = new Set(tableNames(readme, "Rule"));
  const modes = failureModes(readFileSync(join(REPO, "docs/23-failure-modes.md"), "utf8"));
  const problems: Problem[] = [];
  if (known.size === 0) problems.push("README.md: no family table");
  const dashDir = join(HERE, "grafana/dashboards");
  const uids = new Set<unknown>();
  for (const f of readdirSync(dashDir).filter((n) => n.endsWith(".json")).sort()) {
    const text = readFileSync(join(dashDir, f), "utf8");
    problems.push(...checkDashboard(`grafana/dashboards/${f}`, text, known));
    try {
      const uid = (JSON.parse(text) as { uid?: unknown }).uid;
      if (uids.has(uid)) problems.push(`grafana/dashboards/${f}: uid ${String(uid)} is used twice`);
      uids.add(uid);
    } catch {
      // Reported above.
    }
  }
  const seen = new Set<string>();
  for (const f of readdirSync(join(HERE, "rules")).filter((n) => n.endsWith(".yml")).sort()) {
    const r = checkRules(`rules/${f}`, readFileSync(join(HERE, "rules", f), "utf8"), known, modes);
    problems.push(...r.problems);
    for (const a of r.alerts) {
      if (seen.has(a)) problems.push(`rules/${f}: ${a} is defined twice`);
      seen.add(a);
      if (!documented.has(a)) problems.push(`rules/${f}: ${a} is not in the README's alert table`);
    }
  }
  for (const a of documented) if (!seen.has(a)) problems.push(`README.md: ${a} is in the alert table but no rule defines it`);
  return problems;
}

if (import.meta.main) {
  const problems = checkAll();
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log("ops/observability: dashboards and rules match the README");
}
