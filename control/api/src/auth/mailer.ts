// Account email (#113): address verification, password reset, new-device and
// new-token notices, invitations, owner transfer. The API only composes
// messages; delivery is a Mailer: Resend in production (#385), a file outbox
// in local development, or nothing. Links carry single-use tokens, so a message
// body is never logged: the log line names the kind and the request only.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import type { MailConfig } from "../config.ts";

export type MailKind =
  | "verify_email"
  | "password_reset"
  | "password_changed"
  | "signup_exists"
  | "new_device"
  | "token_created"
  | "invitation"
  | "owner_transfer"
  // Custom domains (src/domains/reverify.ts, #114).
  | "domain_detached"
  // Tenant erasure completed (src/tenants/erasure.ts, #308).
  | "tenant_erased"
  // Break-glass impersonation started and ended (src/ops/breakglass.ts, #310).
  | "breakglass_started"
  | "breakglass_ended"
  // A registry module version an app uses was disabled (src/registry/routes.ts, #324).
  | "module_disabled"
  // The tier machine's steps (src/billing/sweep.ts, #325).
  | "tier_over_quota"
  | "tier_grace"
  | "tier_suspended"
  | "tier_reinstated"
  // An off-session charge of an invoice failed (src/billing/collect.ts, #350).
  | "invoice_payment_failed"
  // An abuse takedown (src/abuse/takedown.ts, #123).
  | "abuse_takedown";

export interface Mail {
  to: string;
  kind: MailKind;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Keeps messages in memory, for tests. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
  /** The last message of `kind` to `to`. */
  last(to: string, kind: MailKind): Mail | undefined {
    return this.sent.filter((m) => m.to === to && m.kind === kind).at(-1);
  }
}

/** Writes each message to a file readable only by the API's user (local development). */
export class OutboxDirMailer implements Mailer {
  private n = 0;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  async send(mail: Mail): Promise<void> {
    const file = join(this.dir, `${Date.now()}-${++this.n}-${mail.kind}.txt`);
    writeFileSync(file, `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`, { mode: 0o600 });
  }
}

/** Drops messages; logs that one was dropped, never its body. */
export class NullMailer implements Mailer {
  constructor(private readonly log: Logger) {}
  async send(mail: Mail): Promise<void> {
    this.log.warn("mail dropped: no mailer configured", { kind: mail.kind });
  }
}

/** What a failed delivery reports: the mail kind and the HTTP status (or the network failure), never the key or the body. */
export class MailDeliveryError extends Error {
  constructor(
    readonly kind: MailKind,
    readonly status: number | null,
    readonly attempts: number,
  ) {
    super(`mail ${kind} not delivered after ${attempts} attempt(s): ${status === null ? "no answer" : `HTTP ${status}`}`);
    this.name = "MailDeliveryError";
  }
}

export interface ResendOptions {
  /** `CONTROL_RESEND_API_KEY`: never logged, never in an error. */
  apiKey: string;
  /** `CONTROL_MAIL_FROM`, e.g. `Renoxium <no-reply@renoxium.com>`. */
  from: string;
  /** `CONTROL_RESEND_API_URL` (default `https://api.resend.com`). */
  apiUrl?: string;
  /** Attempts in all, the first included (default 4). */
  attempts?: number;
  /** Per-attempt timeout in ms (default 5,000). */
  timeoutMs?: number;
  /** First backoff in ms, doubled per retry (default 500). */
  backoffMs?: number;
  /** The longest wait between attempts, `Retry-After` included (default 5,000 ms). */
  maxWaitMs?: number;
  /** Replaced in tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Sends through Resend's HTTP API (`POST /emails`, #385). One idempotency key
 * per message, so a retry after a lost answer never sends twice. Retries a
 * network error, a timeout, 429 (after `Retry-After`, capped) and 5xx with
 * exponential backoff; any other 4xx is final. Callers await `send` inside a
 * request, so the total time is bounded: with the defaults at most four
 * attempts of 5 s and 3.5 s of waiting. A failure throws MailDeliveryError,
 * which names the kind and the status only: the key, the recipient's message
 * (its links hold single-use tokens) and Resend's answer never reach an
 * error or a log line.
 */
export class ResendMailer implements Mailer {
  private readonly url: string;
  private readonly attempts: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly maxWaitMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ResendOptions) {
    this.url = `${(options.apiUrl ?? "https://api.resend.com").replace(/\/+$/u, "")}/emails`;
    this.attempts = Math.max(1, options.attempts ?? 4);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.backoffMs = options.backoffMs ?? 500;
    this.maxWaitMs = options.maxWaitMs ?? 5_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  /** The key stays out of `JSON.stringify` and `console.log` of the mailer. */
  toJSON(): Record<string, string> {
    return { provider: "resend", from: this.options.from };
  }

  async send(mail: Mail): Promise<void> {
    const body = JSON.stringify({ from: this.options.from, to: [mail.to], subject: mail.subject, text: mail.text });
    const idempotencyKey = `${mail.kind}/${crypto.randomUUID()}`;
    let status: number | null = null;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      let retryAfterMs: number | null = null;
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            "user-agent": "renoxium-control-api",
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "error",
        });
        status = res.status;
        // The answer is read and dropped: it may echo the message.
        await res.arrayBuffer().catch(() => undefined);
        if (res.ok) return;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) throw new MailDeliveryError(mail.kind, res.status, attempt);
        if (res.status === 429) retryAfterMs = retryAfter(res.headers.get("retry-after"));
      } catch (e) {
        if (e instanceof MailDeliveryError) throw e;
        // A network error or the timeout: retried.
        status = null;
      }
      if (attempt < this.attempts) {
        const backoff = this.backoffMs * 2 ** (attempt - 1);
        await this.sleep(Math.min(this.maxWaitMs, Math.max(backoff, retryAfterMs ?? 0)));
      }
    }
    throw new MailDeliveryError(mail.kind, status, this.attempts);
  }
}

/** `Retry-After` in seconds or as an HTTP date, in ms; null when absent or unreadable. */
function retryAfter(value: string | null): number | null {
  if (value === null) return null;
  if (/^\d+$/u.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * The mailer main.ts uses (#385): `CONTROL_MAIL_PROVIDER` picks Resend or the
 * outbox; unset, the outbox when `CONTROL_MAIL_OUTBOX_DIR` is set, otherwise
 * none, as before. The log line names the provider and the sender, never the key.
 */
export function mailerFor(mail: MailConfig, log: Logger): Mailer {
  switch (mail.provider) {
    case "resend":
      log.info("mail", { provider: "resend", from: mail.from });
      return new ResendMailer({ apiKey: mail.apiKey, from: mail.from, apiUrl: mail.apiUrl });
    case "outbox":
      log.info("mail", { provider: "outbox" });
      return new OutboxDirMailer(mail.dir);
    case "none":
      log.warn("CONTROL_MAIL_PROVIDER and CONTROL_MAIL_OUTBOX_DIR are not set: account emails are dropped");
      return new NullMailer(log);
  }
}

/** A token in a link: the dashboard page reads it from the fragment, so it never reaches a server log. */
export const link = (base: string, page: string, token: string): string => `${base.replace(/\/+$/u, "")}/${page}#token=${token}`;
