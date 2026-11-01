// Configuration from the environment. Secrets (the master key, the S3 secret)
// are read here and passed only to the code that needs them; they are never
// logged (the config object has no toJSON that includes them).

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface Config {
  port: number;
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
}

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
} as const;

export class ConfigError extends Error {}

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
  return {
    port,
    databaseUrl: env.CONTROL_DATABASE_URL ?? "pglite:memory",
    operatorTokenSha256: operator,
    platformDomain: env.CONTROL_PLATFORM_DOMAIN ?? DEFAULTS.platformDomain,
    s3,
    masterKey: env.CONTROL_MASTER_KEY ?? null,
    dashboardUrl: env.CONTROL_DASHBOARD_URL ?? DEFAULTS.dashboardUrl,
    mailOutboxDir: env.CONTROL_MAIL_OUTBOX_DIR ?? null,
    erasureRetryMs: Math.max(1000, Number(env.CONTROL_ERASURE_RETRY_MS ?? 3_600_000) || 3_600_000),
    exportKmsKeyId: env.EXPORT_KMS_KEY_ID ?? null,
    securityContacts: (env.CONTROL_SECURITY_CONTACTS ?? DEFAULTS.securityContacts.join(",")).split(",").map((s) => s.trim()).filter((s) => s !== ""),
    abuseContact: env.CONTROL_ABUSE_CONTACT ?? DEFAULTS.abuseContact,
    apiUrl: env.CONTROL_API_URL ?? DEFAULTS.apiUrl,
    securityPolicy: env.CONTROL_SECURITY_POLICY ?? null,
  };
}
