// Advisories of a deployment's npm packages (#123): the components of its
// sbom.cdx.json (artifact.md 1.4) checked against OSV's batch API
// (https://api.osv.dev/v1/querybatch). Warnings only in this phase: nothing
// is blocked. OSV is reached with the platform's own fetch; a failure answers
// no advisories rather than failing the deploy. `scan` adds each advisory's
// severity, summary and first fixed version (OSV's `/v1/vulns/{id}`) for
// getAdvisories (deploy-api.md 0.5 section 11.2); the upload runs it.

export interface Advisory {
  package: string;
  version: string;
  id: string;
}

export type OsvFetch = (url: string, init: RequestInit) => Promise<Response>;

const OSV = "https://api.osv.dev/v1/querybatch";
const VULN = "https://api.osv.dev/v1/vulns/";

/** OSV's fetch for the upload path; tests replace it. */
let osvFetch: OsvFetch = (url, init) => fetch(url, init);
export const setOsvFetch = (f: OsvFetch): void => {
  osvFetch = f;
};
export const currentOsvFetch = (): OsvFetch => osvFetch;

/** The `{ name, version }` npm components of a CycloneDX document; others are left out. */
export function components(sbom: string): { name: string; version: string }[] {
  try {
    const doc = JSON.parse(sbom) as { components?: { name?: unknown; version?: unknown; purl?: unknown }[] };
    return (doc.components ?? []).filter((c) => typeof c.name === "string" && typeof c.version === "string" && typeof c.purl === "string" && c.purl.startsWith("pkg:npm/")).map((c) => ({ name: c.name as string, version: c.version as string }));
  } catch {
    return [];
  }
}

/** The advisories of an SBOM, sorted by package then id (at most 1,000 components asked). */
export async function advisoriesOf(sbom: string, fetchFn: OsvFetch = fetch, timeoutMs = 10_000): Promise<Advisory[]> {
  const list = components(sbom).slice(0, 1000);
  if (list.length === 0) return [];
  let res: Response;
  try {
    res = await fetchFn(OSV, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: list.map((c) => ({ package: { name: c.name, ecosystem: "npm" }, version: c.version })) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { results?: { vulns?: { id?: unknown }[] }[] };
  const out: Advisory[] = [];
  (body.results ?? []).forEach((r, i) => {
    const c = list[i];
    if (c === undefined) return;
    for (const v of r.vulns ?? []) if (typeof v.id === "string") out.push({ package: c.name, version: c.version, id: v.id });
  });
  return out.sort((a, b) => (a.package === b.package ? (a.id < b.id ? -1 : 1) : a.package < b.package ? -1 : 1));
}

/** One item of getAdvisories (deploy-api.yaml). */
export interface AdvisoryItem extends Advisory {
  severity: "low" | "moderate" | "high" | "critical" | "unknown";
  summary: string;
  fixed_in: string | null;
}

const SEVERITIES = ["low", "moderate", "high", "critical"] as const;

/** The severity, summary and first fixed version of one OSV record; unknown when OSV does not answer. */
async function detail(a: Advisory, fetchFn: OsvFetch, timeoutMs: number): Promise<AdvisoryItem> {
  const item: AdvisoryItem = { ...a, severity: "unknown", summary: "", fixed_in: null };
  try {
    const res = await fetchFn(VULN + encodeURIComponent(a.id), { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return item;
    const v = (await res.json()) as {
      summary?: unknown;
      database_specific?: { severity?: unknown };
      affected?: { package?: { name?: unknown; ecosystem?: unknown }; ranges?: { events?: { fixed?: unknown }[] }[] }[];
    };
    const sev = String(v.database_specific?.severity ?? "").toLowerCase();
    if ((SEVERITIES as readonly string[]).includes(sev)) item.severity = sev as AdvisoryItem["severity"];
    if (typeof v.summary === "string") item.summary = v.summary.slice(0, 500);
    const mine = (v.affected ?? []).filter((x) => x.package?.name === a.package && x.package?.ecosystem === "npm");
    const fixed = mine.flatMap((x) => (x.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed))).find((f) => typeof f === "string");
    item.fixed_in = typeof fixed === "string" ? fixed.slice(0, 64) : null;
  } catch {
    // OSV unreachable: the advisory stays, with what is known.
  }
  return item;
}

/** The advisories of an SBOM with their details (at most 500, the contract's cap; details for the first 50). */
export async function scan(sbom: string, fetchFn: OsvFetch = osvFetch, timeoutMs = 5_000): Promise<AdvisoryItem[]> {
  const found = (await advisoriesOf(sbom, fetchFn, timeoutMs)).slice(0, 500);
  const out: AdvisoryItem[] = [];
  for (const [i, a] of found.entries()) out.push(i < 50 ? await detail(a, fetchFn, timeoutMs) : { ...a, severity: "unknown", summary: "", fixed_in: null });
  return out;
}
