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
  // The one IndexedDB database of the technician pages (#807, #808, #809): `kv` keeps the signed-in user id for the
  // service worker, `actions` is the offline action queue and `photos` the photos taken offline
  // (public/offline-queue.js). Version 2 added `actions`, version 3 `photos`.
  // public/sw.js opens the same database and must name the same version and stores: keep both in step
  // (tests/offline-queue.test.ts compares them).
  const DB = "hs-offline";
  const DB_VERSION = 3;
  const KV = "kv";
  const DAY = "hs-day-";
  const MAX_PREFETCH = 15;

  /** Opens `hs-offline`, creating the stores a version lacks; resolves null when IndexedDB is not usable. */
  const openDb = () =>
    new Promise((resolve) => {
      try {
        const open = indexedDB.open(DB, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
          if (!db.objectStoreNames.contains("actions")) db.createObjectStore("actions", { keyPath: "seq", autoIncrement: true });
          if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id", autoIncrement: true });
        };
        open.onerror = () => resolve(null);
        open.onsuccess = () => resolve(open.result);
      } catch {
        resolve(null);
      }
    });

  /** One IndexedDB operation on the key-value store; resolves null when IndexedDB is not usable. */
  const kv = async (mode, op) => {
    const db = await openDb();
    if (db === null) return null;
    return new Promise((resolve) => {
      try {
        const req = op(db.transaction(KV, mode).objectStore(KV));
        req.onsuccess = () => {
          db.close();
          resolve(req.result === undefined ? null : req.result);
        };
        req.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    });
  };

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

  /**
   * Whether this document came through the service worker. Not `navigator.serviceWorker.controller`: the worker's
   * `clients.claim()` may set it after a page that the worker never saw was loaded, and that page must be kept too.
   */
  const servedByWorker = () => {
    const nav = typeof performance !== "undefined" && performance.getEntriesByType ? performance.getEntriesByType("navigation")[0] : undefined;
    return nav !== undefined && nav.workerStart > 0;
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

  /** Asks the server; "online", "out" (signed out or not a technician) or "offline". No answer in 8 s is "offline". */
  const ping = async () => {
    if (!navigator.onLine) return { state: "offline" };
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 8000);
    try {
      const res = await fetch("/me/ping", { cache: "no-store", credentials: "same-origin", redirect: "manual", signal: stop.signal });
      if (res.status === 204) return { state: "online", user: res.headers.get("x-hs-user") || "" };
      if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) return { state: "out" };
      // Any other answer (a 5xx from the edge or the app): the server is not usable, nothing says the user signed out.
      return { state: "offline" };
    } catch {
      return { state: "offline" };
    } finally {
      clearTimeout(timer);
    }
  };

  // The offline queue (public/offline-queue.js, #808) asks the same question and opens the same database.
  window.hsMe = { ping, openDb };

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
      prefetch(!servedByWorker()).catch(() => {});
    }
  };

  document.addEventListener("DOMContentLoaded", async () => {
    await register();
    check();
  });
  window.addEventListener("online", check);
  window.addEventListener("offline", () => showBanner(true));
})();
