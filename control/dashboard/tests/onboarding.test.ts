// Onboarding in the dashboard (#326; deploy-api.md 0.5 section 21;
// docs/19-platform-wireframes.md 3.1 and 3.2) against the real control API
// (in process): sign-up with the DPA accepted and its version recorded, the
// verification link, the first app from a template, the getting-started
// checklist until the first deploy, and the legal pages.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DPA_VERSION, TERMS_VERSION } from "../../api/src/signup/dpa.ts";
import { assertScoped, mailToken, registeredNode, tenant } from "../../api/tests/helpers.ts";
import { buildArtifact } from "../../../cli/src/lib/build.ts";
import { actions as newActions, load as newLoad } from "../pages/apps/new.ts";
import { load as homeLoad } from "../pages/index.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actions as signupActions, load as signupLoad } from "../pages/signup/index.ts";
import { actions as verifyActions } from "../pages/signup/verify.ts";
import { actionCtx, dash, devWithData, loaderCtx } from "./helpers.ts";

setDefaultTimeout(60_000);
afterEach(assertScoped);
const worker = process.env.RENOX_WORKER_PATH;
type Data = Record<string, any>;
const data = (v: unknown): Data => {
  expect(v).not.toBeInstanceOf(Response);
  return v as Data;
};

let saved: string | undefined;
beforeAll(async () => {
  saved = process.env.CONTROL_TEMPLATES_DIR;
  const dir = mkdtempSync(join(tmpdir(), "renox-dash-templates-"));
  await buildArtifact(new URL("../../../examples/hello", import.meta.url).pathname, join(dir, "hello"));
  process.env.CONTROL_TEMPLATES_DIR = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env.CONTROL_TEMPLATES_DIR;
  else process.env.CONTROL_TEMPLATES_DIR = saved;
});

const SIGNUP = { email: "owner@first.ae", password: "correct horse battery staple", tenant_id: "t_first", tenant_name: "First LLC", dpa: "yes" };

describe("sign-up and verification", () => {
  test("the DPA must be accepted before the API is called; sign-up records its version; the emailed link verifies", async () => {
    const d = await dash();
    expect(data(signupLoad(loaderCtx(d, "/signup")))).toMatchObject({ sent: false, error: null });
    const before = d.calls.sent.length;
    const refused = data(await signupActions.default(actionCtx(d, "/signup", "default", { ...SIGNUP, dpa: "" })));
    expect(refused).toMatchObject({ sent: false, error: expect.stringContaining("data processing agreement") });
    expect(data(await signupActions.default(actionCtx(d, "/signup", "default", { ...SIGNUP, password: "short" }))).error).toContain("12 characters");
    expect(d.calls.sent.length).toBe(before);
    const ok = data(await signupActions.default(actionCtx(d, "/signup", "default", SIGNUP)));
    expect(ok).toMatchObject({ sent: true, error: null, email: "owner@first.ae" });
    const sent = d.calls.sent.at(-1);
    expect(sent?.authorization).toBeNull();
    expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ email: "owner@first.ae", tenant_id: "t_first", dpa_accepted: true });
    expect(JSON.stringify(ok)).not.toContain(SIGNUP.password);
    expect((await d.h.db.query<{ dpa_version: string }>("select dpa_version from tenants where id = 't_first'"))[0]?.dpa_version).toBe(DPA_VERSION);
    // The email links to this page with the token in the fragment.
    const mail = d.h.mailer.last("owner@first.ae", "verify_email")?.text ?? "";
    expect(mail).toMatch(/\/signup\/verify#token=[a-z2-7]{32}/u);
    const token = mailToken(d.h, "owner@first.ae", "verify_email");
    expect(data(await verifyActions.default(actionCtx(d, "/signup/verify", "default", { token: "nope" }))).error).toContain("not complete");
    expect(data(await verifyActions.default(actionCtx(d, "/signup/verify", "default", { token })))).toMatchObject({ verified: true, tenant_id: "t_first" });
    // A used link.
    expect(data(await verifyActions.default(actionCtx(d, "/signup/verify", "default", { token }))).error).toContain("already used");
    // A taken workspace id.
    expect(data(await signupActions.default(actionCtx(d, "/signup", "default", { ...SIGNUP, email: "other@first.ae" }))).error).toContain("taken");
  });
});

describe("the first app", () => {
  test("the checklist until the first deploy; a template app is live; then home is the app list", async () => {
    const d = await dash();
    const owner = await tenant(d.h, "t_first");
    await registeredNode(d.h, "node-1");
    expect(await signinActions.default(actionCtx(d, "/signin", "default", { token: owner, next: "/" }))).toBeInstanceOf(Response);
    const empty = data(await homeLoad(loaderCtx(d, "/")));
    expect(empty.steps.map((s: { done: boolean; href: string | null }) => [s.done, s.href])).toEqual([
      [true, null],
      [false, "/apps/new"],
      [false, null],
    ]);
    expect(data(await newLoad(loaderCtx(d, "/apps/new"))).templates.map((t: { id: string }) => t.id)).toEqual(["shop", "hello", "booking", "invoices"]);
    expect(data(await newActions.create(actionCtx(d, "/apps/new", "create", { name: "Bad Name", template: "hello" }))).form_error).toContain("lower-case");
    // shop is not built on this control plane: the page says so.
    expect(data(await newActions.create(actionCtx(d, "/apps/new", "create", { name: "my-shop", template: "shop" }))).form_error).toContain("not available");
    const made = data(await newActions.create(actionCtx(d, "/apps/new", "create", { name: "first-site", template: "hello" })));
    expect(made.created).toMatchObject({ app: "first-site", template: "hello", url: "https://first-site.renox.app" });
    expect(made.created.hash).toMatch(/^[0-9a-f]{64}$/u);
    const home = await homeLoad(loaderCtx(d, "/"));
    expect(home).toBeInstanceOf(Response);
    expect((home as Response).headers.get("location")).toBe("/apps");
  });
});

test("the legal pages carry the versions sign-up records", () => {
  expect(readFileSync(join(import.meta.dir, "../pages/legal/dpa.html"), "utf8")).toContain(`Version ${DPA_VERSION}.`);
  expect(readFileSync(join(import.meta.dir, "../pages/legal/terms.html"), "utf8")).toContain(`Version ${TERMS_VERSION}.`);
});

// The templates rendered by the worker (`renox dev`).
test.skipIf(!worker)("the worker renders sign-up, verification, the new-app flow, the checklist and the legal pages", async () => {
  const dev = await devWithData({
    "pages/apps/new.ts": { signed_in: true, impersonation: null, api_host: "api.renox.app", templates: [{ id: "shop", name: "Shop", about: "A shop" }], created: null, form_error: null, action_problem: null, name: "", template: "shop" },
    "pages/index.ts": { signed_in: true, impersonation: null, api_host: "api.renox.app", steps: [{ done: true, text: "Verify your email address", href: null }, { done: false, text: "Create your first app from a template", href: "/apps/new" }] },
  });
  try {
    const page = async (path: string) => (await (await fetch(`${dev.base}${path}`)).text()).replaceAll(' dir="auto"', "");
    const signup = await page("/signup");
    expect(signup).toContain('name="dpa"');
    expect(signup).toContain('href="/legal/dpa"');
    const verify = await fetch(`${dev.base}/signup/verify`);
    expect(verify.status).toBe(200);
    const v = await verify.text();
    expect(v).toMatch(/<script nonce="[^"]+">/u);
    expect(v).toContain('id="verify-token"');
    const newApp = await page("/apps/new");
    expect(newApp).toContain('name="template" value="shop" checked');
    const home = await page("/");
    expect(home).toContain('<a href="/apps/new">Create your first app from a template</a>');
    for (const page of ["dpa", "terms"]) {
      const r = await fetch(`${dev.base}/legal/${page}`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain(`Version ${DPA_VERSION}.`);
    }
  } finally {
    await dev.stop();
  }
});
