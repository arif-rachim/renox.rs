// Upload and validation (docs/contracts/deploy-api.md sections 4-5;
// docs/23-failure-modes.md "Bundle over 20 MB, route conflict, unknown
// permission key" and "Upload interrupted, retried"; docs/24-threat-model.md
// B "Code persisted without validation").

import { describe, expect, test } from "bun:test";
import { contentHash, extractTar, writeTar } from "@renox/artifact-validate";
import { check } from "../src/contract.ts";
import { helloArtifact, named, upload } from "./artifacts.ts";
import { auditRows, createApp_, harness, scopedToken, tenant, type Harness } from "./helpers.ts";

const enc = new TextEncoder();

type ErrorBody = { error: { code: string; deployment?: string; details?: { rule?: string; field?: string; path?: string; reason?: string }[] } };

async function setup(tier: "free" | "paid" = "free"): Promise<{ h: Harness; token: string }> {
  const h = await harness();
  const token = await tenant(h, "t_hello", tier);
  await createApp_(h, token, "hello");
  return { h, token };
}

describe("upload", () => {
  test("a valid artifact is validated, stored by hash, and recorded with its permissions", async () => {
    const { h, token } = await setup();
    const files = helloArtifact((m) => {
      m.permissions = { network: ["api.stripe.com"], secrets: ["STRIPE_KEY"] };
    });
    const hash = contentHash(files);
    const res = await upload(h, token, "hello", files);
    expect(res.status).toBe(201);
    const body = check<Record<string, unknown>>("Deployment", await res.json());
    expect(body).toMatchObject({ app: "hello", hash, state: "validated", secrets_version: null, violations: null });
    expect(body.permissions).toEqual({ network: ["api.stripe.com"], secrets: ["STRIPE_KEY"] });
    const stored = h.store.objects.get(`artifacts/${hash}.tar`) as Uint8Array;
    expect(contentHash(await extractTar(stored, { gzip: false }))).toBe(hash);
    const perms = await h.db.query("select kind, value from permissions order by kind");
    expect(perms).toEqual([
      { kind: "network", value: "api.stripe.com" },
      { kind: "secret", value: "STRIPE_KEY" },
    ]);
    const audit = await auditRows(h);
    expect(audit.filter((a) => a.action === "deploymentState").map((a) => (a.target as { to: string }).to)).toEqual(["uploaded", "validated"]);
    expect(audit.at(-1)).toMatchObject({ action: "uploadDeployment", status: 201, tenant_id: "t_hello" });
  });

  test("the same hash twice is idempotent: 200, the same record, no new transition", async () => {
    const { h, token } = await setup();
    const files = helloArtifact();
    const first = (await (await upload(h, token, "hello", files)).json()) as Record<string, unknown>;
    h.clock.now += 1000;
    const again = await upload(h, token, "hello", files, { gzip: true });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    const transitions = (await auditRows(h)).filter((a) => a.action === "deploymentState");
    expect(transitions.length).toBe(2);
    expect(h.store.objects.size).toBe(1);
  });

  test("gzip uploads work", async () => {
    const { h, token } = await setup();
    expect((await upload(h, token, "hello", helloArtifact(), { gzip: true })).status).toBe(201);
  });

  const rejectedBy = async (files: Map<string, Uint8Array>, rule: string, opts: { hash?: string; tier?: "free" | "paid" } = {}) => {
    const { h, token } = await setup(opts.tier);
    const res = await upload(h, token, "hello", files, opts);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("RENOX_DEPLOY_REJECTED");
    check("Error", body);
    expect(body.error.details?.map((d) => d.rule)).toContain(rule);
    const hash = opts.hash ?? contentHash(files);
    expect(body.error.deployment).toBe(hash);
    const get = (await (await h.request("GET", `/v1/apps/hello/deployments/${hash}`, { token })).json()) as { state: string; violations: { rule: string }[] };
    expect(get.state).toBe("rejected");
    expect(get.violations.map((v) => v.rule)).toContain(rule);
    expect(h.store.objects.size).toBe(0);
    return { h, token, body };
  };

  test("route conflict → V8", async () => {
    await rejectedBy(
      helloArtifact((m) => {
        const routes = m.routes as Record<string, unknown>[];
        routes.push({ ...(routes[0] as object), path: "/api/hello" });
      }),
      "V8",
    );
  });

  test("unknown permission key → V3 (schema)", async () => {
    const { body } = await rejectedBy(
      helloArtifact((m) => {
        m.permissions = { network: [], secrets: [], filesystem: ["/"] };
      }),
      "V3",
    );
    expect(JSON.stringify(body)).toContain("filesystem");
  });

  test("code over 20 MiB → V5", async () => {
    await rejectedBy(
      helloArtifact((_m, f) => {
        f.set("code/big1.json", new Uint8Array(11 * 1024 * 1024));
        f.set("code/big2.json", new Uint8Array(11 * 1024 * 1024));
      }),
      "V5",
    );
  });

  test("a hash header that is not the content hash → V2", async () => {
    await rejectedBy(helloArtifact(), "V2", { hash: "0".repeat(64) });
  });

  test("an artifact of another app → V3 app.name", async () => {
    const { body } = await rejectedBy(named("other"), "V3");
    expect(body.error.details?.[0]?.field).toBe("app.name");
  });

  test("a limit above the tier → V10; the same limit is accepted for a paid tenant", async () => {
    const files = helloArtifact((m) => {
      m.limits = { cpu_ms: 200 };
    });
    await rejectedBy(files, "V10");
    const { h, token } = await setup("paid");
    expect((await upload(h, token, "hello", files)).status).toBe(201);
  });

  test("a path escape in the tar → T4, recorded as rejected", async () => {
    const files = helloArtifact();
    files.set("code/../../etc/passwd", enc.encode("x"));
    const { h, token } = await setup();
    const res = await upload(h, token, "hello", files, { hash: contentHash(helloArtifact()) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.details).toEqual([{ rule: "T4", path: "code/../../etc/passwd", reason: "empty, . or .. segment" }]);
    expect(h.store.objects.size).toBe(0);
  });

  test("a rejected hash is validated again on re-upload (here after a tier change)", async () => {
    const files = helloArtifact((m) => {
      m.limits = { cpu_ms: 200 };
    });
    const { h, token } = await rejectedBy(files, "V10");
    await h.db.query("update tenants set tier = 'paid'");
    const res = await upload(h, token, "hello", files);
    expect(res.status).toBe(201);
    const to = (await auditRows(h)).filter((a) => a.action === "deploymentState").map((a) => (a.target as { to: string }).to);
    expect(to).toEqual(["uploaded", "rejected", "uploaded", "validated"]);
  });

  test("bad headers: content type, hash header, declared length over 100 MiB", async () => {
    const { h, token } = await setup();
    const tar = writeTar(helloArtifact());
    const hash = contentHash(helloArtifact());
    const send = (headers: Record<string, string>) => h.request("POST", "/v1/apps/hello/deployments", { token, body: tar, headers });
    expect((await send({ "content-type": "application/zip", "x-renox-artifact-hash": hash })).status).toBe(400);
    expect((await send({ "content-type": "application/x-tar" })).status).toBe(400);
    expect((await send({ "content-type": "application/x-tar", "x-renox-artifact-hash": hash, "content-length": String(101 * 1024 * 1024) })).status).toBe(413);
  });

  test("scope, tenant and suspension guards", async () => {
    const { h, token } = await setup();
    const reader = await scopedToken(h, "t_hello", ["apps:read"]);
    expect((await upload(h, reader, "hello", helloArtifact())).status).toBe(403);
    const other = await tenant(h, "t_other");
    expect((await upload(h, other, "hello", helloArtifact())).status).toBe(404);
    await h.db.query("update tenants set state = 'suspended' where id = 't_hello'");
    expect((await upload(h, token, "hello", helloArtifact())).status).toBe(409);
  });
});

describe("reading deployments", () => {
  test("list newest first, filter by state, get one; another tenant sees 404", async () => {
    const { h, token } = await setup();
    const a = helloArtifact();
    const b = helloArtifact((_m, f) => f.set("code/extra.json", enc.encode("{}")));
    await upload(h, token, "hello", a);
    h.clock.now += 10;
    await upload(h, token, "hello", b);
    const list = (await (await h.request("GET", "/v1/apps/hello/deployments", { token })).json()) as { deployments: { hash: string; state: string }[] };
    expect(list.deployments.map((d) => d.hash)).toEqual([contentHash(b), contentHash(a)]);
    for (const d of list.deployments) check("Deployment", d);
    const rejected = await h.request("GET", "/v1/apps/hello/deployments?state=rejected", { token });
    expect(((await rejected.json()) as { deployments: unknown[] }).deployments).toEqual([]);
    expect((await h.request("GET", "/v1/apps/hello/deployments?state=bogus", { token })).status).toBe(400);
    expect((await h.request("GET", `/v1/apps/hello/deployments/${contentHash(a)}`, { token })).status).toBe(200);
    expect((await h.request("GET", `/v1/apps/hello/deployments/${"f".repeat(64)}`, { token })).status).toBe(404);
    expect((await h.request("GET", "/v1/apps/hello/deployments/xyz", { token })).status).toBe(404);
    const other = await tenant(h, "t_other");
    expect((await h.request("GET", `/v1/apps/hello/deployments/${contentHash(a)}`, { token: other })).status).toBe(404);
  });
});

describe("retention", () => {
  test("beyond 50 validated deployments the oldest is pruned and its object deleted", async () => {
    const { h, token } = await setup();
    const hashes: string[] = [];
    for (let i = 0; i < 51; i++) {
      const files = helloArtifact((_m, f) => f.set("code/n.json", enc.encode(String(i))));
      hashes.push(contentHash(files));
      h.clock.now += 1;
      expect((await upload(h, token, "hello", files)).status).toBe(201);
    }
    const first = (await (await h.request("GET", `/v1/apps/hello/deployments/${hashes[0]}`, { token })).json()) as { state: string };
    expect(first.state).toBe("pruned");
    expect(h.store.objects.has(`artifacts/${hashes[0]}.tar`)).toBe(false);
    expect(h.store.objects.has(`artifacts/${hashes[50]}.tar`)).toBe(true);
    const states = await h.db.query<{ state: string; n: unknown }>("select state, count(*) as n from deployments group by state order by state");
    expect(states.map((s) => [s.state, Number(s.n)])).toEqual([
      ["pruned", 1],
      ["validated", 50],
    ]);
    // A pruned hash can be uploaded again (deploy-api.md section 4).
    const files0 = helloArtifact((_m, f) => f.set("code/n.json", enc.encode("0")));
    expect((await upload(h, token, "hello", files0)).status).toBe(201);
    expect(h.store.objects.has(`artifacts/${hashes[0]}.tar`)).toBe(true);
  });
});

describe("sourcemaps", () => {
  test("stored privately under the tenant's prefix; only .map files", async () => {
    const { h, token } = await setup();
    const files = helloArtifact();
    const hash = contentHash(files);
    await upload(h, token, "hello", files);
    const put = (m: Map<string, Uint8Array>) =>
      h.request("PUT", `/v1/apps/hello/deployments/${hash}/sourcemaps`, { token, body: writeTar(m), headers: { "content-type": "application/x-tar" } });
    expect((await put(new Map([["functions/api/hello.js.map", enc.encode("{}")]]))).status).toBe(204);
    expect(h.store.objects.has(`sourcemaps/t_hello/${hash}.tar`)).toBe(true);
    expect([...h.store.objects.keys()].filter((k) => k.startsWith("artifacts/"))).toEqual([`artifacts/${hash}.tar`]);
    const bad = await put(new Map([["functions/api/hello.js", enc.encode("x")]]));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as ErrorBody).error.code).toBe("RENOX_VALIDATION");
    const missing = await h.request("PUT", `/v1/apps/hello/deployments/${"a".repeat(64)}/sourcemaps`, {
      token,
      body: writeTar(new Map([["x.map", enc.encode("{}")]])),
      headers: { "content-type": "application/x-tar" },
    });
    expect(missing.status).toBe(404);
  });
});
