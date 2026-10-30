// Account email (#113): address verification, password reset, new-device and
// new-token notices, invitations, owner transfer. The API only composes
// messages; delivery is a Mailer. Links carry single-use tokens, so a message
// body is never logged: the log line names the kind and the request only.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";

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
  | "tier_reinstated";

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

/** A token in a link: the dashboard page reads it from the fragment, so it never reaches a server log. */
export const link = (base: string, page: string, token: string): string => `${base.replace(/\/+$/u, "")}/${page}#token=${token}`;
