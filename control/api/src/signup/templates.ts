// `createAppFromTemplate` (#326; deploy-api.md 0.5 section 21): the first
// app of a new tenant in one call. The templates are artifacts built from
// `examples/` ahead of time and kept under `CONTROL_TEMPLATES_DIR`, one
// directory per template (`<dir>/<template>/manifest.json`, or the
// `<hash>/` directory `renox build --out <dir>/<template>` writes).
//
// An artifact's manifest names its app (artifact.md rule V3), so the
// template's `app.name` is set to the new app's name, which gives the tree a
// hash of its own. The app is then created, the tree uploaded and activated
// through the API's own routes with the caller's credentials, so their
// validation, scope checks and audit rows apply unchanged.
//
// The `home-services` template (#689) takes an optional `setup` (the company,
// branches, services and first people). After activation the API calls the
// app's own `POST /api/setup` with a one-time token (`mintSetupToken`, below;
// deploy-api.md section 21), so the app starts with the company's data and
// never loads its demo seed.
//
//   bun control/api/src/signup/templates.ts <out>   builds the templates from examples/ into <out>

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { contentHash, writeTar } from "@renox/artifact-validate";
import type { Context, Hono } from "hono";

import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import { check } from "../contract.ts";
import type { Deps, Env } from "../context.ts";
import { ApiError, conflict, invalid, MESSAGES } from "../errors.ts";
import { readBody } from "../http.ts";
import { MasterKeyProvider } from "../secrets/crypto.ts";
import { masterKeys } from "../secrets/master.ts";
import { putSecret } from "../secrets/store.ts";
import { requestScope, tenantDb } from "../tenancy/scope.ts";

/** deploy-api.yaml `createAppFromTemplate` `template`. */
export const TEMPLATES = ["hello", "shop", "booking", "invoices", "home-services"] as const;
export type Template = (typeof TEMPLATES)[number];

/** The template that takes a `setup` (deploy-api.md section 21). */
export const SETUP_TEMPLATE: Template = "home-services";
/** The app secret that carries the app's setup key. */
export const SETUP_SECRET = "SETUP_KEY";
/** Life of a setup token. */
export const SETUP_TOKEN_TTL_MS = 600_000;
/** How long the API waits for the app's `/api/setup`. */
const SETUP_CALL_TIMEOUT_MS = 30_000;
const MAX_BODY = 65_536;

export const EMIRATES = ["abu_dhabi", "dubai", "sharjah", "ajman", "umm_al_quwain", "ras_al_khaimah", "fujairah"] as const;
export const PEOPLE_ROLES = ["owner", "manager", "dispatcher", "technician", "accountant"] as const;

/** `Setup` of docs/20-ai-agents-mcp.md section 1b and deploy-api.yaml `HomeServicesSetup`. */
export interface Setup {
  company: { name: string; trn?: string; phone: string; emirate: string };
  branches: { name: string; emirate: string }[];
  services: { name: string; price_aed: number }[];
  people: { email: string; role: string }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Only the listed keys, or 400 naming the path. */
function keysOnly(o: Obj, allowed: string[], path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw invalid(`${path}.${k}`, "unknown field");
}

function text(v: unknown, path: string, max = 80): string {
  if (typeof v !== "string") throw invalid(path, "must be a string");
  const t = v.trim();
  if (t.length < 1 || [...t].length > max) throw invalid(path, `1 to ${max} characters`);
  return t;
}

function oneOf(v: unknown, path: string, allowed: readonly string[]): string {
  if (typeof v !== "string" || !allowed.includes(v)) throw invalid(path, `one of ${allowed.join(", ")}`);
  return v;
}

function list(v: unknown, path: string, min: number, max: number): Obj[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw invalid(path, `${min} to ${max} items`);
  return v.map((x, i) => {
    if (!isObj(x)) throw invalid(`${path}[${i}]`, "must be an object");
    return x;
  });
}

/** The validated, trimmed `setup`, or 400 (`details[0].field` names the path). */
export function parseSetup(v: unknown): Setup {
  if (!isObj(v)) throw invalid("setup", "must be an object");
  keysOnly(v, ["company", "branches", "services", "people"], "setup");
  if (!isObj(v.company)) throw invalid("setup.company", "must be an object");
  keysOnly(v.company, ["name", "trn", "phone", "emirate"], "setup.company");
  const company: Setup["company"] = {
    name: text(v.company.name, "setup.company.name"),
    phone: "",
    emirate: oneOf(v.company.emirate, "setup.company.emirate", EMIRATES),
  };
  if (v.company.trn !== undefined) {
    if (typeof v.company.trn !== "string" || !/^[0-9]{15}$/u.test(v.company.trn.trim())) throw invalid("setup.company.trn", "15 digits");
    company.trn = v.company.trn.trim();
  }
  const phone = typeof v.company.phone === "string" ? v.company.phone.trim() : "";
  if (!/^\+[1-9][0-9]{7,14}$/u.test(phone)) throw invalid("setup.company.phone", "E.164, for example +971501234567");
  company.phone = phone;
  const branches = list(v.branches, "setup.branches", 1, 5).map((b, i) => {
    keysOnly(b, ["name", "emirate"], `setup.branches[${i}]`);
    return { name: text(b.name, `setup.branches[${i}].name`), emirate: oneOf(b.emirate, `setup.branches[${i}].emirate`, EMIRATES) };
  });
  const services = list(v.services, "setup.services", 1, 50).map((s, i) => {
    keysOnly(s, ["name", "price_aed"], `setup.services[${i}]`);
    const price = s.price_aed;
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1_000_000) throw invalid(`setup.services[${i}].price_aed`, "a number from 0 to 1000000");
    return { name: text(s.name, `setup.services[${i}].name`), price_aed: price };
  });
  const seen = new Set<string>();
  const people = list(v.people, "setup.people", 0, 20).map((p, i) => {
    keysOnly(p, ["email", "role"], `setup.people[${i}]`);
    const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw invalid(`setup.people[${i}].email`, "must be an email address");
    if (seen.has(email)) throw invalid(`setup.people[${i}].email`, "listed twice");
    seen.add(email);
    return { email, role: oneOf(p.role, `setup.people[${i}].role`, PEOPLE_ROLES) };
  });
  return { company, branches, services, people };
}

/**
 * The app's setup key (deploy-api.md section 21): HKDF-SHA256 of the current
 * master key, bound to the tenant and the app, base64url. The API stores it as
 * the app secret `SETUP_KEY`; tenant code never sees the master key.
 */
export function setupKey(master: Buffer, tenantId: string, app: string): string {
  return Buffer.from(hkdfSync("sha256", master, "renox-setup", `renox-setup-key-v1:${tenantId}:${app}`, 32)).toString("base64url");
}

/**
 * The one-time token `v1.<app>.<hash>.<exp_ms>.<base64url HMAC-SHA256>`: the
 * HMAC covers the text before the last dot, its key is the UTF-8 bytes of the
 * `SETUP_KEY` secret. Sent in the header `x-renox-setup`.
 */
export function mintSetupToken(key: string, app: string, hash: string, now: number): string {
  const body = `v1.${app}.${hash}.${now + SETUP_TOKEN_TTL_MS}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** True when `token` was minted with `key` for exactly this app and deployment hash and has not expired. The app side mirrors this. */
export function verifySetupToken(key: string, token: string, app: string, hash: string, now: number): boolean {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return false;
  const [, tokenApp, tokenHash, exp, mac] = parts as [string, string, string, string, string];
  const want = createHmac("sha256", key).update(parts.slice(0, 4).join(".")).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  return tokenApp === app && tokenHash === hash && /^[0-9]{1,16}$/u.test(exp) && Number(exp) > now;
}

/** What the API sends to the app's `/api/setup`: injectable for tests (`Deps.callApp`). */
export type CallApp = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ status: number; body: unknown }>;

const defaultCallApp: CallApp = async (url, init) => {
  const res = await fetch(url, { method: "POST", headers: init.headers, body: init.body, redirect: "error", signal: AbortSignal.timeout(SETUP_CALL_TIMEOUT_MS) });
  let body: unknown = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

/** Every file of an artifact tree, by its path inside the tree. */
function readTree(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const visit = (p: string): void => {
    for (const name of readdirSync(p).sort()) {
      const full = join(p, name);
      if (statSync(full).isDirectory()) visit(full);
      else files.set(relative(dir, full), new Uint8Array(readFileSync(full)));
    }
  };
  visit(dir);
  return files;
}

/** The template's artifact tree, or null when it was not built into `root`. */
export function templateFiles(root: string | undefined, template: Template): Map<string, Uint8Array> | null {
  if (root === undefined || root === "") return null;
  let dir = join(root, template);
  if (!existsSync(dir)) return null;
  if (!existsSync(join(dir, "manifest.json"))) {
    // `renox build --out` writes one `<hash>/` directory.
    const inner = readdirSync(dir).filter((n) => /^[0-9a-f]{64}$/u.test(n));
    if (inner.length !== 1) return null;
    dir = join(dir, inner[0] as string);
  }
  return readTree(dir);
}

/** The tree with `app.name` set to `app` (rule V3); its hash changes with it. */
export function renamed(files: ReadonlyMap<string, Uint8Array>, app: string, secrets: string[] = []): Map<string, Uint8Array> {
  const out = new Map(files);
  const raw = files.get("manifest.json");
  if (raw === undefined) throw new Error("a template without manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as { app: { name: string }; permissions?: { secrets?: string[] } };
  manifest.app.name = app;
  // A secret the API delivers (the setup key) must be declared, or the node does not hand it to the app.
  if (secrets.length > 0) {
    manifest.permissions ??= {};
    manifest.permissions.secrets = [...new Set([...(manifest.permissions.secrets ?? []), ...secrets])];
  }
  out.set("manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  return out;
}

/** The caller's credentials and request headers, for the API's own routes. */
function forwarded(c: Context<Env>): Record<string, string> {
  const out: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    if (k !== "content-type" && k !== "content-length" && k !== "host") out[k] = v;
  });
  return out;
}

export function registerTemplates(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/apps/from-template", operation(deps, "createAppFromTemplate"), tenantAuth(deps, "apps:write"), async (c) => {
    if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, MAX_BODY))) as Record<string, unknown>;
    } catch {
      throw invalid("body", "must be a JSON object");
    }
    if (!isObj(b)) throw invalid("body", "must be a JSON object");
    if (Object.keys(b).some((k) => k !== "name" && k !== "template" && k !== "setup")) throw invalid("body", "only name, template and setup");
    let name: string;
    try {
      name = check<string>("AppName", b.name);
    } catch {
      throw invalid("name", "must be an app name");
    }
    const template = TEMPLATES.find((t) => t === b.template);
    if (template === undefined) throw invalid("template", `one of ${TEMPLATES.join(", ")}`);
    if (b.setup !== undefined && template !== SETUP_TEMPLATE) throw invalid("setup", `only for the ${SETUP_TEMPLATE} template`);
    const setup = b.setup === undefined ? null : parseSetup(b.setup);
    const files = templateFiles(process.env.CONTROL_TEMPLATES_DIR, template);
    if (files === null) throw conflict("template", "not available on this control plane");
    // Everything the setup needs is checked before anything is created.
    let secret: { key: string; ownerEmail: string } | null = null;
    const t = tenantDb(deps, c);
    if (setup !== null) {
      const keys = masterKeys(deps);
      if (keys === null) throw new ApiError("RENOX_UNAVAILABLE", undefined, { retryAfter: 60 });
      const userId = (c.get("principal") as { userId?: string | null } | undefined)?.userId ?? null;
      const rows =
        userId === null
          ? []
          : await t.query<{ email: string }>("select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.user_id = $2 and u.email_verified_at is not null", [t.tenantId, userId]);
      const email = rows[0]?.email;
      if (email === undefined) throw invalid("setup", "needs a signed-in account with a verified email address: it becomes the app's first owner");
      secret = { key: setupKey(keys.current.key, t.tenantId, name), ownerEmail: email };
    }
    const tree = renamed(files, name, setup === null ? [] : [SETUP_SECRET]);
    const hash = contentHash(tree);
    const headers = forwarded(c);
    const step = (method: string, path: string, body: BodyInit, type: string, extra: Record<string, string> = {}) =>
      // Each step is a request of its own, outside this request's tenant scope.
      requestScope.exit(() => app.request(path, { method, headers: { ...headers, "content-type": type, ...extra }, body }, c.env));
    // 1. The app; 409 when the name is taken, answered as it is.
    const created = await step("POST", "/v1/apps", JSON.stringify({ name }), "application/json");
    if (created.status !== 201) return created;
    const view = (await created.json()) as { hostnames?: string[] };
    // 2. The template's tree, validated like any upload.
    const uploaded = await step("POST", `/v1/apps/${encodeURIComponent(name)}/deployments`, writeTar(tree), "application/x-tar", { "x-renox-artifact-hash": hash });
    if (uploaded.status !== 201 && uploaded.status !== 200) return uploaded;
    // 3. The setup key as an app secret, through the secrets store (encrypted like every secret), before activation pins the secret version.
    if (secret !== null) {
      const provider = new MasterKeyProvider(masterKeys(deps) as NonNullable<ReturnType<typeof masterKeys>>);
      const value = secret.key;
      await t.transaction((tx) => putSecret(tx, provider, t.tenantId, name, SETUP_SECRET, value, deps.now()));
    }
    // 4. Activation; 503 when no node is healthy.
    const activated = await step("POST", `/v1/apps/${encodeURIComponent(name)}/activate`, JSON.stringify({ hash }), "application/json");
    if (activated.status !== 200) return activated;
    const host = view.hostnames?.[0] ?? `${name}.${deps.config.platformDomain}`;
    const url = `https://${host}`;
    if (setup === null || secret === null) {
      c.set("auditTarget", { app: name, template, hash });
      return c.json({ app: name, template, hash, url }, 201);
    }
    // 5. The app's own setup entry point, with a one-time token. The app is live whatever happens here.
    let reason: string | null = null;
    let answer: unknown = null;
    try {
      const token = mintSetupToken(secret.key, name, hash, deps.now());
      const r = await (deps.callApp ?? defaultCallApp)(`${url}/api/setup`, {
        headers: { "content-type": "application/json", "x-renox-setup": token },
        body: JSON.stringify({ ...setup, owner: { email: secret.ownerEmail } }),
      });
      if (r.status >= 200 && r.status < 300) answer = r.body;
      else reason = r.status === 409 ? "already_set_up" : `app_status_${r.status}`;
    } catch (e) {
      reason = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "unreachable";
    }
    c.set("auditTarget", { app: name, template, hash, setup: reason ?? "ok" });
    if (reason !== null) {
      return c.json(
        { error: { code: "RENOX_SETUP_FAILED", message: MESSAGES.RENOX_SETUP_FAILED, request_id: c.get("requestId"), details: [{ field: "setup", reason }] }, app: name, template, hash, url },
        502,
      );
    }
    const pick = (k: string): { email: string; role?: string; reason?: string }[] => {
      const v = isObj(answer) ? answer[k] : undefined;
      return Array.isArray(v) ? v.filter(isObj).map((x) => ({ email: String(x.email), ...(x.role === undefined ? {} : { role: String(x.role) }), ...(x.reason === undefined ? {} : { reason: String(x.reason) }) })).slice(0, 20) : [];
    };
    return c.json({ app: name, template, hash, url, setup: { invited: pick("invited"), skipped: pick("skipped") } }, 201);
  });
}

if (import.meta.main) {
  const out = process.argv[2];
  if (out === undefined) {
    process.stderr.write("usage: templates.ts <out>\n");
    process.exit(2);
  }
  const { buildArtifact } = await import("../../../../cli/src/lib/build.ts");
  const examples = new URL("../../../../examples/", import.meta.url).pathname;
  for (const t of TEMPLATES) {
    if (!existsSync(join(examples, t, "renox.toml"))) {
      process.stderr.write(`skip ${t}: no examples/${t}\n`);
      continue;
    }
    const r = await buildArtifact(join(examples, t), join(out, t));
    process.stdout.write(`${t} ${r.hash}\n`);
  }
}
