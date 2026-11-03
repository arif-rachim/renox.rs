// The per-process domain machinery: the Cloudflare for SaaS client (#419,
// ADR D25), configured from `CONTROL_CF_*` (src/config.ts, src/domains/README.md).
// Tests replace it with `configureDomains(deps, { cloudflare: new StubCloudflare() })`.

import type { Deps } from "../context.ts";
import { ApiError } from "../errors.ts";
import { CloudflareCustomHostnames, type CustomHostnames } from "./cloudflare.ts";

export interface DomainService {
  /** null: no `CONTROL_CF_*` configuration; `addDomain` answers 503 and the job creates nothing. */
  cloudflare: CustomHostnames | null;
}

export function domainServiceFromConfig(deps: Deps): DomainService {
  const cf = deps.config.cloudflare ?? null;
  return { cloudflare: cf === null ? null : new CloudflareCustomHostnames(cf) };
}

const services = new WeakMap<Deps, DomainService>();

export function domainService(deps: Deps): DomainService {
  let s = services.get(deps);
  if (s === undefined) {
    s = domainServiceFromConfig(deps);
    services.set(deps, s);
  }
  return s;
}

/** Replaces parts of the service (tests with StubCloudflare). */
export function configureDomains(deps: Deps, parts: Partial<DomainService>): DomainService {
  const s = { ...domainService(deps), ...parts };
  services.set(deps, s);
  return s;
}

/** The client, or 503 `RENOX_UNAVAILABLE` when Cloudflare for SaaS is not configured. */
export function requireCloudflare(deps: Deps): CustomHostnames {
  const cf = domainService(deps).cloudflare;
  if (cf === null) throw new ApiError("RENOX_UNAVAILABLE", [{ field: "hostname", reason: "custom domains are not configured on this installation" }], { retryAfter: 3600 });
  return cf;
}

/** The CNAME target customers point their hostname at (the fallback origin; `edge.<platform domain>` without Cloudflare). */
export function cnameTarget(deps: Deps): string {
  return domainService(deps).cloudflare?.fallbackOrigin ?? `edge.${deps.config.platformDomain}`;
}
