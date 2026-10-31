// Safe Browsing checks of tenant hostnames (#123; deploy-api.md 0.5
// section 22): the Lookup API v4 (`threatMatches:find`) asked for each public
// hostname when a deployment is activated, daily after that, and when an
// abuse report names it. The verdict of each hostname is kept in
// `safe_browsing_checks` (migration 0025) and shown on getOpsTenant.
//
// An unsafe hostname whose threat is phishing or malware is taken down at
// once and reviewed after (the `open` row of the abuse machine): a ticket is
// opened for it, unless one is already open or taken down.
//
// The API key is RENOX_SAFE_BROWSING_KEY. It goes only in the request's query
// string, never in a log line. Without it every verdict is `unknown` and
// nothing is taken down; Google being unreachable answers `unknown` too.

import type { Deps } from "../context.ts";
import { takeDownAtOnce } from "../abuse/takedown.ts";
import { crossTenant } from "../tenancy/scope.ts";

export type Verdict = "safe" | "unsafe" | "unknown";
export interface Check {
  verdict: Verdict;
  threats: string[];
}

export type SafeBrowsingFetch = (url: string, init: RequestInit) => Promise<Response>;

const ENDPOINT = "https://safebrowsing.googleapis.com/v4/threatMatches:find";
const THREATS = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"];
/** The Lookup API's limit of entries per request. */
const BATCH = 500;
export const DAY_MS = 86_400_000;

let sbFetch: SafeBrowsingFetch = (url, init) => fetch(url, init);
/** Google's fetch; tests replace it. */
export const setSafeBrowsingFetch = (f: SafeBrowsingFetch): void => {
  sbFetch = f;
};
export const currentSafeBrowsingFetch = (): SafeBrowsingFetch => sbFetch;

const url = (hostname: string): string => `https://${hostname}/`;

/** The verdict of each hostname (lower case), in batches of 500. */
export async function lookup(hostnames: string[], key = process.env.RENOX_SAFE_BROWSING_KEY ?? "", timeoutMs = 5_000): Promise<Map<string, Check>> {
  const out = new Map<string, Check>();
  const list = [...new Set(hostnames.map((h) => h.toLowerCase()))];
  for (const h of list) out.set(h, { verdict: "unknown", threats: [] });
  if (key === "" || list.length === 0) return out;
  for (let i = 0; i < list.length; i += BATCH) {
    const part = list.slice(i, i + BATCH);
    try {
      const res = await sbFetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "renox", clientVersion: "1" },
          threatInfo: { threatTypes: THREATS, platformTypes: ["ANY_PLATFORM"], threatEntryTypes: ["URL"], threatEntries: part.map((h) => ({ url: url(h) })) },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const body = (await res.json().catch(() => null)) as { matches?: { threatType?: unknown; threat?: { url?: unknown } }[] } | null;
      if (body === null) continue;
      for (const h of part) out.set(h, { verdict: "safe", threats: [] });
      for (const m of body.matches ?? []) {
        if (typeof m.threat?.url !== "string" || typeof m.threatType !== "string") continue;
        let host: string;
        try {
          host = new URL(m.threat.url).hostname.toLowerCase();
        } catch {
          continue;
        }
        const c = out.get(host);
        if (c === undefined) continue;
        c.verdict = "unsafe";
        if (!c.threats.includes(m.threatType)) c.threats.push(m.threatType);
      }
    } catch {
      // Unreachable: this batch stays unknown.
    }
  }
  return out;
}

/** The abuse category of Safe Browsing threats that warrant a takedown at once, or null. */
export function takedownCategory(threats: string[]): "phishing" | "malware" | null {
  if (threats.includes("SOCIAL_ENGINEERING")) return "phishing";
  if (threats.includes("MALWARE")) return "malware";
  return null;
}

/**
 * Checks hostnames, stores the verdicts, and takes down an unsafe one
 * (phishing or malware) at once. An unknown verdict (no key, Google
 * unreachable) is not stored: the last known one stays and the hostname is
 * due again at the next run. `takeDown` false only records (a report, whose
 * own category decides).
 */
export async function checkHostnames(deps: Deps, rows: { hostname: string; tenant_id: string }[], now = deps.now(), key = process.env.RENOX_SAFE_BROWSING_KEY ?? "", takeDown = true): Promise<Map<string, Check>> {
  const results = await lookup(rows.map((r) => r.hostname), key);
  for (const r of rows) {
    const c = results.get(r.hostname.toLowerCase());
    if (c === undefined || c.verdict === "unknown") continue;
    await deps.db.query(
      `insert into safe_browsing_checks (hostname, tenant_id, verdict, threats, checked_at) values ($1, $2, $3, $4::text::jsonb, $5)
       on conflict (hostname) do update set tenant_id = excluded.tenant_id, verdict = excluded.verdict, threats = excluded.threats, checked_at = excluded.checked_at`,
      [r.hostname.toLowerCase(), r.tenant_id, c.verdict, JSON.stringify(c.threats), now],
    );
    const category = takeDown && c.verdict === "unsafe" ? takedownCategory(c.threats) : null;
    if (category !== null) {
      deps.log.warn("safe browsing: unsafe hostname taken down", { hostname: r.hostname, tenant_id: r.tenant_id, threats: c.threats.join(",") });
      await takeDownAtOnce(deps, { hostname: r.hostname.toLowerCase(), tenantId: r.tenant_id, category, threats: c.threats, now });
    }
  }
  return results;
}

/** The public hostnames a tenant serves now (its active route entries). */
async function servedBy(deps: Deps, tenantId: string): Promise<{ hostname: string; tenant_id: string }[]> {
  return deps.db.query<{ hostname: string; tenant_id: string }>("select distinct hostname, tenant_id from route_entries where tenant_id = $1 and status = 'active'", [tenantId]);
}

/** On activation: the tenant's hostnames. A failure is logged, never a failed activation. */
export async function checkTenant(deps: Deps, tenantId: string): Promise<void> {
  // The key is read before the first await, so the check belongs to the activation that started it.
  const key = process.env.RENOX_SAFE_BROWSING_KEY ?? "";
  if (key === "") return;
  // Runs after the tenant's request; a takedown looks up the hostname's tickets, whichever tenant reported.
  const platform = { ...deps, db: crossTenant(deps.db, "a Safe Browsing check and its takedown act on a hostname, after the tenant's request") };
  try {
    await checkHostnames(platform, await servedBy(platform, tenantId), deps.now(), key);
  } catch (e) {
    deps.log.error("safe browsing check failed", { tenant_id: tenantId, error: String(e) });
  }
}

/** The daily check: every served hostname not checked in the last day, the oldest first, 5,000 per run. */
export async function sweepSafeBrowsing(deps: Deps, now = deps.now()): Promise<number> {
  const key = process.env.RENOX_SAFE_BROWSING_KEY ?? "";
  if (key === "") return 0;
  const due = await deps.db.query<{ hostname: string; tenant_id: string }>(
    `select distinct r.hostname, r.tenant_id, coalesce(s.checked_at, 0) as at from route_entries r
       left join safe_browsing_checks s on s.hostname = r.hostname
      where r.status = 'active' and coalesce(s.checked_at, 0) <= $1
      order by at limit 5000`,
    [now - DAY_MS],
  );
  if (due.length > 0) await checkHostnames(deps, due, now, key);
  return due.length;
}

/** getOpsTenant's `safe_browsing` (section 22): the last check of each hostname of the tenant that has one (64 at most). */
export async function safeBrowsingOf(deps: Deps, tenantId: string): Promise<{ hostname: string; verdict: Verdict; checked_at: number }[]> {
  const rows = await deps.db.query<{ hostname: string; verdict: Verdict; checked_at: unknown }>(
    "select hostname, verdict, checked_at from safe_browsing_checks where tenant_id = $1 order by hostname limit 64",
    [tenantId],
  );
  return rows.map((r) => ({ hostname: r.hostname, verdict: r.verdict, checked_at: Number(r.checked_at) }));
}
