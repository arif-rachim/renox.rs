// The control API as the dashboard sees it (docs/contracts/deploy-api.md;
// ADR D23). The dashboard is an ordinary tenant: it calls the API at its
// public hostname with `ctx.fetch`, under the same allowlist and blocked
// ranges as every tenant, with the signed-in user's own token forwarded on
// every request. It never holds a node token or a token of its own.
//
// Every call returns a value or an `ApiFailure`; nothing here throws for an
// HTTP status, so a loader can render the failure instead of answering with a
// `Response` after the streamed shell (ops.md section 14, "Streaming the shell").

import type { Fetch, Secrets } from "renox";

/** The API `renox login` uses by default (cli/src/commands/login.ts). */
export const DEFAULT_API = "https://api.renox.app";

/** Bytes of an API response body the dashboard reads at most (a log page is the largest). */
const MAX_BODY = 4 * 1024 * 1024;

export interface App {
  name: string;
  tenant_id: string;
  created_at: number;
  active_deployment: string | null;
  hostnames: string[];
}

export type DeploymentState = "uploaded" | "validated" | "rejected" | "activating" | "active" | "superseded" | "suspended" | "pruned";

export interface Violation {
  rule: string;
  path?: string;
  field?: string;
  reason: string;
}

/** `activation_error` (control-messages.schema.json). */
export interface ActivationError {
  stage: "no_worker" | "fetch" | "load" | "migrate" | "probe" | "timeout";
  reason: string;
  module?: string;
  file?: string;
  sqlite_error?: string;
  http_status?: number;
}

export interface Deployment {
  app: string;
  hash: string;
  state: DeploymentState;
  created_at: number;
  updated_at: number;
  size_bytes: number;
  permissions: { network: string[]; secrets: string[] };
  secrets_version: number | null;
  activated_at: number | null;
  last_error: ActivationError | null;
  violations: Violation[] | null;
}

export interface UsageHour {
  hour_start: number;
  requests: number;
  cpu_ms: number;
  wall_ms: number;
  egress_bytes: number;
  fetch_sent_bytes: number;
  db_ms: number;
  db_rows: number;
  render_fuel: number;
}

export interface QuotaAmounts {
  requests: number;
  cpu_ms: number;
  egress_bytes: number;
}

export interface AppUsage {
  app: string;
  from: number;
  to: number;
  hours: UsageHour[];
  total: Omit<UsageHour, "hour_start">;
  quota: { tenant_id: string; tier: string; period_start: number; period_end: number; used: QuotaAmounts; limits: QuotaAmounts; over: string[] };
  /** Browser events today against the daily cap (deploy-api.md section 11; warning from 80 %). */
  client_events: { used_today: number; daily_cap: number; warning: boolean };
}

export type ClientErrorStatus = "open" | "resolved" | "ignored";

/** A stack frame as the browser reported it and, when a private sourcemap matched, its original position. */
export interface ClientErrorFrame {
  file: string;
  line: number;
  column: number;
  function: string | null;
  original: { file: string; line: number; column: number } | null;
}

/** `ClientErrorGroup` (deploy-api.yaml). */
export interface ClientErrorGroup {
  fingerprint: string;
  kind: string;
  message: string;
  status: ClientErrorStatus;
  first_seen: number;
  last_seen: number;
  count: number;
  regressed: boolean;
  deployments: { deployment_hash: string; count: number }[];
  top_frame: ClientErrorFrame | null;
}

export interface ClientErrorEvent {
  ts: number;
  client_ts: number;
  deployment_hash: string;
  request_id: string | null;
  message: string;
  url: string;
  ua: string;
  frames: ClientErrorFrame[];
}

export interface SecretList {
  version: number;
  secrets: { name: string; updated_at: number }[];
}

/** One `log_line` (control-messages.schema.json). */
export interface LogLine {
  ts: number;
  tenant_id: string;
  deployment_hash: string;
  request_id: string | null;
  module: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown> | null;
  source: "server" | "client";
}

/** A call that did not give a value: the API's error, or why the API was not reached. */
/** `OpsReplication` (deploy-api.md 0.3.1 section 17). */
export interface OpsReplication {
  database: string;
  replication: "none" | "litestream";
  state: "off" | "starting" | "replicating" | "stopped";
  replica: { kind: "file" | "s3"; region?: string } | null;
  last_sync_at: number | null;
  lag_seconds: number | null;
  reported_at: number;
  stale: boolean;
}

/** `OpsTenant`: a tenant as the operator console shows it (`getOpsTenant`, 0.3.1; #296). */
export interface OpsTenant {
  tenant_id: string;
  name: string;
  tier: "free" | "paid";
  state: "active" | "suspended";
  process: "shared" | "own";
  node_id: string | null;
  pinned_node: string | null;
  moving: boolean;
  moving_since: number | null;
  microvm_at: number | null;
  replication: OpsReplication[];
  actions: { audit_id: string; at: number; action: "setTenantTier" | "moveTenant"; operator: string; reason: string; result: string }[];
}

export interface ApiFailure {
  ok: false;
  /** HTTP status; 0 when the API was not reached. */
  status: number;
  /** `RENOX_*` code from the API, or the dashboard's own for a transport failure. */
  code: string;
  /** Text safe to show the user: the API's message or a fixed one, never a header or a token. */
  message: string;
  details: unknown[];
  requestId: string | null;
}

export type Result<T> = { ok: true; value: T } | ApiFailure;

/** The API's base URL: `RENOX_API_URL` when set (https only), else the default. */
export function apiBase(secrets: Secrets): string {
  const raw = secrets.RENOX_API_URL;
  if (raw === undefined || raw === "") return DEFAULT_API;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return DEFAULT_API;
  }
  // The token is sent to this origin: plain http or credentials in the URL are never used.
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return DEFAULT_API;
  return url.origin;
}

const fail = (status: number, code: string, message: string, extra: Partial<ApiFailure> = {}): ApiFailure => ({
  ok: false,
  status,
  code,
  message,
  details: [],
  requestId: null,
  ...extra,
});

async function readText(res: Response): Promise<string | null> {
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return null;
  const text = await res.text();
  return text.length > MAX_BODY ? null : text;
}

/** The API's error body as a failure; a body that is not one gives a fixed text. */
function failureOf(res: Response, text: string | null): ApiFailure {
  try {
    const body = JSON.parse(text ?? "") as { error?: { code?: unknown; message?: unknown; details?: unknown; request_id?: unknown } };
    const e = body.error;
    if (e !== undefined && typeof e.code === "string" && /^RENOX_[A-Z0-9_]+$/u.test(e.code)) {
      return fail(res.status, e.code, typeof e.message === "string" ? e.message.slice(0, 200) : e.code, {
        details: Array.isArray(e.details) ? e.details.slice(0, 50) : [],
        requestId: typeof e.request_id === "string" ? e.request_id : null,
      });
    }
  } catch {
    // Not JSON: fall through.
  }
  return fail(res.status, "RENOX_INTERNAL", `the control API answered ${res.status}`);
}

/** The API client of one request: the signed-in user's token, the tenant's `fetch`. */
export class Api {
  constructor(
    private readonly fetch: Fetch,
    private readonly token: string,
    readonly base: string,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<Result<{ res: Response; text: string | null }>> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual" });
    } catch (e) {
      // RENOX_FETCH_BLOCKED (the API host is not allowlisted, or resolves to a
      // blocked address) or RENOX_FETCH_FAILED. The error's code, not its text.
      const code = typeof (e as { code?: unknown }).code === "string" ? String((e as { code: string }).code) : "RENOX_FETCH_FAILED";
      return fail(0, code, "the control API could not be reached");
    }
    const text = await readText(res);
    if (res.status >= 300) return failureOf(res, text);
    if (text === null) return fail(res.status, "RENOX_INTERNAL", "the control API answer was too large");
    return { ok: true, value: { res, text } };
  }

  /** A JSON call; public for the calls of lib/database.ts (#258). */
  async json<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    const r = await this.call(method, path, body);
    if (!r.ok) return r;
    if (r.value.res.status === 204) return { ok: true, value: undefined as T };
    try {
      return { ok: true, value: JSON.parse(r.value.text ?? "") as T };
    } catch {
      return fail(r.value.res.status, "RENOX_INTERNAL", "the control API answer was not JSON");
    }
  }

  /** The operator read (needs an operator token as this client's token). */
  getOpsTenant(tenant: string): Promise<Result<OpsTenant>> {
    return this.json("GET", `/v1/ops/tenants/${encodeURIComponent(tenant)}`);
  }

  listApps(): Promise<Result<{ apps: App[] }>> {
    return this.json("GET", "/v1/apps");
  }

  createApp(name: string): Promise<Result<App>> {
    return this.json("POST", "/v1/apps", { name });
  }

  getApp(app: string): Promise<Result<App>> {
    return this.json("GET", `/v1/apps/${encodeURIComponent(app)}`);
  }

  listDeployments(app: string, limit = 20): Promise<Result<{ deployments: Deployment[] }>> {
    return this.json("GET", `/v1/apps/${encodeURIComponent(app)}/deployments?limit=${limit}`);
  }

  getDeployment(app: string, hash: string): Promise<Result<Deployment>> {
    return this.json("GET", `/v1/apps/${encodeURIComponent(app)}/deployments/${encodeURIComponent(hash)}`);
  }

  activate(app: string, hash: string): Promise<Result<Deployment>> {
    return this.json("POST", `/v1/apps/${encodeURIComponent(app)}/activate`, { hash });
  }

  /** Without `hash`, the API rolls back to the previous deployment. */
  rollback(app: string, hash?: string): Promise<Result<Deployment>> {
    return this.json("POST", `/v1/apps/${encodeURIComponent(app)}/rollback`, hash === undefined ? {} : { hash });
  }

  usage(app: string, from: number, to: number): Promise<Result<AppUsage>> {
    return this.json("GET", `/v1/apps/${encodeURIComponent(app)}/usage?from=${from}&to=${to}`);
  }

  clientErrors(app: string, opts: { status?: ClientErrorStatus; deployment?: string; cursor?: string; limit?: number } = {}): Promise<Result<{ groups: ClientErrorGroup[]; next_cursor: string | null }>> {
    const q = new URLSearchParams();
    if (opts.status !== undefined) q.set("status", opts.status);
    if (opts.deployment !== undefined) q.set("deployment", opts.deployment);
    if (opts.cursor !== undefined) q.set("cursor", opts.cursor);
    q.set("limit", String(opts.limit ?? 50));
    return this.json("GET", `/v1/apps/${encodeURIComponent(app)}/client-errors?${q}`);
  }

  clientError(app: string, fingerprint: string): Promise<Result<{ group: ClientErrorGroup; events: ClientErrorEvent[] }>> {
    return this.json("GET", `/v1/apps/${encodeURIComponent(app)}/client-errors/${encodeURIComponent(fingerprint)}`);
  }

  setClientErrorStatus(app: string, fingerprint: string, status: ClientErrorStatus): Promise<Result<ClientErrorGroup>> {
    return this.json("POST", `/v1/apps/${encodeURIComponent(app)}/client-errors/${encodeURIComponent(fingerprint)}`, { status });
  }

  listSecrets(app: string): Promise<Result<SecretList>> {
    return this.json("GET", `/v1/apps/${encodeURIComponent(app)}/secrets`);
  }

  putSecret(app: string, name: string, value: string): Promise<Result<{ name: string; version: number }>> {
    return this.json("PUT", `/v1/apps/${encodeURIComponent(app)}/secrets/${encodeURIComponent(name)}`, { value });
  }

  deleteSecret(app: string, name: string): Promise<Result<{ name: string; version: number }>> {
    return this.json("DELETE", `/v1/apps/${encodeURIComponent(app)}/secrets/${encodeURIComponent(name)}`);
  }

  /**
   * The latest lines (`GET …/logs` without `follow`: an event stream that the
   * API closes after the last line). The dashboard polls it with `since`
   * rather than holding a `follow=true` stream open, which the tenant
   * wall-clock limit would end.
   */
  async logs(app: string, opts: { since?: number; source?: "all" | "server" | "client"; deployment?: string } = {}): Promise<Result<LogLine[]>> {
    const q = new URLSearchParams();
    if (opts.since !== undefined) q.set("since", String(opts.since));
    if (opts.source !== undefined && opts.source !== "all") q.set("source", opts.source);
    if (opts.deployment !== undefined) q.set("deployment", opts.deployment);
    const qs = q.size === 0 ? "" : `?${q}`;
    const r = await this.call("GET", `/v1/apps/${encodeURIComponent(app)}/logs${qs}`);
    if (!r.ok) return r;
    return { ok: true, value: parseLogEvents(r.value.text ?? "") };
  }
}

/** The `log` events of a Server-Sent Events body; other events, comments and malformed data are skipped. */
export function parseLogEvents(body: string): LogLine[] {
  const out: LogLine[] = [];
  for (const block of body.replace(/\r\n?/gu, "\n").split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
    }
    if (event !== "log" || data.length === 0) continue;
    try {
      const v = JSON.parse(data.join("\n")) as LogLine;
      if (typeof v.ts === "number" && typeof v.message === "string" && typeof v.level === "string") out.push(v);
    } catch {
      // A malformed event is dropped, not shown.
    }
  }
  return out;
}
