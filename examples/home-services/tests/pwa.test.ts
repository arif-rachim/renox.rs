// The installable technician pages (F7-132): the branded manifest, the service
// worker and the icons, and the layout's head tags.
import { describe, expect, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

const t = await app();
const PASSWORD = "correct horse battery";

const ali = t.as("ali");
const signedIn = await ali.action("/auth/login", "default", { email: "ali.dubai@fixit.example", password: PASSWORD, next: "/me" });
expect(signedIn.status).toBe(303);

describe("the manifest", () => {
  test("a technician gets the branded manifest", async () => {
    const res = await ali.request("GET", "/me/manifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/manifest+json");
    expect(res.headers.get("cache-control") ?? "").toContain("must-revalidate");
    const m = res.json() as Record<string, unknown>;
    expect(m.name).toBe("FixIt Services");
    expect(m.short_name).toBe("FixIt Servic");
    expect(m.start_url).toBe("/me/");
    expect(m.scope).toBe("/me/");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe("#1f6f5c");
    const icons = m.icons as { src: string; sizes: string; type: string }[];
    expect(icons.map((i) => i.src)).toEqual(["/icons/icon-192.png", "/icons/icon-512.png"]);
  });

  // A function route's guard answers 403 to the anonymous principal (only a page's guard redirects to the login).
  test("signed out is refused", async () => {
    const res = await t.request("GET", "/me/manifest");
    expect(res.status).toBe(403);
  });

  test("a dispatcher, who does not perform visits, is refused too", async () => {
    const dina = t.as("dina");
    await dina.action("/auth/login", "default", { email: "dispatcher.dubai@fixit.example", password: PASSWORD, next: "/" });
    expect((await dina.request("GET", "/me/manifest")).status).toBe(403);
  });
});

describe("the static files, without a session", () => {
  test("the service worker and the icons are public", async () => {
    const sw = await t.request("GET", "/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("content-type") ?? "").toBe("text/javascript; charset=utf-8");
    expect(sw.html).toContain("hs-shell-v1");
    for (const icon of ["/icons/icon-192.png", "/icons/icon-512.png"]) {
      const res = await t.request("GET", icon);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toBe("image/png");
    }
  });
});

describe("the layout head", () => {
  test("/me links the manifest, the theme colour and the registration script", async () => {
    const res = await ali.page("/me");
    expect(res.status).toBe(200);
    expect(res.html).toContain('rel="manifest" href="/me/manifest"');
    expect(res.html).toContain('<meta name="theme-color" content="#1f6f5c">');
    // The build links a public file under its content-hashed name.
    expect(res.html).toMatch(/rel="apple-touch-icon" href="\/icons\/icon-192\.[0-9a-f]{16}\.png"/u);
    expect(res.html).toMatch(/<script src="\/me\.[0-9a-f]{16}\.js" defer nonce="[^"]+"><\/script>/u);
  });
});
