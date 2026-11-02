// Configuration from the environment. Secrets (the master key, the S3 secret)
// are read here and passed only to the code that needs them; they are never
// logged (the config object has no toJSON that includes them).

import { parseProxyEntry, TrustedProxies } from "./auth/ip.ts";

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface Config {
  port: number;
  /**
   * `CONTROL_LISTEN_HOST` (#366): the address the public listener binds
   * (default `0.0.0.0`). On the single host `127.0.0.1`: only `cloudflared`
   * reaches it. Refused when it is not loopback while every trusted proxy is
   * (loadConfig), so a forged client-address header can never come from outside.
   */
  listenHost?: string;
  /** postgres://… or pglite:memory or pglite:<dir>. */
  databaseUrl: string;
  /** SHA-256 hex of the operator token; null disables the operator endpoints. */
  operatorTokenSha256: string | null;
  /** `CONTROL_PLATFORM_DOMAIN`: base domain of app hostnames, <app>.<platformDomain> (default `renoxium.app`; docs/contracts/README.md "Domains"). Never a platform service's domain. */
  platformDomain: string;
  /** null: in-memory object store (tests and quick local runs only). */
  s3: S3Config | null;
  /** Base64 of the 32-byte master key (deploy-api.md section 9); null disables secrets. */
  masterKey: string | null;
  /** `CONTROL_DASHBOARD_URL`: base URL of the dashboard, for links in emails (#113; default `https://dashboard.renoxium.com`). */
  dashboardUrl: string;
  /** Directory where account emails are written as files (local development); null: no mail delivery. */
  mailOutboxDir: string | null;
  /**
   * The mailer (#385). `CONTROL_MAIL_PROVIDER=resend|outbox`; unset: outbox when
   * `CONTROL_MAIL_OUTBOX_DIR` is set, otherwise none (as before #385).
   */
  mail?: MailConfig;
  /** How long a failed erasure step waits before its retry (#308; CONTROL_ERASURE_RETRY_MS, default one hour; the chaos harness shortens it). */
  erasureRetryMs?: number;
  /** `EXPORT_KMS_KEY_ID` (#308): exports are written with SSE-KMS and this key; unset: plain puts (local mode, logged at start). */
  exportKmsKeyId?: string | null;
  /** `CONTROL_SECURITY_CONTACTS` (#310): the `Contact:` URIs of security.txt, comma separated (default `mailto:security@renoxium.com`). */
  securityContacts?: string[];
  /** `CONTROL_ABUSE_CONTACT` (#364): the address abuse mails name for appeals (default `abuse@renoxium.com`). */
  abuseContact?: string;
  /** `CONTROL_API_URL` (#364): the public origin of this API, for the canonical URL of its security.txt (default `https://api.renoxium.com`). */
  apiUrl?: string;
  /** `CONTROL_SECURITY_POLICY`: the `Policy:` URI of security.txt, if any. */
  securityPolicy?: string | null;
  /**
   * `CONTROL_TRUSTED_PROXIES` (#366): addresses or CIDRs, comma separated, of the
   * proxies in front of the public listener (on the single host `127.0.0.1,::1`,
   * `cloudflared`). Empty by default: the socket address is the client address
   * and no header is read (src/auth/ip.ts).
   */
  trustedProxies?: string[];
  /** `CONTROL_CLIENT_IP_HEADER` (#366): the header a trusted proxy puts the client address in (default `CF-Connecting-IP`). */
  clientIpHeader?: string;
}

export type MailConfig =
  | { provider: "resend"; from: string; apiUrl: string; /** `CONTROL_RESEND_API_KEY`: never logged. */ apiKey: string }
  | { provider: "outbox"; from: string; dir: string }
  | { provider: "none"; from: string };

type Env = Record<string, string | undefined>;

/**
 * The reference deployment's values (docs/contracts/README.md, "Domains"):
 * tenant apps under `renoxium.app`, the platform's own services and mail under
 * `renoxium.com`. Every one is overridden by its variable.
 */
export const DEFAULTS = {
  platformDomain: "renoxium.app",
  dashboardUrl: "https://dashboard.renoxium.com",
  apiUrl: "https://api.renoxium.com",
  securityContacts: ["mailto:security@renoxium.com"] as readonly string[],
  abuseContact: "abuse@renoxium.com",
  clientIpHeader: "CF-Connecting-IP",
  mailFrom: "Renoxium <no-reply@renoxium.com>",
  resendApiUrl: "https://api.resend.com",
} as const;

export class ConfigError extends Error {}

/** `CONTROL_TRUSTED_PROXIES`: each entry an address or a CIDR, or the config is refused. */
function trustedProxies(raw: string | undefined): string[] {
  const entries = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  for (const entry of entries) {
    if (parseProxyEntry(entry) === null) throw new ConfigError(`CONTROL_TRUSTED_PROXIES: not an address or a CIDR: ${entry}`);
  }
  return entries;
}

/**
 * The mail keys (#385). A Resend key is `re_` and letters, digits and `_`; the
 * message of a refusal never repeats the value.
 */
function mailConfig(env: Env): MailConfig {
  const from = env.CONTROL_MAIL_FROM ?? DEFAULTS.mailFrom;
  if (/[\r\n]/u.test(from) || !/^[^<>@]*<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/u.test(from.trim())) {
    throw new ConfigError("CONTROL_MAIL_FROM must be an address like Renoxium <no-reply@renoxium.com>");
  }
  const provider = env.CONTROL_MAIL_PROVIDER;
  const dir = env.CONTROL_MAIL_OUTBOX_DIR;
  switch (provider) {
    case undefined:
      return dir === undefined ? { provider: "none", from } : { provider: "outbox", from, dir };
    case "outbox":
      if (dir === undefined || dir === "") throw new ConfigError("CONTROL_MAIL_PROVIDER=outbox needs CONTROL_MAIL_OUTBOX_DIR");
      return { provider: "outbox", from, dir };
    case "resend": {
      const apiKey = env.CONTROL_RESEND_API_KEY ?? "";
      if (apiKey === "") throw new ConfigError("CONTROL_MAIL_PROVIDER=resend needs CONTROL_RESEND_API_KEY");
      if (!/^re_[A-Za-z0-9_]{8,200}$/u.test(apiKey)) throw new ConfigError("CONTROL_RESEND_API_KEY is not a Resend API key (re_…)");
      const apiUrl = (env.CONTROL_RESEND_API_URL ?? DEFAULTS.resendApiUrl).replace(/\/+$/u, "");
      let url: URL;
      try {
        url = new URL(apiUrl);
      } catch {
        throw new ConfigError("CONTROL_RESEND_API_URL is not a URL");
      }
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new ConfigError("CONTROL_RESEND_API_URL must be https:// (http:// only to loopback)");
      if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new ConfigError("CONTROL_RESEND_API_URL must be an origin and path only");
      return { provider: "resend", from, apiUrl, apiKey };
    }
    default:
      throw new ConfigError("CONTROL_MAIL_PROVIDER must be resend or outbox");
  }
}

/** True for an address only this host can reach: 127.0.0.0/8, ::1, `localhost`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  if (h === "localhost") return true;
  return parseProxyEntry(h) !== null && new TrustedProxies([h]).loopbackOnly();
}

/**
 * The start-up check of #366 scope 2: with trusted proxies that are all on
 * loopback (`cloudflared` on the same host), the public listener must be on
 * loopback too. Otherwise a client on the network could connect from a
 * non-proxy address, which is harmless, or the proxy list could be widened
 * later without anyone noticing that the listener faces the internet.
 */
export function checkListen(listenHost: string, proxies: string[]): void {
  if (proxies.length === 0) return;
  if (new TrustedProxies(proxies).loopbackOnly() && !isLoopbackHost(listenHost)) {
    throw new ConfigError(`CONTROL_LISTEN_HOST ${listenHost} is not a loopback address while CONTROL_TRUSTED_PROXIES is loopback only: set CONTROL_LISTEN_HOST=127.0.0.1`);
  }
}

/** `CONTROL_CLIENT_IP_HEADER`: an HTTP header name (RFC 9110 token). */
function clientIpHeader(raw: string | undefined): string {
  const header = (raw ?? DEFAULTS.clientIpHeader).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(header)) throw new ConfigError("CONTROL_CLIENT_IP_HEADER is not a header name");
  return header;
}

export function loadConfig(env: Env = process.env): Config {
  const s3 = env.CONTROL_S3_ENDPOINT
    ? {
        endpoint: env.CONTROL_S3_ENDPOINT,
        bucket: env.CONTROL_S3_BUCKET ?? "renox-artifacts",
        region: env.CONTROL_S3_REGION ?? "me-central-1",
        accessKeyId: env.CONTROL_S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: env.CONTROL_S3_SECRET_ACCESS_KEY ?? "",
      }
    : null;
  const operator = env.CONTROL_OPERATOR_TOKEN_SHA256 ?? null;
  if (operator !== null && !/^[0-9a-f]{64}$/u.test(operator)) {
    throw new ConfigError("CONTROL_OPERATOR_TOKEN_SHA256 must be 64 lower-case hex characters");
  }
  const port = Number(env.CONTROL_LISTEN_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("CONTROL_LISTEN_PORT is not a port");
  const listenHost = (env.CONTROL_LISTEN_HOST ?? "0.0.0.0").trim();
  if (listenHost === "") throw new ConfigError("CONTROL_LISTEN_HOST is empty");
  const proxies = trustedProxies(env.CONTROL_TRUSTED_PROXIES);
  checkListen(listenHost, proxies);
  return {
    port,
    listenHost,
    databaseUrl: env.CONTROL_DATABASE_URL ?? "pglite:memory",
    operatorTokenSha256: operator,
    platformDomain: env.CONTROL_PLATFORM_DOMAIN ?? DEFAULTS.platformDomain,
    s3,
    masterKey: env.CONTROL_MASTER_KEY ?? null,
    dashboardUrl: env.CONTROL_DASHBOARD_URL ?? DEFAULTS.dashboardUrl,
    mailOutboxDir: env.CONTROL_MAIL_OUTBOX_DIR ?? null,
    mail: mailConfig(env),
    erasureRetryMs: Math.max(1000, Number(env.CONTROL_ERASURE_RETRY_MS ?? 3_600_000) || 3_600_000),
    exportKmsKeyId: env.EXPORT_KMS_KEY_ID ?? null,
    securityContacts: (env.CONTROL_SECURITY_CONTACTS ?? DEFAULTS.securityContacts.join(",")).split(",").map((s) => s.trim()).filter((s) => s !== ""),
    abuseContact: env.CONTROL_ABUSE_CONTACT ?? DEFAULTS.abuseContact,
    apiUrl: env.CONTROL_API_URL ?? DEFAULTS.apiUrl,
    securityPolicy: env.CONTROL_SECURITY_POLICY ?? null,
    trustedProxies: proxies,
    clientIpHeader: clientIpHeader(env.CONTROL_CLIENT_IP_HEADER),
  };
}
