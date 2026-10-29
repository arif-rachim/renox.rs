// renox login [--api <url>] [--with-token]
//
// Signs the CLI in to the control plane (#113) with the device flow: the CLI
// shows a code, the user approves it in a signed-in dashboard session, and
// the CLI receives a token scoped to the user's role (90 days). `--with-token`
// reads an existing `renox_pat_` token from stdin instead (CI).
//
// The token is stored in $XDG_CONFIG_HOME/renox/credentials.json (default
// ~/.config/renox/), readable only by the user. RENOX_TOKEN and RENOX_API_URL
// override the file, so CI never writes one.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { type CliError, EnvironmentError, EXIT, UserError, ValidationError } from "../errors.ts";

export const DEFAULT_API = "https://api.renox.app";
const TOKEN = /^renox_pat_[a-z2-7]{32}$/u;

export interface Credentials {
  api: string;
  token: string;
  tenant_id?: string;
  token_id?: string;
  expires_at?: number;
}

type Env = Record<string, string | undefined>;

export const credentialsPath = (env: Env = process.env): string =>
  join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "renox", "credentials.json");

export function readCredentials(env: Env = process.env): Credentials | null {
  const file = credentialsPath(env);
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as Credentials;
    return typeof c.api === "string" && typeof c.token === "string" ? c : null;
  } catch {
    return null;
  }
}

export function writeCredentials(c: Credentials, env: Env = process.env): string {
  const file = credentialsPath(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** The API and token every authenticated command uses: RENOX_TOKEN / RENOX_API_URL first, then the credentials file. */
export function apiAuth(env: Env = process.env): { api: string; token: string } {
  const saved = readCredentials(env);
  const token = env.RENOX_TOKEN ?? saved?.token;
  const api = env.RENOX_API_URL ?? saved?.api ?? DEFAULT_API;
  if (token === undefined) throw new UserError("not signed in", { hint: "run `renox login`, or set RENOX_TOKEN" });
  if (!TOKEN.test(token)) throw new UserError("RENOX_TOKEN is not a renox_pat_ token");
  return { api: api.replace(/\/+$/u, ""), token };
}

export interface Io {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  readStdin: () => Promise<string>;
  env: Env;
}

export const defaultIo = (): Io => ({
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => Bun.sleep(ms),
  out: (line) => console.log(line),
  readStdin: () => Bun.stdin.text(),
  env: process.env,
});

/** POST a JSON body; a network failure is an environment error (exit 3). */
export async function post(io: Io, url: string, body: unknown, token?: string): Promise<Response> {
  try {
    return await io.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new EnvironmentError(`cannot reach ${new URL(url).origin}: ${(e as Error).message}`, { hint: "check the address (--api or RENOX_API_URL) and your network" });
  }
}

/** The error body of the deploy API (deploy-api.md section 1). */
export interface ApiErrorBody {
  code: string;
  message: string;
  request_id?: string;
  deployment?: string;
  details?: Record<string, unknown>[];
}

/** The `error` object of a non-2xx answer, or a stand-in when the body is not one. */
export async function errorBody(res: Response): Promise<ApiErrorBody> {
  try {
    const body = (await res.json()) as { error?: Partial<ApiErrorBody> };
    if (typeof body.error?.code === "string") return { message: `HTTP ${res.status}`, ...body.error } as ApiErrorBody;
  } catch {
    // not JSON: keep the status
  }
  return { code: "", message: `HTTP ${res.status}` };
}

/**
 * The CLI error for an API error, by the exit code contract (cli/README.md,
 * "Exit codes"): 401, 403, 404, 409 and 400 are the caller's (1); a rejected
 * artifact or a failed activation is the app's (2); 5xx, 429 and an
 * unreachable API are the environment's (3).
 */
export function cliErrorOf(status: number, e: ApiErrorBody): CliError {
  const details = (e.details ?? []).map((d) =>
    Object.entries(d)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" "),
  );
  const text = `${e.message}${e.code === "" ? "" : ` (${e.code})`}${details.length === 0 ? "" : `\n    ${details.join("\n    ")}`}`;
  if (status === 401) return new UserError(text, { hint: "the token expired or was revoked: run `renox login`" });
  if (status === 403) return new UserError(text, { hint: "the token or your role does not allow this" });
  if (e.code === "RENOX_DEPLOY_REJECTED" || e.code === "RENOX_ACTIVATION_FAILED") return new ValidationError(text);
  if (status >= 500 || status === 429) return new EnvironmentError(text);
  return new UserError(text);
}

/** One authenticated request to the control API; a network failure is an environment error (exit 3). */
export async function apiRequest(io: Io, method: string, path: string, init: { json?: unknown; body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  const { api, token } = apiAuth(io.env);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...init.headers };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.body !== undefined) body = init.body;
  try {
    return await io.fetch(`${api}${path}`, { method, headers, ...(body === undefined ? {} : { body }), ...(init.signal === undefined ? {} : { signal: init.signal }) });
  } catch (e) {
    throw new EnvironmentError(`cannot reach ${api}: ${(e as Error).message}`, { hint: "check the address (RENOX_API_URL or `renox login --api`) and your network" });
  }
}

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function login(api: string, io: Io): Promise<Credentials> {
  const started = await post(io, `${api}/v1/account/device`, { name: `renox CLI on ${hostname()}`.slice(0, 64) });
  if (started.status !== 201) throw new EnvironmentError(`the control plane answered ${started.status} to the login request`);
  const d = (await started.json()) as DeviceStart;
  io.out(`Open ${d.verification_uri} and enter the code ${d.user_code}`);
  io.out("Waiting for approval…");
  let interval = Math.max(1, d.interval) * 1000;
  const deadline = Date.now() + d.expires_in * 1000;
  while (Date.now() < deadline) {
    await io.sleep(interval);
    const res = await post(io, `${api}/v1/account/device/token`, { device_code: d.device_code });
    if (res.status === 202) continue;
    if (res.status === 429) {
      interval += 5000;
      continue;
    }
    if (res.status === 404) break;
    if (res.status !== 201) throw new EnvironmentError(`the control plane answered ${res.status} while waiting for approval`);
    const t = (await res.json()) as { token: string; id: string; tenant_id: string; expires_at: number };
    return { api, token: t.token, tenant_id: t.tenant_id, token_id: t.id, expires_at: t.expires_at };
  }
  throw new UserError("the login code expired before it was approved", { hint: "run `renox login` again" });
}

export async function run(args: string[], io: Io = defaultIo()): Promise<number> {
  let api = io.env.RENOX_API_URL ?? DEFAULT_API;
  let withToken = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--api") api = args[++i] ?? "";
    else if (a === "--with-token") withToken = true;
    else throw new UserError(`unknown argument ${JSON.stringify(a)}`, { hint: "usage: renox login [--api <url>] [--with-token]" });
  }
  if (!/^https?:\/\/[^/\s]+/u.test(api)) throw new UserError(`--api ${JSON.stringify(api)} is not a URL`);
  api = api.replace(/\/+$/u, "");
  let creds: Credentials;
  if (withToken) {
    const token = (await io.readStdin()).trim();
    if (!TOKEN.test(token)) throw new UserError("stdin does not hold a renox_pat_ token");
    creds = { api, token };
  } else creds = await login(api, io);
  const file = writeCredentials(creds, io.env);
  io.out(`Signed in${creds.tenant_id === undefined ? "" : ` to ${creds.tenant_id}`}. Token saved to ${file}`);
  return EXIT.OK;
}
