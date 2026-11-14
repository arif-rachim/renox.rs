// The service worker of the technician pages (registered by /me.js, scope /me).
//
// 1. The static shell: hashed files and the icons, cache `hs-shell-v1`.
//    The build serves a public file a template links under a content-hashed
//    name (/app.<16 hex>.css), immutable, so those are cached on first use; the
//    icons and the font are cached at install.
// 2. Today's pages (#807): navigations to /me and /me/visits/<id> only (no query
//    but `lang`), network first with a 4 s timeout, kept in the cache
//    `hs-day-v1-<user id>` and served from it, with `x-hs-from-cache: 1`, when the
//    network fails. A page is stored only when it answers 200 text/html with the
//    header `x-hs-offline-ok: 1`, which only those two loaders set, so no other
//    route, error page or sign-in redirect ever enters the cache. The visit
//    page's /_img thumbnails are cache-first in the same cache, at most 60.
//    A copy is served only for the user id me.js keeps in IndexedDB at each
//    online load; a cache older than 20 hours is deleted at activate and
//    before each store. Everything else under /me, /_files, /sse and /ws goes
//    to the network.
const CACHE = "hs-shell-v1";
const SHELL = ["/icons/icon-192.png", "/icons/icon-512.png", "/doto-black.woff2"];
const HASHED = /^\/(?:[^/]+\/)*[^/]+\.[0-9a-f]{16}\.(css|js|woff2|png|svg)$/u;
const NEVER = /^\/(me|_files|sse|ws)(\/|$)/u;

const DAY = "hs-day-v1-";
const DAY_PAGE = /^\/me(\/visits\/[^/]+)?$/u;
const THUMB = /^\/_img\//u;
const NET_TIMEOUT_MS = 4000;
const MAX_AGE_MS = 20 * 3600 * 1000;
const MAX_THUMBS = 60;
const MAX_PREFETCH = 15;
const STAMP = "/__hs-day-stamp";
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/u;

const isShell = (path) => !NEVER.test(path) && (SHELL.includes(path) || HASHED.test(path));
// Only `lang` may ride on a cached page's address.
const plainQuery = (url) => [...url.searchParams.keys()].every((k) => k === "lang");
const isDayPage = (url) => url.origin === self.location.origin && DAY_PAGE.test(url.pathname) && plainQuery(url);

// ---- who the copy belongs to: IndexedDB `hs-offline` / `kv` / `user`, written by me.js (the stores `actions` and `photos` are the offline queue's) ----
function storedUser() {
  return new Promise((resolve) => {
    try {
      // The same database, version and stores as public/me.js (which documents them): keep both in step.
      const open = indexedDB.open("hs-offline", 3);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("actions")) db.createObjectStore("actions", { keyPath: "seq", autoIncrement: true });
        if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id", autoIncrement: true });
      };
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        const db = open.result;
        const get = db.transaction("kv", "readonly").objectStore("kv").get("user");
        get.onsuccess = () => {
          db.close();
          resolve(typeof get.result === "string" && USER_ID.test(get.result) ? get.result : null);
        };
        get.onerror = () => {
          db.close();
          resolve(null);
        };
      };
    } catch {
      resolve(null);
    }
  });
}

// ---- the day caches ----
const stampRequest = () => new Request(self.location.origin + STAMP);

/** Deletes every `hs-day-*` cache that is not of the current version or is 20 hours old. A cache without its stamp is deleted too. */
async function purgeOld() {
  const now = Date.now();
  for (const name of await caches.keys()) {
    if (!name.startsWith("hs-day-")) continue;
    let keep = false;
    if (name.startsWith(DAY)) {
      const cache = await caches.open(name);
      const stamp = await cache.match(stampRequest());
      const created = stamp ? Number(await stamp.text()) : NaN;
      keep = Number.isFinite(created) && now - created < MAX_AGE_MS;
    }
    if (!keep) await caches.delete(name);
  }
}

/**
 * Every write to a day cache runs one after the other: a store that purges (purgeOld) while another has opened its
 * cache but not stamped it yet would delete that cache as "without a stamp" (a navigation and the prefetch store at
 * the same time).
 */
let writes = Promise.resolve();
const serial = (fn) => {
  const run = writes.then(fn, fn);
  writes = run.catch(() => {}); // renox-allow-global: the browser service worker's write chain, not request isolate state
  return run;
};

/** The cache of one user, with its creation time stamped on first use. */
async function openDay(user) {
  const cache = await caches.open(DAY + user);
  if (!(await cache.match(stampRequest()))) await cache.put(stampRequest(), new Response(String(Date.now())));
  return cache;
}

/** The user id of a page: its `<meta name="hs-user">`, or null when it has none or it is not a plain id. */
function userOfPage(html) {
  const tag = /<meta\b[^>]*\bname=["']hs-user["'][^>]*>/iu.exec(html);
  const id = tag && /\bcontent=["']([^"']*)["']/iu.exec(tag[0]);
  return id && USER_ID.test(id[1]) ? id[1] : null;
}

/** Stores a network answer of a day page when, and only when, it is the loader's own (see the header comment). */
async function storeDayPage(url, res) {
  if (res.status !== 200 || res.headers.get("x-hs-offline-ok") !== "1") return;
  if (!(res.headers.get("content-type") || "").toLowerCase().startsWith("text/html")) return;
  const copy = res.clone();
  const user = userOfPage(await res.text());
  if (user === null) return;
  await serial(async () => {
    await purgeOld();
    const cache = await openDay(user);
    await cache.put(new Request(url), copy);
  });
}

/** A thumbnail, kept at most MAX_THUMBS (the oldest go first). */
async function storeThumb(req, res, user) {
  await serial(async () => {
    await purgeOld();
    const cache = await openDay(user);
    await cache.put(req, res);
    const keys = (await cache.keys()).filter((k) => THUMB.test(new URL(k.url).pathname));
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_THUMBS))) await cache.delete(old);
  });
}

const fromCache = async (hit) => {
  const headers = new Headers(hit.headers);
  headers.set("x-hs-from-cache", "1");
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
};

/** The saved copy of a page for the user me.js last saw online, or undefined. */
async function savedCopy(url) {
  const user = await storedUser();
  if (user === null) return undefined;
  const cache = await caches.open(DAY + user);
  // `/me/` (the manifest's start_url) is the same page as `/me`.
  const path = url.pathname === "/me/" ? "/me" : url.pathname;
  const hit = await cache.match(new Request(url.origin + path + url.search), { ignoreVary: true });
  return hit ? fromCache(hit) : undefined;
}

function dayPage(event, req, url) {
  const store = (res) => {
    event.waitUntil(storeDayPage(req.url, res.clone()).catch(() => {}));
    return res;
  };
  const network = fetch(req).then(store);
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => savedCopy(url).then(resolve, () => resolve(undefined)), NET_TIMEOUT_MS);
  });
  const answer = network
    .then((res) => {
      clearTimeout(timer);
      return res;
    })
    .catch(async (err) => {
      clearTimeout(timer);
      const hit = await savedCopy(url).catch(() => undefined);
      if (hit) return hit;
      throw err;
    });
  // After the timeout the saved copy answers if there is one; with none the network is still waited for.
  return Promise.race([answer, late.then((hit) => hit || answer)]);
}

// ---- prefetch: me.js asks for today's visit pages, one at a time ----
async function prefetch(urls) {
  for (const raw of urls.slice(0, MAX_PREFETCH)) {
    try {
      const url = new URL(raw, self.location.origin);
      if (!isDayPage(url)) continue;
      const res = await fetch(url.href, { credentials: "same-origin" });
      await storeDayPage(url.href, res);
    } catch {
      // Offline or refused: the page is simply not kept.
    }
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  // Only a page of this origin, which is a window, may ask.
  if (!data || data.type !== "prefetch" || !Array.isArray(data.urls) || !event.source || event.source.type !== "window") return;
  event.waitUntil(prefetch(data.urls.filter((u) => typeof u === "string")));
});

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE && !k.startsWith("hs-day-")).map((k) => caches.delete(k)));
      await serial(purgeOld);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" && (isDayPage(url) || (url.pathname === "/me/" && plainQuery(url)))) {
    event.respondWith(dayPage(event, req, url));
    return;
  }
  if (THUMB.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const user = await storedUser();
        if (user === null) return fetch(req);
        const hit = await (await caches.open(DAY + user)).match(req, { ignoreVary: true });
        if (hit) return hit;
        const res = await fetch(req);
        if (res.status === 200 && (res.headers.get("content-type") || "").startsWith("image/")) {
          event.waitUntil(storeThumb(req, res.clone(), user).catch(() => {}));
        }
        return res;
      })(),
    );
    return;
  }
  if (!isShell(url.pathname)) return;
  event.respondWith(
    caches.match(req, { cacheName: CACHE }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
