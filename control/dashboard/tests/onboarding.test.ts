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
import { createTenantToken } from "../../api/src/auth/tokens.ts";
import { assertScoped, mailToken, registeredNode, signup, tenant } from "../../api/tests/helpers.ts";
import { buildArtifact } from "../../../cli/src/lib/build.ts";
import { DEFAULT_API, DEFAULT_PLATFORM_DOMAIN, apiBase, platformDomain } from "../lib/api.ts";
import { actions as newActions, load as newLoad, setupFromForm } from "../pages/apps/new.ts";
import { load as homeLoad } from "../pages/index.ts";
import { actions as signinActions } from "../pages/signin.ts";
import { actions as signupActions, load as signupLoad } from "../pages/signup/index.ts";
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
  // #445 (ADR D23): the browser calls `signup` and `verifyEmail` itself
  // (public/account.js); the dashboard server never proxies them. The API side
  // of the flow is what the browser sends, with the dashboard's Origin.
  test("the dashboard server sends nothing to the API for sign-up; the browser's calls record the DPA version and the emailed link verifies once", async () => {
    const d = await dash();
    expect(data(signupLoad(loaderCtx(d, "/signup")))).toMatchObject({ api: "https://api.renoxium.com", error: null });
    const before = d.calls.sent.length;
    // A form posted without the page's script is refused with a message, and nothing reaches the API.
    const refused = data(await signupActions.default(actionCtx(d, "/signup", "default", SIGNUP)));
    expect(refused.error).toContain("JavaScript");
    expect(d.calls.sent.length).toBe(before);
    expect(JSON.stringify(refused)).not.toContain(SIGNUP.password);
    // What public/account.js sends, from the dashboard's origin.
    const origin = new URL(d.h.deps.config.dashboardUrl).origin;
    const signup = await d.h.request("POST", "/v1/account/signup", { headers: { origin }, json: { email: SIGNUP.email, password: SIGNUP.password, tenant_id: SIGNUP.tenant_id, tenant_name: SIGNUP.tenant_name, dpa_accepted: true } });
    expect(signup.status).toBe(202);
    expect(signup.headers.get("access-control-allow-origin")).toBe(origin);
    expect((await d.h.db.query<{ dpa_version: string }>("select dpa_version from tenants where id = 't_first'"))[0]?.dpa_version).toBe(DPA_VERSION);
    // The email links to the verify page with the token in the fragment.
    const mail = d.h.mailer.last("owner@first.ae", "verify_email")?.text ?? "";
    expect(mail).toMatch(/\/signup\/verify#token=[a-z2-7]{32}/u);
    const token = mailToken(d.h, "owner@first.ae", "verify_email");
    const verified = await d.h.request("POST", "/v1/account/verify", { headers: { origin }, json: { token } });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ email_verified: true, tenant_id: "t_first" });
    // A used link.
    expect((await d.h.request("POST", "/v1/account/verify", { headers: { origin }, json: { token } })).status).toBe(404);
    // A taken workspace id.
    expect((await d.h.request("POST", "/v1/account/signup", { headers: { origin }, json: { email: "other@first.ae", password: SIGNUP.password, tenant_id: "t_first", dpa_accepted: true } })).status).toBe(409);
  });

  test("no page or helper of the dashboard calls login, signup, verify or the password reset from the server (#445)", () => {
    const files = ["lib/api.ts", "pages/signin.ts", "pages/signup/index.ts", "pages/signup/verify.ts", "pages/forgot-password.ts", "pages/reset-password.ts"];
    for (const f of files) {
      const src = readFileSync(join(import.meta.dir, "..", f), "utf8");
      expect([f, /\/v1\/account\/(login|signup|verify|password-reset)/u.test(src.replace(/^\s*\/\/.*$/gmu, ""))]).toEqual([f, false]);
    }
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
    const fresh = data(await newLoad(loaderCtx(d, "/apps/new")));
    // #447: only the starters `renox new --template` also writes.
    expect(fresh.templates.map((t: { id: string }) => t.id)).toEqual(["hello"]);
    // #364: the platform domain shown for the new app is configuration, renoxium.app by default.
    expect(fresh.platform_domain).toBe("renoxium.app");
    expect(data(await newActions.create(actionCtx(d, "/apps/new", "create", { name: "Bad Name", template: "hello" }))).form_error).toContain("lower-case");
    // shop is not offered (the CLI has no such template): refused before the API is called.
    expect(data(await newActions.create(actionCtx(d, "/apps/new", "create", { name: "my-shop", template: "shop" }))).form_error).toBeTruthy();
    const made = data(await newActions.create(actionCtx(d, "/apps/new", "create", { name: "first-site", template: "hello" })));
    expect(made.created).toMatchObject({ app: "first-site", template: "hello", url: "https://first-site.renox.app" });
    expect(made.created.hash).toMatch(/^[0-9a-f]{64}$/u);
    const home = await homeLoad(loaderCtx(d, "/"));
    expect(home).toBeInstanceOf(Response);
    expect((home as Response).headers.get("location")).toBe("/apps");
  });
});

test("the legal pages carry the versions sign-up records", () => {
  // #336: the text is in i18n/; the template passes the version to it ("Version {version}.").
  expect(readFileSync(join(import.meta.dir, "../pages/legal/dpa.html"), "utf8")).toContain(`<r-t key="dash.dpa.version" version="${DPA_VERSION}" />`);
  expect(readFileSync(join(import.meta.dir, "../pages/legal/terms.html"), "utf8")).toContain(`<r-t key="dash.terms.version" version="${TERMS_VERSION}" />`);
});

// The templates rendered by the worker (`renox dev`).
test.skipIf(!worker)("the worker renders sign-up, verification, the new-app flow, the checklist and the legal pages", async () => {
  const dev = await devWithData({
    "pages/apps/new.ts": { signed_in: true, impersonation: null, api_host: "api.renoxium.com", platform_domain: "apps.example.test", templates: [{ id: "hello", name: "Hello", about: "One function" }], created: null, form_error: null, action_problem: null, name: "", template: "hello", install_url: "https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.11/install.sh" },
    "pages/index.ts": { signed_in: true, impersonation: null, api_host: "api.renoxium.com", install_url: "https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.11/install.sh", docs_url: "https://renoxium.com/docs", steps: [{ done: true, text: "Verify your email address", href: null }, { done: false, text: "Create your first app from a template", href: "/apps/new" }] },
  });
  try {
    const page = async (path: string) => (await (await fetch(`${dev.base}${path}`)).text()).replaceAll(' dir="auto"', "");
    const signup = await page("/signup");
    expect(signup).toContain('name="dpa"');
    expect(signup).toContain('href="/legal/dpa"');
    const verify = await fetch(`${dev.base}/signup/verify`);
    expect(verify.status).toBe(200);
    const v = await verify.text();
    expect(v).toContain('data-page="verify"');
    // The build links public/ files by their content-hashed name, served immutable (#406).
    expect(v).toMatch(/<script src="\/account\.[0-9a-f]{16}\.js" defer/u);
    const hashed = /<script src="(\/account\.[0-9a-f]{16}\.js)"/u.exec(v)?.[1] as string;
    const asset = await fetch(`${dev.base}${hashed}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe(readFileSync(join(import.meta.dir, "../public/account.js"), "utf8"));
    expect(v).toContain("/install.sh | sh");
    expect(v).not.toContain("bunx renox");
    const newApp = await page("/apps/new");
    expect(newApp).toContain('name="template" value="hello" checked');
    expect(newApp).toContain("<code>&lt;name&gt;.apps.example.test</code>");
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

test("the platform domain of the new-app page: RENOX_PLATFORM_DOMAIN when it is a hostname, else renoxium.app (#364)", () => {
  expect(DEFAULT_PLATFORM_DOMAIN).toBe("renoxium.app");
  expect(platformDomain({})).toBe("renoxium.app");
  expect(platformDomain({ RENOX_PLATFORM_DOMAIN: "apps.example.test" })).toBe("apps.example.test");
  for (const bad of ["", "Apps.Example", "example", "a..b", "x.test/<script>", "-a.test"]) expect(platformDomain({ RENOX_PLATFORM_DOMAIN: bad })).toBe("renoxium.app");
});

test("the dashboard calls https://api.renoxium.com by default; RENOX_API_URL (https only) overrides it (#364)", () => {
  expect(DEFAULT_API).toBe("https://api.renoxium.com");
  expect(apiBase({})).toBe("https://api.renoxium.com");
  expect(apiBase({ RENOX_API_URL: "https://api.example.test/" })).toBe("https://api.example.test");
  expect(apiBase({ RENOX_API_URL: "http://api.example.test" })).toBe("https://api.renoxium.com");
  // #445: a local control plane for the developer's own browser; never another plain-http host.
  expect(apiBase({ RENOX_API_URL: "http://localhost:8788" })).toBe("http://localhost:8788");
  expect(apiBase({ RENOX_API_URL: "http://127.0.0.1:8788/" })).toBe("http://127.0.0.1:8788");
  expect(apiBase({ RENOX_API_URL: "http://localhost.evil.example" })).toBe("https://api.renoxium.com");
  expect(apiBase({ RENOX_API_URL: "http://u:p@localhost:8788" })).toBe("https://api.renoxium.com");
});

// home-services with its setup in one form (#689). The new app's /api/setup is stubbed: `deps.callApp`.
describe("the first app: home-services with the company's setup (#689)", () => {
  const FORM = {
    name: "coolair",
    company_name: "CoolAir",
    company_trn: "",
    company_phone: "+971501234567",
    company_emirate: "dubai",
    branches: "Dubai\nSharjah, sharjah",
    services: "AC service, 150\nDeep clean, 320.50",
    people: "tech@coolair.ae, technician\nbooks@coolair.ae, accountant",
  };

  beforeAll(async () => {
    await buildArtifact(new URL("../../../examples/home-services", import.meta.url).pathname, join(process.env.CONTROL_TEMPLATES_DIR as string, "home-services"));
  });

  /** A dashboard signed in with a token of a verified user: the user's email becomes the app's first owner. */
  async function setUp(answer: () => { status: number; body: unknown }) {
    const d = await dash();
    await signup(d.h, "owner@coolair.ae", "t_cool");
    const user = (await d.h.db.query<{ id: string }>("select id from users where email = 'owner@coolair.ae'"))[0] as { id: string };
    const token = (await createTenantToken(d.h.db, "t_cool", "dashboard", ["*"], 30, d.h.clock.now, user.id)).token;
    await registeredNode(d.h, "node-1");
    expect(await signinActions.default(actionCtx(d, "/signin", "default", { token, next: "/" }))).toBeInstanceOf(Response);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    d.h.deps.callApp = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return answer();
    };
    return { d, calls };
  }

  test("the page offers the form next to the starters, which stay as they were; the form's lines become the setup object", async () => {
    const d = await dash();
    await signup(d.h, "owner@coolair.ae", "t_cool");
    const owner = await tenant(d.h, "t_other");
    expect(await signinActions.default(actionCtx(d, "/signin", "default", { token: owner, next: "/" }))).toBeInstanceOf(Response);
    const page = data(await newLoad(loaderCtx(d, "/apps/new")));
    expect(page.templates.map((t: { id: string }) => t.id)).toEqual(["hello"]);
    expect(page.home_services).toMatchObject({ id: "home-services" });
    expect(page.emirates.map((e: { id: string }) => e.id)).toContain("ras_al_khaimah");
    expect(setupFromForm(new Map(Object.entries(FORM)))).toEqual({
      setup: {
        company: { name: "CoolAir", phone: "+971501234567", emirate: "dubai" },
        branches: [
          { name: "Dubai", emirate: "dubai" },
          { name: "Sharjah", emirate: "sharjah" },
        ],
        services: [
          { name: "AC service", price_aed: 150 },
          { name: "Deep clean", price_aed: 320.5 },
        ],
        people: [
          { email: "tech@coolair.ae", role: "technician" },
          { email: "books@coolair.ae", role: "accountant" },
        ],
      },
    });
    expect(setupFromForm(new Map(Object.entries({ ...FORM, services: "AC service" })))).toEqual({ error: "dash.new.hs_err_services" });
  });

  test("the action creates the app through the API and shows the invitations; a bad line is refused before the API; a failed setup says the app is live", async () => {
    const people = [
      { email: "tech@coolair.ae", role: "technician" },
      { email: "books@coolair.ae", role: "accountant" },
    ];
    const { d, calls } = await setUp(() => ({ status: 200, body: { invited: people, skipped: [] } }));
    const bad = data(await newActions.create_home_services(actionCtx(d, "/apps/new", "create_home_services", { ...FORM, services: "AC service" })));
    expect(bad.form_error).toContain("price in AED");
    expect(data(await newActions.create_home_services(actionCtx(d, "/apps/new", "create_home_services", { ...FORM, branches: "" }))).action_problem).toBeTruthy(); // the API's 400
    expect(data(await newActions.create_home_services(actionCtx(d, "/apps/new", "create_home_services", { ...FORM, name: "Bad Name" }))).form_error).toContain("lower-case");
    expect(calls).toEqual([]);

    const made = data(await newActions.create_home_services(actionCtx(d, "/apps/new", "create_home_services", FORM)));
    expect(made.created).toMatchObject({ app: "coolair", template: "home-services", url: "https://coolair.renox.app", invited: people });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://coolair.renox.app/api/setup");
    expect(calls[0]?.body).toMatchObject({ company: { name: "CoolAir" }, owner: { email: "owner@coolair.ae" } });

    d.h.deps.callApp = async () => ({ status: 404, body: null });
    const partial = data(await newActions.create_home_services(actionCtx(d, "/apps/new", "create_home_services", { ...FORM, name: "coolair2" })));
    expect(partial.created).toBeNull();
    expect(partial.form_error).toContain("is live");
    expect(partial.partial).toEqual({ app: "coolair2", url: "https://coolair2.renoxium.app" });
  });
});
