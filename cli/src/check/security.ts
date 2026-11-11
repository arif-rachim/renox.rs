// `[security]` of renox.toml (#47; docs/04-isolation-security.md, "Web-layer
// protections"; artifact.md section 3, "Security"): validated against the
// manifest schema's `security` object and rule V16, resolved into
// manifest.security, and printed per route by `renox check --security`.
//
// The header rules mirror crates/renox-gateway/src/security/headers.rs; both
// test suites assert the same default CSP string.

import { ValidationError } from "../errors.ts";
import type { Route } from "../lib/routes.ts";
import { methodsOf } from "../lib/routes.ts";
import { type Json, validate } from "../lib/schema.ts";
import { schemas } from "../lib/schemas.ts";

export interface SecurityConfig {
  csp?: {
    script_src?: string[];
    style_src?: string[];
    img_src?: string[];
    connect_src?: string[];
    frame_src?: string[];
    font_src?: string[];
    form_action?: string[];
    allow_unsafe?: boolean;
    report_only?: boolean;
  };
  cors?: { origins?: string[]; methods?: string[]; headers?: string[]; credentials?: boolean; max_age_s?: number };
  headers?: { referrer_policy?: string; permissions_allow?: string[] };
  ratelimit?: { method: string; path: string; requests: number; window_s: number; key: "ip" }[];
}

/** Most sources per directive after the merge (artifact.md, Security). */
export const MAX_CSP_SOURCES = 32;
type CspKey = "script_src" | "style_src" | "img_src" | "connect_src" | "frame_src" | "font_src";
const CSP_KEYS: readonly CspKey[] = ["script_src", "style_src", "img_src", "connect_src", "frame_src", "font_src"];

/** Where each merged CSP source came from: `app` (renox.toml) or a module name. */
export type CspProvenance = Partial<Record<CspKey, Map<string, string[]>>>;

/**
 * The app's `[security]` with every installed module's approved
 * `permissions.csp` merged into `security.csp.*` (manifest.md 1.6; artifact.md,
 * Security): per directive the union, sorted and deduplicated, at most
 * MAX_CSP_SOURCES. `modules` carry the APPROVED sets (renox.lock); the build
 * has already refused any manifest that differs (MF12). Without a module
 * source the security config is returned untouched.
 */
export function mergeModuleCsp(
  security: SecurityConfig | undefined,
  modules: { name: string; csp?: Partial<Record<CspKey, string[]>> | undefined }[],
): { security: SecurityConfig | undefined; provenance: CspProvenance; problems: string[] } {
  const provenance: CspProvenance = {};
  const problems: string[] = [];
  const contributing = modules.filter((m) => CSP_KEYS.some((k) => m.csp?.[k]?.length));
  if (contributing.length === 0) return { security, provenance, problems };
  const csp: NonNullable<SecurityConfig["csp"]> = { ...(security?.csp ?? {}) };
  for (const key of CSP_KEYS) {
    const from = new Map<string, string[]>();
    const add = (src: string, who: string) => from.set(src, [...(from.get(src) ?? []), who]);
    for (const src of security?.csp?.[key] ?? []) add(src, "app");
    for (const m of contributing) {
      const before = from.size;
      for (const src of m.csp?.[key] ?? []) add(src, m.name);
      if (before <= MAX_CSP_SOURCES && from.size > MAX_CSP_SOURCES)
        problems.push(`module ${m.name}: its permissions.csp.${key} brings security.csp.${key} to ${from.size} sources; at most ${MAX_CSP_SOURCES}`);
    }
    if (from.size === 0) continue;
    provenance[key] = new Map([...from].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    csp[key] = [...provenance[key].keys()];
  }
  // form_action is the app's own (#740): modules never add to it; sorted and deduplicated like the others.
  if (csp.form_action) csp.form_action = [...new Set(csp.form_action)].sort();
  return { security: { ...(security ?? {}), csp }, provenance, problems };
}

export const CSP_REPORT_PATH = "/__renox/events?kind=csp";
/** The `report-to` group, declared by `Reporting-Endpoints` (client-events.md section 6). */
export const CSP_REPORT_GROUP = "renox-csp";
export const DENIED_FEATURES = ["camera", "microphone", "geolocation"];
const UNSAFE = ["'unsafe-inline'", "'unsafe-eval'"];

/** `[security]` problems (schema of manifest.security, then V16). */
export function securityProblems(security: SecurityConfig, routes: Route[]): string[] {
  // MF17 (manifest.md 1.6.2): one source grammar for app and modules; `;` ends a directive and `,` starts a
  // second policy in the header, so a source never holds them. Checked first so the message names the rule.
  const structural: string[] = [];
  for (const key of CSP_KEYS)
    for (const src of security.csp?.[key] ?? [])
      if (typeof src === "string" && /[;,]/u.test(src))
        structural.push(`MF17: security.csp.${key} "${src}" is not an https:// origin (optional *. wildcard and path), data: or blob:`);
  for (const src of security.csp?.form_action ?? [])
    if (typeof src === "string" && /[;,]/u.test(src)) structural.push(`MF17: security.csp.form_action "${src}" is not an https:// origin (no wildcard host, no path)`);
  if (structural.length) return structural;
  const root = schemas.manifest as { $defs: Record<string, Json> };
  const errs = validate({ $ref: "#/$defs/security" }, security as Json, { $defs: root.$defs } as Json, "security");
  if (errs.length) return errs;
  const out: string[] = [];
  const csp = security.csp ?? {};
  for (const key of ["script_src", "style_src"] as const)
    for (const src of csp[key] ?? [])
      if (UNSAFE.includes(src) && !csp.allow_unsafe)
        out.push(`V16: security.csp.${key} has ${src}; set [security.csp] allow_unsafe = true to opt in (flagged in the dashboard)`);
  for (const key of ["img_src", "connect_src", "frame_src", "font_src"] as const)
    for (const src of csp[key] ?? []) if (UNSAFE.includes(src)) out.push(`V16: security.csp.${key}: ${src} is only allowed in script_src and style_src`);
  if (security.cors?.credentials && !(security.cors.origins ?? []).length) out.push("V16: security.cors.credentials needs a non-empty security.cors.origins");
  const seen = new Set<string>();
  for (const b of security.ratelimit ?? []) {
    const key = `${b.method} ${b.path} ${b.key}`;
    if (seen.has(key)) out.push(`V16: security.ratelimit has ${b.method} ${b.path} (${b.key}) twice`);
    seen.add(key);
    if (!routes.some((r) => r.path === b.path && methodsOf(r).includes(b.method as never)))
      out.push(`V16: security.ratelimit ${b.method} ${b.path}: no route answers it`);
  }
  return out;
}

/** Throws a ValidationError listing every `[security]` problem. */
export function checkSecurity(security: SecurityConfig, routes: Route[]): void {
  const problems = securityProblems(security, routes);
  if (problems.length === 1) throw new ValidationError(problems[0] as string, { file: "renox.toml" });
  if (problems.length) throw new ValidationError(`[security] has ${problems.length} problems:\n  ${problems.join("\n  ")}`, { file: "renox.toml" });
}

/** The CSP the gateway sends; `nonce` is a fresh value per request. */
export function cspValue(security: SecurityConfig, nonce: string, tls: boolean): string {
  const csp = security.csp ?? {};
  const n = `'nonce-${nonce}'`;
  const d = ["default-src 'self'", ["script-src", "'self'", n, ...(csp.script_src ?? [])].join(" "), ["style-src", "'self'", n, ...(csp.style_src ?? [])].join(" ")];
  for (const [name, extra] of [
    ["img-src", csp.img_src],
    ["connect-src", csp.connect_src],
    ["frame-src", csp.frame_src],
    ["font-src", csp.font_src],
  ] as const)
    if (extra?.length) d.push([name, "'self'", ...extra].join(" "));
  d.push("object-src 'none'", "base-uri 'self'", ["form-action", "'self'", ...(csp.form_action ?? [])].join(" "), "frame-ancestors 'none'");
  if (tls) d.push("upgrade-insecure-requests");
  d.push(`report-uri ${CSP_REPORT_PATH}`, `report-to ${CSP_REPORT_GROUP}`);
  return d.join("; ");
}

export function permissionsPolicy(security: SecurityConfig): string {
  const allow = security.headers?.permissions_allow ?? [];
  return [...DENIED_FEATURES.filter((f) => !allow.includes(f)).map((f) => `${f}=()`), ...allow.map((f) => `${f}=(self)`)].join(", ");
}

/** Every protection header of a response, as the gateway sends it over TLS. */
export function headerSet(security: SecurityConfig, nonce = "<per-request>", tls = true): [string, string][] {
  return [
    [security.csp?.report_only ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", cspValue(security, nonce, tls)],
    ["Reporting-Endpoints", `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`],
    ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", security.headers?.referrer_policy ?? "strict-origin-when-cross-origin"],
    ["Permissions-Policy", permissionsPolicy(security)],
    ["Cross-Origin-Opener-Policy", "same-origin"],
  ];
}

/** `renox check --security`: the effective headers, then CORS and buckets per route. */
export function securityReport(security: SecurityConfig, routes: Route[], provenance: CspProvenance = {}): string {
  const lines = ["Response headers (every route; the nonce is fresh per request):"];
  for (const [k, v] of headerSet(security)) lines.push(`  ${k}: ${v}`);
  const merged = CSP_KEYS.filter((k) => provenance[k]?.size);
  if (merged.length) {
    lines.push("CSP sources added to the platform policy (app = renox.toml [security]; others are modules' approved permissions.csp):");
    for (const k of merged) for (const [src, who] of provenance[k] ?? []) lines.push(`  ${k.replace("_", "-")} ${src}  (${who.join(", ")})`);
  }
  const cors = security.cors ?? {};
  const origins = cors.origins ?? [];
  lines.push(
    origins.length
      ? `CORS: ${origins.join(", ")}; methods ${(cors.methods ?? ["GET", "HEAD", "POST"]).join(", ")}; headers ${(cors.headers ?? []).join(", ") || "none"}; credentials ${cors.credentials ? "yes" : "no"}; max-age ${cors.max_age_s ?? 600} s`
      : "CORS: closed (same origin only)",
  );
  if (security.csp?.allow_unsafe) lines.push("Warning: csp.allow_unsafe is set ('unsafe-inline'/'unsafe-eval' allowed)");
  lines.push("Routes:");
  for (const r of routes) {
    const methods = methodsOf(r);
    const buckets = (security.ratelimit ?? []).filter((b) => b.path === r.path && methods.includes(b.method as never));
    const limit = buckets.map((b) => `${b.method} ${b.requests}/${b.window_s} s per ${b.key}`).join(", ");
    const kind = r.kind === "page" ? "page" : "function";
    lines.push(`  ${methods.join(",").padEnd(14)} ${r.path}  ${kind}${r.kind === "page" && r.actions?.length ? ", CSRF-checked actions" : ""}${limit ? `, rate limit ${limit}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}
