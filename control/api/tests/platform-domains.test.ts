// The platform's domains and contacts come from configuration (#364;
// docs/contracts/README.md "Domains"): tenant apps under `renoxium.app`, the
// platform's own services and mail under `renoxium.com`. Each default is read
// here, and each is overridden by its variable. docs/24-threat-model.md C,
// "Shared-domain reputation": no default may point at a domain that is not
// the operator's.

import { describe, expect, test } from "bun:test";
import { mailOwner } from "../src/abuse/takedown.ts";
import { tierMail } from "../src/billing/sweep.ts";
import { cnameTarget, configureDomains } from "../src/domains/service.ts";
import { DEFAULTS, loadConfig } from "../src/config.ts";
import { securityTxt } from "../src/well-known.ts";
import { harness, signup } from "./helpers.ts";

describe("control API defaults (#364)", () => {
  test("the reference deployment: renoxium.app for apps, renoxium.com for the dashboard, the API and mail", () => {
    const c = loadConfig({});
    expect(c.platformDomain).toBe("renoxium.app");
    expect(c.dashboardUrl).toBe("https://dashboard.renoxium.com");
    expect(c.apiUrl).toBe("https://api.renoxium.com");
    expect(c.securityContacts).toEqual(["mailto:security@renoxium.com"]);
    expect(c.abuseContact).toBe("abuse@renoxium.com");
    expect(JSON.stringify(DEFAULTS)).not.toMatch(/renox\.(app|dev)/u);
  });

  test("every default is overridden by its variable", () => {
    const c = loadConfig({
      CONTROL_PLATFORM_DOMAIN: "apps.example.test",
      CONTROL_DASHBOARD_URL: "https://console.example.test",
      CONTROL_API_URL: "https://api.example.test",
      CONTROL_SECURITY_CONTACTS: "mailto:sec@example.test, https://example.test/report",
      CONTROL_ABUSE_CONTACT: "abuse@example.test",
    });
    expect(c.platformDomain).toBe("apps.example.test");
    expect(c.dashboardUrl).toBe("https://console.example.test");
    expect(c.apiUrl).toBe("https://api.example.test");
    expect(c.securityContacts).toEqual(["mailto:sec@example.test", "https://example.test/report"]);
    expect(c.abuseContact).toBe("abuse@example.test");
  });
});

describe("security.txt of the API host from the config (#364)", () => {
  test("defaults name security@renoxium.com and the canonical URL on api.renoxium.com", async () => {
    const h = await harness();
    const text = securityTxt(h.deps);
    expect(text).toContain("Contact: mailto:security@renoxium.com\n");
    expect(text).toContain("Canonical: https://api.renoxium.com/.well-known/security.txt\n");
  });

  test("configured contacts and API origin replace the defaults", async () => {
    const h = await harness();
    h.deps.config.securityContacts = ["mailto:sec@example.test"];
    h.deps.config.apiUrl = "https://api.example.test/";
    const text = securityTxt(h.deps);
    expect(text).toContain("Contact: mailto:sec@example.test\n");
    expect(text).not.toContain("renoxium.com");
    expect(text).toContain("Canonical: https://api.example.test/.well-known/security.txt\n");
  });
});

describe("mail texts from the config (#364)", () => {
  test("the takedown mail names the configured abuse address, and abuse@renoxium.com by default", async () => {
    const h = await harness();
    await signup(h, "owner@takedown.ae", "t_takedown");
    await mailOwner(h.deps, "t_takedown", "bankcopy.renoxium.app", "phishing");
    const first = h.mailer.last("owner@takedown.ae", "abuse_takedown");
    expect(first?.subject).toBe("Your Renoxium tenant was taken down after an abuse report");
    expect(first?.text).toContain("reply to abuse@renoxium.com with the hostname");
    h.deps.config.abuseContact = "abuse@example.test";
    await mailOwner(h.deps, "t_takedown", "bankcopy.renoxium.app", "phishing");
    expect(h.mailer.last("owner@takedown.ae", "abuse_takedown")?.text).toContain("reply to abuse@example.test with the hostname");
  });

  test("the tier mails link the configured dashboard's billing page", () => {
    const m = tierMail("suspended", "grace", "t_x", [], 0, "https://console.example.test/");
    expect(m?.subject).toBe("Your Renoxium tenant is suspended");
    expect(m?.text).toContain("https://console.example.test/billing (tenant t_x)");
  });
});

describe("the CNAME target and the labels a person reads (#364)", () => {
  test("the custom-domain CNAME target is the Cloudflare fallback origin, edge.<platform domain> without one (#419)", async () => {
    const h = await harness();
    h.deps.config.platformDomain = loadConfig({}).platformDomain;
    configureDomains(h.deps, { cloudflare: null });
    expect(cnameTarget(h.deps)).toBe("edge.renoxium.app");
    const cf = loadConfig({ CONTROL_CF_API_TOKEN: "abcdefghij0123456789_-xy", CONTROL_CF_ZONE_ID: "0123456789abcdef0123456789abcdef", CONTROL_CF_FALLBACK_ORIGIN: "Edge.Example.Test" }).cloudflare;
    expect(cf?.fallbackOrigin).toBe("edge.example.test");
  });

  test("the TOTP issuer and the passkey relying party's name are Renoxium; the rp id is the dashboard's host", async () => {
    const h = await harness();
    h.deps.config.dashboardUrl = DEFAULTS.dashboardUrl;
    const s = await signup(h, "brand@example.test", "t-brand");
    const totp = (await (await h.request("POST", "/v1/account/mfa/totp", { session: s, json: {} })).json()) as { otpauth_uri: string };
    expect(totp.otpauth_uri).toStartWith("otpauth://totp/Renoxium:");
    expect(new URL(totp.otpauth_uri).searchParams.get("issuer")).toBe("Renoxium");
    // mfa.test.ts sets MFA_RP_ID for the whole process; without it the rp id is the dashboard's host.
    const saved = { id: process.env.MFA_RP_ID, origin: process.env.MFA_ORIGIN };
    delete process.env.MFA_RP_ID;
    delete process.env.MFA_ORIGIN;
    try {
      const opts = (await (await h.request("POST", "/v1/account/mfa/passkeys/options", { session: s, json: {} })).json()) as { rp: { id: string; name: string } };
      expect(opts.rp).toEqual({ id: "dashboard.renoxium.com", name: "Renoxium" });
    } finally {
      if (saved.id !== undefined) process.env.MFA_RP_ID = saved.id;
      if (saved.origin !== undefined) process.env.MFA_ORIGIN = saved.origin;
    }
  });

  test("the MCP resource is named Renoxium platform MCP", async () => {
    const h = await harness();
    const prm = (await (await h.request("GET", "/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(prm.resource_name).toBe("Renoxium platform MCP");
  });
});
