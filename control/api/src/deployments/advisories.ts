// Advisories of a deployment's npm packages (#123): the components of its
// sbom.cdx.json (artifact.md 1.4) checked against OSV's batch API
// (https://api.osv.dev/v1/querybatch). Warnings only in this phase: nothing
// is blocked. OSV is reached with the platform's own fetch; a failure answers
// no advisories rather than failing the deploy.

export interface Advisory {
  package: string;
  version: string;
  id: string;
}

export type OsvFetch = (url: string, init: RequestInit) => Promise<Response>;

const OSV = "https://api.osv.dev/v1/querybatch";

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
