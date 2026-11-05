// Browser calls from the dashboard (#445, ADR D23). The dashboard must not
// proxy sign-up, login or the mail flows: the API's per-IP buckets would see
// the node's address for every user. So the dashboard's pages call these
// operations from the browser, with the API's own session cookie
// (`__Host-renox_session`, SameSite=Strict; dashboard and API are one site)
// and its CSRF header.
//
// CORS is answered for exactly one origin, the dashboard's
// (`CONTROL_DASHBOARD_URL`), and only on the paths those pages use: the
// account, MFA and device operations under /v1/account and the tenant tokens
// under /v1/tokens. Any other origin, or any other path, gets no CORS
// headers, so the browser keeps refusing it (docs/24-threat-model.md E,
// "Cross-site request to the API": SameSite=Strict, the CSRF header and this
// allowlist are three separate layers).

import type { MiddlewareHandler } from "hono";

import type { Deps, Env } from "./context.ts";
import { CSRF_HEADER } from "./auth/sessions.ts";

/** The paths a browser on the dashboard may call. */
export function corsPath(path: string): boolean {
  const p = path.toLowerCase().replace(/\/{2,}/gu, "/");
  return p === "/v1/account" || p.startsWith("/v1/account/") || p === "/v1/tokens" || p.startsWith("/v1/tokens/");
}

/** The origin of a configured URL, or null when it does not parse. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export const CORS_METHODS = "GET, POST, DELETE";
export const CORS_HEADERS = `content-type, ${CSRF_HEADER}`;
/** Headers a page may read: the wait of a 429 and the request id it quotes. */
export const CORS_EXPOSE = "retry-after, x-renox-request-id";

export function cors(deps: Deps): MiddlewareHandler<Env> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    const allowed = originOf(deps.config.dashboardUrl);
    const match = origin !== undefined && allowed !== null && origin === allowed && corsPath(c.req.path);
    if (c.req.method === "OPTIONS" && c.req.header("access-control-request-method") !== undefined) {
      // A preflight: answered here, before any route, auth or bucket.
      if (!match) return c.body(null, 204, { vary: "Origin" });
      return c.body(null, 204, {
        "access-control-allow-origin": origin as string,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": CORS_METHODS,
        "access-control-allow-headers": CORS_HEADERS,
        "access-control-max-age": "600",
        vary: "Origin",
      });
    }
    await next();
    if (!match) return;
    c.res.headers.set("access-control-allow-origin", origin as string);
    c.res.headers.set("access-control-allow-credentials", "true");
    c.res.headers.set("access-control-expose-headers", CORS_EXPOSE);
    c.res.headers.append("vary", "Origin");
  };
}
