// Bundle hygiene on upload (#115): the control plane applies the build's
// rules to a hand-made tarball, rejects it with RENOX_DEPLOY_REJECTED (H1
// forbidden file, H2 secret), and never stores it. Proves
// docs/24-threat-model.md section B, "Secrets in bundle", and section C,
// "dotfiles under public/".
//
// The fake key is assembled at run time (no scanner-shaped string in the repo).

import { afterEach, describe, expect, test } from "bun:test";
import { contentHash, sha256Hex } from "@renox/artifact-validate";
import { helloArtifact, upload } from "./artifacts.ts";
import { assertScoped, createApp_, harness, type Harness, tenant } from "./helpers.ts";

afterEach(assertScoped);

const enc = new TextEncoder();
const FAKE_STRIPE = ["sk", "_live_", "51FAKEfakeFAKEfake0123456789abcd"].join("");

/** The hello artifact with extra public/ files, listed in public/manifest.json so only the hygiene rules can object. */
const withPublic = (extra: Record<string, string>) =>
  helloArtifact((_m, files) => {
    const entries: Record<string, { sha256: string; size: number; content_type: string }> = {};
    for (const [path, text] of Object.entries(extra)) {
      const bytes = enc.encode(text);
      files.set(`public/${path}`, bytes);
      entries[`/${path}`] = { sha256: sha256Hex(bytes), size: bytes.length, content_type: "text/plain; charset=utf-8" };
    }
    files.set("public/manifest.json", enc.encode(JSON.stringify({ version: 0, files: entries })));
  });

async function setup(): Promise<{ h: Harness; token: string }> {
  const h = await harness();
  const token = await tenant(h, "t_hello");
  await createApp_(h, token, "hello");
  return { h, token };
}

type Rejection = { error: { code: string; details: { rule: string; path?: string; reason: string }[] } };

describe("hygiene rules on upload", () => {
  test("a hand-made tarball with .env is rejected (H1) and not in the artifact bucket afterwards", async () => {
    const { h, token } = await setup();
    const files = withPublic({ ".env": "STRIPE_KEY=x\n", "style.css": "body{}\n" });
    const res = await upload(h, token, "hello", files);
    expect(res.status).toBe(422);
    const body = (await res.json()) as Rejection;
    expect(body.error.code).toBe("RENOX_DEPLOY_REJECTED");
    expect(body.error.details).toContainEqual({ rule: "H1", path: "public/.env", reason: "an environment file (.env)" });
    expect(body.error.details.filter((d) => d.rule.startsWith("V"))).toEqual([]);
    expect([...h.store.objects.keys()]).toEqual([]);
    const row = await h.db.query<{ state: string }>("select state from deployments where hash = $1", [contentHash(files)]);
    expect(row.map((r) => r.state)).toEqual(["rejected"]);
  });

  test(".git, keys and databases anywhere in the tree are H1; public/.well-known/ is fine", async () => {
    const { h, token } = await setup();
    const res = await upload(h, token, "hello", withPublic({ ".git/HEAD": "ref\n", "id_rsa": "x\n", "data.sqlite": "x", ".well-known/security.txt": "Contact: mailto:a@example.com\n" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as Rejection;
    expect(body.error.details.filter((d) => d.rule === "H1").map((d) => d.path)).toEqual(["public/.git/HEAD", "public/data.sqlite", "public/id_rsa"]);
    // The root-level case is also V1 (not an allowed top-level entry), and H1.
    const root = helloArtifact((_m, f) => f.set(".env", enc.encode("X=1\n")));
    const r2 = (await (await upload(h, token, "hello", root)).json()) as Rejection;
    expect(r2.error.details.map((d) => d.rule).sort()).toEqual(["H1", "V1"]);
  });

  test("a fake Stripe live key in a public file is H2 with its line; the response never quotes it", async () => {
    const { h, token } = await setup();
    const files = withPublic({ "app.js": `// config\nconst stripe = "${FAKE_STRIPE}";\n` });
    const res = await upload(h, token, "hello", files);
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain(FAKE_STRIPE);
    const body = JSON.parse(text) as Rejection;
    expect(body.error.details).toEqual([{ rule: "H2", path: "public/app.js", reason: `line 2: Stripe live secret or restricted key (sk_live_… (${FAKE_STRIPE.length} chars)); store it with the secrets API instead` }]);
    expect([...h.store.objects.keys()]).toEqual([]);
  });

  test("renox-allow-secret with a reason passes, as in renox build", async () => {
    const { h, token } = await setup();
    const files = withPublic({ "app.js": `const stripe = "${FAKE_STRIPE}"; // renox-allow-secret: revoked fixture\n` });
    expect((await upload(h, token, "hello", files)).status).toBe(201);
    expect(h.store.objects.has(`artifacts/${contentHash(files)}.tar`)).toBe(true);
  });
});
