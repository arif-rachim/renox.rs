// Advisories of a deployment's SBOM through OSV (#123): the query for each
// npm component, the advisories with package and version, and OSV
// unreachable or refusing answered as no advisories (warnings never block).
import { expect, test } from "bun:test";

import { advisoriesOf, components } from "../src/deployments/advisories.ts";

const SBOM = JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  components: [
    { type: "library", name: "lodash", version: "4.17.20", purl: "pkg:npm/lodash@4.17.20" },
    { type: "library", name: "stripe", version: "23.0.1", purl: "pkg:npm/stripe@23.0.1" },
    { type: "library", name: "x", version: "1", purl: "pkg:pypi/x@1" },
  ],
});

test("each npm component is asked; the advisories come back with package and version", async () => {
  let asked: unknown = null;
  const fake = async (_u: string, init: RequestInit) => {
    asked = JSON.parse(String(init.body));
    return Response.json({ results: [{ vulns: [{ id: "GHSA-35jh-r3h4-6jhm" }, { id: "GHSA-29mw-wpgm-hmr9" }] }, {}] });
  };
  expect(await advisoriesOf(SBOM, fake)).toEqual([
    { package: "lodash", version: "4.17.20", id: "GHSA-29mw-wpgm-hmr9" },
    { package: "lodash", version: "4.17.20", id: "GHSA-35jh-r3h4-6jhm" },
  ]);
  expect(asked).toEqual({ queries: [{ package: { name: "lodash", ecosystem: "npm" }, version: "4.17.20" }, { package: { name: "stripe", ecosystem: "npm" }, version: "23.0.1" }] });
  expect(components(SBOM).map((c) => c.name)).toEqual(["lodash", "stripe"]);
});

test("OSV down or refusing, or no SBOM: no advisories, never an error", async () => {
  expect(await advisoriesOf(SBOM, async () => { throw new Error("down"); })).toEqual([]);
  expect(await advisoriesOf(SBOM, async () => new Response("no", { status: 503 }))).toEqual([]);
  expect(await advisoriesOf("not json")).toEqual([]);
});

// The upload path (deploy-api.md 0.5 section 11.2): a deployment carrying
// sbom.cdx.json is scanned when it is validated; getAdvisories answers the
// items with severity, summary and the fixed version; without an SBOM it
// answers sbom false; another tenant's token gets 404; OSV down never
// rejects the upload.
import { contentHash } from "@renox/artifact-validate";

import { setOsvFetch } from "../src/deployments/advisories.ts";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, harness, tenant } from "./helpers.ts";

const withSbom = () =>
  helloArtifact((m, f) => {
    (m.artifact as Record<string, unknown>).version = 1;
    f.set("sbom.cdx.json", new TextEncoder().encode(SBOM));
  });

const osv = async (url: string): Promise<Response> => {
  if (url.endsWith("/querybatch")) return Response.json({ results: [{ vulns: [{ id: "GHSA-35jh-r3h4-6jhm" }] }, {}] });
  if (url.endsWith("/GHSA-35jh-r3h4-6jhm"))
    return Response.json({
      id: "GHSA-35jh-r3h4-6jhm",
      summary: "Command Injection in lodash",
      database_specific: { severity: "HIGH" },
      affected: [{ package: { name: "lodash", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
    });
  return new Response("not found", { status: 404 });
};

test("getAdvisories: scanned at upload, the dashboard's warning data; none without an SBOM; 404 for another tenant", async () => {
  const h = await harness();
  try {
    setOsvFetch(osv);
    const token = await tenant(h, "t_adv");
    expect((await h.request("POST", "/v1/apps", { token, json: { name: "hello" } })).status).toBe(201);
    const files = withSbom();
    const up = await upload(h, token, "hello", files);
    expect(up.status).toBe(201);
    const hash = contentHash(files);
    const r = await h.request("GET", `/v1/apps/hello/deployments/${hash}/advisories`, { token });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      hash,
      sbom: true,
      checked_at: h.clock.now,
      items: [{ package: "lodash", version: "4.17.20", id: "GHSA-35jh-r3h4-6jhm", severity: "high", summary: "Command Injection in lodash", fixed_in: "4.17.21" }],
    });
    const plain = helloArtifact();
    expect((await upload(h, token, "hello", plain)).status).toBe(201);
    expect(await (await h.request("GET", `/v1/apps/hello/deployments/${contentHash(plain)}/advisories`, { token })).json()).toMatchObject({ sbom: false, items: [] });
    const other = await tenant(h, "t_adv_other");
    expect((await h.request("GET", `/v1/apps/hello/deployments/${hash}/advisories`, { token: other })).status).toBe(404);
    // OSV down: the upload is still validated, with no items.
    setOsvFetch(async () => {
      throw new Error("down");
    });
    const again = helloArtifact((m, f) => {
      (m.artifact as Record<string, unknown>).version = 1;
      (m.app as Record<string, unknown>).name = "hello";
      f.set("sbom.cdx.json", new TextEncoder().encode(SBOM.replace("4.17.20", "4.17.19")));
    });
    expect((await upload(h, token, "hello", again)).status).toBe(201);
    expect(await (await h.request("GET", `/v1/apps/hello/deployments/${contentHash(again)}/advisories`, { token })).json()).toMatchObject({ sbom: true, items: [] });
  } finally {
    setOsvFetch((u, i) => fetch(u, i));
    assertScoped();
  }
});
