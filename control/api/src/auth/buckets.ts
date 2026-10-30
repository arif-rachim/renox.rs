// Token buckets for the unauthenticated account endpoints (#113: login,
// sign-up, password reset, device login) and for tenant tokens (#275).
// control/api is not behind renox-gateway (gate F1 notes on #113), so the
// buckets live here, per API process, keyed by client address, by email,
// and by token id.

import type { Deps } from "../context.ts";

export interface BucketRule {
  /** Requests allowed at once. */
  burst: number;
  /** Seconds to earn one request back. */
  everySeconds: number;
}

/** deploy-api.md section 2 (proposed) and docs/24-threat-model.md E. */
export const RULES = {
  /** Any unauthenticated request, per address. */
  publicIp: { burst: 20, everySeconds: 0.2 },
  /** Login attempts per address and per email. */
  loginIp: { burst: 10, everySeconds: 6 },
  loginEmail: { burst: 5, everySeconds: 60 },
  /** Sign-up, verification resend, and password reset mail, per address and per email. */
  mailIp: { burst: 5, everySeconds: 60 },
  mailEmail: { burst: 3, everySeconds: 300 },
  /** Any request with a `renox_pat_` token, per token: 20/s with a burst of 100. */
  token: { burst: 100, everySeconds: 0.05 },
  /** Deployment uploads per token: 10 per minute. */
  tokenUpload: { burst: 10, everySeconds: 6 },
} satisfies Record<string, BucketRule>;

const MAX_KEYS = 100_000;

export class Buckets {
  private readonly state = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly now: () => number) {}

  /** Takes one request from `key`'s bucket; the seconds to wait when it is empty. */
  take(rule: BucketRule, key: string): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now();
    const prev = this.state.get(key);
    const tokens = prev === undefined ? rule.burst : Math.min(rule.burst, prev.tokens + (now - prev.at) / 1000 / rule.everySeconds);
    if (tokens < 1) {
      this.state.set(key, { tokens, at: now });
      return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - tokens) * rule.everySeconds)) };
    }
    this.state.delete(key);
    if (this.state.size >= MAX_KEYS) this.state.delete(this.state.keys().next().value as string);
    this.state.set(key, { tokens: tokens - 1, at: now });
    return { ok: true };
  }
}

const perDeps = new WeakMap<Deps, Buckets>();

/** The buckets of one API process (one `Deps`), created on first use. */
export function bucketsOf(deps: Deps): Buckets {
  let b = perDeps.get(deps);
  if (b === undefined) perDeps.set(deps, (b = new Buckets(deps.now)));
  return b;
}
