// Cloudflare for SaaS custom hostnames (#419, ADR D25; deploy-api.md 0.6
// section 10). Every custom domain is a custom hostname on the platform
// domain's zone: Cloudflare proves ownership with its pre-validation TXT
// record, validates and issues the edge certificate (DCV by TXT) and serves
// the hostname through the fallback origin (the zone apex, `<platform domain>`,
// a proxied record to the tunnel; ADR D26). The control plane only creates, reads and deletes the hostname.
//
// The API token (*SSL and Certificates: Edit* on the zone) is sent in the
// Authorization header and appears in no log line, error message or answer.
// Tests use StubCloudflare (tests/domain-stubs.ts) and never call Cloudflare.

import type { CloudflareConfig } from "../config.ts";

/** A record the customer creates (the `verification` items of the contract). */
export interface VerificationRecord {
  purpose: "ownership" | "dcv";
  type: "TXT" | "CNAME" | "HTTP";
  name: string;
  value: string;
}

/** A custom hostname as Cloudflare reports it. */
export interface CustomHostname {
  id: string;
  hostname: string;
  /** `pending`, `active`, `moved`, `deleted`, `blocked`, … */
  status: string;
  /** `initializing`, `pending_validation`, `pending_issuance`, `active`, … */
  ssl_status: string;
  verification: VerificationRecord[];
  /** Cloudflare's verification and validation errors, as text. */
  errors: string[];
}

/** The four calls the domain code needs. Implemented by the client below and by StubCloudflare. */
export interface CustomHostnames {
  /** Creates the custom hostname (DV certificate, DCV by TXT); an existing one of the same name on our zone is returned instead. */
  create(hostname: string): Promise<CustomHostname>;
  /** null: Cloudflare has no such custom hostname (deleted). Throws on any failure to get an answer. */
  get(id: string): Promise<CustomHostname | null>;
  /** Deletes it; a hostname already gone is not an error. */
  delete(id: string): Promise<void>;
  /** The CNAME target customers point their hostname at. */
  readonly fallbackOrigin: string;
}

/** A Cloudflare answer that is not a result: a failure, never a verdict on the hostname. */
export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareError";
  }
}

interface ApiEnvelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: unknown;
}

interface ApiHostname {
  id?: string;
  hostname?: string;
  status?: string;
  ownership_verification?: { type?: string; name?: string; value?: string };
  ssl?: {
    status?: string;
    validation_records?: { txt_name?: string; txt_value?: string; http_url?: string; http_body?: string; cname?: string; cname_target?: string }[];
    validation_errors?: { message?: string }[];
  };
  verification_errors?: string[];
}

const text = (v: unknown, max = 4096): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Maps Cloudflare's custom hostname object to ours. */
export function fromApi(r: ApiHostname): CustomHostname {
  const verification: VerificationRecord[] = [];
  const own = r.ownership_verification;
  if (own !== undefined && text(own.name) !== "" && text(own.value) !== "") {
    verification.push({ purpose: "ownership", type: "TXT", name: text(own.name, 300), value: text(own.value) });
  }
  for (const v of r.ssl?.validation_records ?? []) {
    if (text(v.txt_name) !== "" && text(v.txt_value) !== "") verification.push({ purpose: "dcv", type: "TXT", name: text(v.txt_name, 300), value: text(v.txt_value) });
    else if (text(v.cname) !== "" && text(v.cname_target) !== "") verification.push({ purpose: "dcv", type: "CNAME", name: text(v.cname, 300), value: text(v.cname_target) });
    else if (text(v.http_url) !== "" && text(v.http_body) !== "") verification.push({ purpose: "dcv", type: "HTTP", name: text(v.http_url, 300), value: text(v.http_body) });
  }
  const status = (s: unknown, fallback: string): string => (typeof s === "string" && /^[a-z_]{1,40}$/u.test(s) ? s : fallback);
  return {
    id: text(r.id, 100),
    hostname: text(r.hostname, 253),
    status: status(r.status, "unknown"),
    ssl_status: status(r.ssl?.status, "unknown"),
    verification: verification.slice(0, 10),
    errors: [...(r.verification_errors ?? []).map((e) => text(e, 500)), ...(r.ssl?.validation_errors ?? []).map((e) => text(e.message, 500))].filter((e) => e !== "").slice(0, 10),
  };
}

/** Cloudflare's "Duplicate custom hostname found" (the hostname is already on our zone). */
const DUPLICATE = 1406;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The client of `https://api.cloudflare.com/client/v4/zones/{zone}/custom_hostnames`. */
export class CloudflareCustomHostnames implements CustomHostnames {
  readonly fallbackOrigin: string;
  private readonly base: string;

  constructor(
    private readonly config: CloudflareConfig,
    private readonly fetchFn: Fetch = (i, init) => fetch(i, init),
    private readonly timeoutMs = 10_000,
  ) {
    this.fallbackOrigin = config.fallbackOrigin;
    this.base = `${config.apiUrl}/zones/${config.zoneId}/custom_hostnames`;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; envelope: ApiEnvelope }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.config.apiToken}`, "content-type": "application/json", accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // The token is in a header, never in the message.
      throw new CloudflareError(`Cloudflare did not answer (${e instanceof Error ? e.name : "error"})`, 0);
    }
    let envelope: ApiEnvelope = {};
    try {
      envelope = (await res.json()) as ApiEnvelope;
    } catch {
      envelope = {};
    }
    return { status: res.status, envelope };
  }

  private static failure(what: string, status: number, envelope: ApiEnvelope): CloudflareError {
    const codes = (envelope.errors ?? []).map((e) => e.code).filter((c) => typeof c === "number");
    return new CloudflareError(`Cloudflare ${what} failed: HTTP ${status}${codes.length > 0 ? `, codes ${codes.join(",")}` : ""}`, status);
  }

  async create(hostname: string): Promise<CustomHostname> {
    const { status, envelope } = await this.call("POST", "", { hostname, ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } } });
    if (envelope.success === true && envelope.result !== undefined) return fromApi(envelope.result as ApiHostname);
    if ((envelope.errors ?? []).some((e) => e.code === DUPLICATE)) {
      const found = await this.call("GET", `?hostname=${encodeURIComponent(hostname)}`);
      const list = Array.isArray(found.envelope.result) ? (found.envelope.result as ApiHostname[]) : [];
      const same = list.find((r) => r.hostname === hostname);
      if (found.envelope.success === true && same !== undefined) return fromApi(same);
    }
    throw CloudflareCustomHostnames.failure("create", status, envelope);
  }

  async get(id: string): Promise<CustomHostname | null> {
    const { status, envelope } = await this.call("GET", `/${encodeURIComponent(id)}`);
    if (envelope.success === true && envelope.result !== undefined) return fromApi(envelope.result as ApiHostname);
    if (status === 404) return null;
    throw CloudflareCustomHostnames.failure("read", status, envelope);
  }

  async delete(id: string): Promise<void> {
    const { status, envelope } = await this.call("DELETE", `/${encodeURIComponent(id)}`);
    if (envelope.success === true || status === 404) return;
    throw CloudflareCustomHostnames.failure("delete", status, envelope);
  }
}
