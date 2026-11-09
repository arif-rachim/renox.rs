// Registers the service worker that caches the technician pages' static shell.
// A public file, not an inline script: the CSP refuses inline scripts.
document.addEventListener("DOMContentLoaded", () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/me/" }).catch((e) => console.warn("sw", e));
});
