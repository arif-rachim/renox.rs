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

describe("offline reading (#807): what the pages and /me/ping give the service worker", () => {
  const userOf = (html: string): string | null => /<meta name="hs-user" content="([^"]*)"/u.exec(html)?.[1] ?? null;

  test("/me and a visit page carry the user meta, the banner with the saved time, and no-store", async () => {
    for (const path of ["/me", "/me/visits/jb_seed_10"]) {
      const res = await ali.page(path);
      expect(res.status, path).toBe(200);
      expect(userOf(res.html), path).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
      expect(res.html, path).toMatch(/<p id="offline-banner" class="warning" hidden role="status" data-saved-at="\d{4}-\d{2}-\d{2} \d{2}:\d{2}">/u);
      expect(res.html, path).toContain("You are offline. Showing the copy saved at");
      expect(res.html, path).toContain('id="offline-time"');
      expect(res.headers.get("cache-control") ?? "", path).toContain("no-store");
    }
  });

  test("the user meta is the signed-in user's id, the one /me/ping answers", async () => {
    const page = await ali.page("/me");
    const ping = await ali.request("GET", "/me/ping");
    expect(userOf(page.html)).toBe(ping.headers.get("x-hs-user"));
    expect(userOf((await t.as("dina").page("/me")).html)).not.toBe(userOf(page.html));
  });

  test("the banner is in Arabic too", async () => {
    // `?lang=` is remembered for the user: put it back.
    const res = await ali.page("/me?lang=ar");
    await ali.page("/me?lang=en");
    expect(res.html).toContain("أنت غير متصل بالإنترنت. تعرض هذه الصفحة النسخة المحفوظة في");
  });

  test("the links to today's visits carry data-prefetch", async () => {
    const res = await ali.page("/me");
    expect(res.html).toMatch(/<a href="\/me\/visits\/[^"/]+" data-prefetch="" dir="ltr">/u);
  });

  test("an error page, /jobs and a dispatcher's /me never carry x-hs-offline-ok", async () => {
    const dina = t.as("dina");
    await dina.action("/auth/login", "default", { email: "dispatcher.dubai@fixit.example", password: PASSWORD, next: "/" });
    const none = await ali.page("/me/visits/jb_does_not_exist");
    expect(none.status).toBe(404);
    expect(none.headers.get("x-hs-offline-ok")).toBeNull();
    const jobs = await dina.page("/jobs");
    expect(jobs.status).toBe(200);
    expect(jobs.headers.get("x-hs-offline-ok")).toBeNull();
    const refused = await dina.page("/me");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-hs-offline-ok")).toBeNull();
    expect(userOf(refused.html)).toBeNull();
  });

  test("/me/ping is 204 for a technician, with no body and never cached", async () => {
    const res = await ali.request("GET", "/me/ping");
    expect(res.status).toBe(204);
    expect(res.html).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("/me/ping is refused to a signed-out request and to a dispatcher", async () => {
    expect((await t.request("GET", "/me/ping")).status).toBe(403);
    const dina = t.as("dina");
    await dina.action("/auth/login", "default", { email: "dispatcher.dubai@fixit.example", password: PASSWORD, next: "/" });
    expect((await dina.request("GET", "/me/ping")).status).toBe(403);
  });

  test("sw.js: JavaScript, no service-worker-allowed header, and the day cache of the worker", async () => {
    const sw = await t.request("GET", "/sw.js");
    expect(sw.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(sw.headers.get("service-worker-allowed")).toBeNull();
    expect(sw.html).toContain("hs-day-v1-");
    expect(sw.html).toContain("x-hs-offline-ok");
    expect(sw.html).toContain("x-hs-from-cache");
  });
});
