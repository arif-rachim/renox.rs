// The page entry of renox-client.js: installs the capture on the real
// browser globals and exposes `renox.client.setExtra()` / `flush()`.
import { install } from "./index.ts";

{
  const c = install({
    window,
    document,
    location,
    navigator,
    console,
    fetch: (u, i) => fetch(u, i),
    now: () => Date.now(),
    random: (b) => crypto.getRandomValues(b),
    setTimeout: (f, ms) => setTimeout(f, ms),
    CustomEvent,
  });
  const g = globalThis as { renox?: Record<string, unknown> };
  g.renox = Object.assign(g.renox ?? {}, { client: { setExtra: c.setExtra, flush: c.flush } });
}
