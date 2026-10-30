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
