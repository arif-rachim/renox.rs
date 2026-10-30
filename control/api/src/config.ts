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
  /** Base domain of app hostnames: <app>.<platformDomain>. */
  platformDomain: string;
  /** null: in-memory object store (tests and quick local runs only). */
  s3: S3Config | null;
  /** Base64 of the 32-byte master key (deploy-api.md section 9); null disables secrets. */
  masterKey: string | null;
  /** Base URL of the dashboard, for links in account emails (#113). */
  dashboardUrl: string;
  /** Directory where account emails are written as files (local development); null: no mail delivery. */
  mailOutboxDir: string | null;
  /** `EXPORT_KMS_KEY_ID` (#308): exports are written with SSE-KMS and this key; unset: plain puts (local mode, logged at start). */
  exportKmsKeyId?: string | null;
  /** `CONTROL_SECURITY_CONTACTS` (#310): the `Contact:` URIs of security.txt, comma separated. */
  securityContacts?: string[];
  /** `CONTROL_SECURITY_POLICY`: the `Policy:` URI of security.txt, if any. */
  securityPolicy?: string | null;
}

type Env = Record<string, string | undefined>;

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
    platformDomain: env.CONTROL_PLATFORM_DOMAIN ?? "renox.app",
    s3,
    masterKey: env.CONTROL_MASTER_KEY ?? null,
    dashboardUrl: env.CONTROL_DASHBOARD_URL ?? "https://dashboard.renox.app",
    mailOutboxDir: env.CONTROL_MAIL_OUTBOX_DIR ?? null,
    exportKmsKeyId: env.EXPORT_KMS_KEY_ID ?? null,
    securityContacts: (env.CONTROL_SECURITY_CONTACTS ?? "mailto:security@renox.app").split(",").map((s) => s.trim()).filter((s) => s !== ""),
    securityPolicy: env.CONTROL_SECURITY_POLICY ?? null,
  };
}
