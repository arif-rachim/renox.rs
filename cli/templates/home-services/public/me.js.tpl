// The technician pages' script (a public file, not an inline script: the CSP refuses
// inline scripts). It registers the service worker (public/sw.js, scope /me), asks it to
// keep today's visit pages, and says when the page on screen is a saved copy:
//
// - `GET /me/ping` (204 for a signed-in technician) tells a phone that is online from
//   one that only has a network interface. Online: the banner hides, the user id of the
//   answer (`x-hs-user`) is kept in IndexedDB for the worker, and the saved copies of
//   any other user are deleted. 401, 403 or a redirect (signed out, or not a
//   technician): every `hs-day-*` cache and the kept user id are deleted. No answer:
//   the banner shows the time of the copy (`data-saved-at` of #offline-banner).
// - On /me, the links carrying `data-prefetch` are today's visits: at most 15 are sent
//   to the worker, which fetches and keeps them one at a time.
(() => {
  const DB = "hs-offline";
  const KV = "kv";
  const DAY = "hs-day-";
  const MAX_PREFETCH = 15;

  /** One IndexedDB operation on the key-value store; resolves null when IndexedDB is not usable. */
  const kv = (mode, op) =>
    new Promise((resolve) => {
      try {
        const open = indexedDB.open(DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(KV);
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          const req = op(db.transaction(KV, mode).objectStore(KV));
          req.onsuccess = () => {
            db.close();
            resolve(req.result === undefined ? null : req.result);
          };
          req.onerror = () => {
            db.close();
            resolve(null);
          };
        };
      } catch {
        resolve(null);
      }
    });

  const dayCaches = async (keep) => {
    if (!("caches" in window)) return;
    const names = (await caches.keys()).filter((n) => n.startsWith(DAY) && n !== keep);
    await Promise.all(names.map((n) => caches.delete(n)));
  };

  const banner = () => document.getElementById("offline-banner");
  const showBanner = (on) => {
    const b = banner();
    if (!b) return;
    const time = document.getElementById("offline-time");
    if (on && time) time.textContent = b.dataset.savedAt || "";
    b.hidden = !on;
  };

  /** Registers the worker; the one an earlier version registered with scope /me/ goes. */
  const register = async () => {
    if (!("serviceWorker" in navigator)) return null;
    try {
      for (const r of await navigator.serviceWorker.getRegistrations()) {
        if (r.scope === `${location.origin}/me/`) await r.unregister();
      }
      return await navigator.serviceWorker.register("/sw.js", { scope: "/me" });
    } catch (e) {
      console.warn("sw", e);
      return null;
    }
  };

  const prefetch = async (firstLoad) => {
    if (!("serviceWorker" in navigator)) return;
    const urls = [...document.querySelectorAll("a[data-prefetch]")]
      .map((a) => a.getAttribute("href") || "")
      .filter((h) => /^\/me\/visits\/[^/?#]+$/u.test(h))
      .slice(0, MAX_PREFETCH);
    // The page that registered the worker was not seen by it: keep it too.
    if (firstLoad && /^\/me\/?$/u.test(location.pathname)) urls.unshift(`/me${location.search}`);
    if (urls.length === 0) return;
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) reg.active.postMessage({ type: "prefetch", urls: urls.slice(0, MAX_PREFETCH + 1) });
  };

  /** Asks the server; "online", "out" (signed out or not a technician) or "offline". */
  const ping = async () => {
    if (!navigator.onLine) return { state: "offline" };
    try {
      const res = await fetch("/me/ping", { cache: "no-store", credentials: "same-origin", redirect: "manual" });
      if (res.status === 204) return { state: "online", user: res.headers.get("x-hs-user") || "" };
      if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) return { state: "out" };
      // Any other answer (a 5xx from the edge or the app): the server is not usable, nothing says the user signed out.
      return { state: "offline" };
    } catch {
      return { state: "offline" };
    }
  };

  let started = false;
  const check = async () => {
    const hasCopies = "caches" in window && (await caches.keys()).some((n) => n.startsWith(DAY));
    // Not a technician's page and nothing saved: no request at all (public pages, the office).
    if (!banner() && !hasCopies && (await kv("readonly", (s) => s.get("user"))) === null) return;
    const answer = await ping();
    if (answer.state === "offline") return showBanner(true);
    showBanner(false);
    if (answer.state === "out") {
      await dayCaches(null);
      await kv("readwrite", (s) => s.delete("user"));
      return;
    }
    if (/^[A-Za-z0-9_-]{1,64}$/u.test(answer.user)) {
      await kv("readwrite", (s) => s.put(answer.user, "user"));
      await dayCaches(`${DAY}v1-${answer.user}`);
    }
    if (!started) {
      started = true;
      prefetch(!navigator.serviceWorker || !navigator.serviceWorker.controller).catch(() => {});
    }
  };

  document.addEventListener("DOMContentLoaded", async () => {
    await register();
    check();
  });
  window.addEventListener("online", check);
  window.addEventListener("offline", () => showBanner(true));
})();
