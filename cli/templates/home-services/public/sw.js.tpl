// The service worker of the technician pages (registered by /me.js, scope /me/).
// It caches the static shell only; pages, /me/*, uploads and the live channels
// always go to the network. The build serves a public file a template links
// under a content-hashed name (/app.<16 hex>.css), immutable, so those are
// cached on first use; the icons and the font are cached at install.
const CACHE = "hs-shell-v1";
const SHELL = ["/icons/icon-192.png", "/icons/icon-512.png", "/doto-black.woff2"];
const HASHED = /^\/(?:[^/]+\/)*[^/]+\.[0-9a-f]{16}\.(css|js|woff2|png|svg)$/u;
const NEVER = /^\/(me|_files|sse|ws)(\/|$)/u;

const isShell = (path) => !NEVER.test(path) && (SHELL.includes(path) || HASHED.test(path));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !isShell(url.pathname)) return;
  event.respondWith(
    caches.match(req).then(
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
