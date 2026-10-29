// Open-redirect protection (docs/24-threat-model.md, "Open redirect via
// `next`/`return_to`"; #111). `redirect.safe(target)` redirects only to a
// path of the app itself or to an origin listed in `allow`; anything else
// (another site, `//evil.example`, `/\evil.example`, `javascript:`, a
// relative path without a leading `/`) redirects to `fallback` instead.
// `renox check` reports `Response.redirect()` with a target taken from the
// request (`no-unsafe-redirect`).

export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

export interface SafeRedirectOptions {
  /** Origins other than the app's own that may be redirected to, e.g. `"https://accounts.example.com"`. */
  readonly allow?: readonly string[];
  /** Where an unsafe target goes instead: a path of the app (default `"/"`). */
  readonly fallback?: string;
  /** Default 303 (See Other): the right answer to a form `POST`. */
  readonly status?: RedirectStatus;
}

// Browsers drop tabs and newlines inside URLs and treat `\` as `/`, so
// "/\tevil.example" and "/\\evil.example" are protocol-relative to them.
const CONTROL = /[\u0000-\u001f\u007f]/u;

function origins(allow: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const a of allow) {
    try {
      const u = new URL(a);
      if (u.protocol === "https:" || u.protocol === "http:") out.add(u.origin);
    } catch {
      // An entry that is not an absolute URL allows nothing.
    }
  }
  return out;
}

/**
 * The `Location` to send for `target`, or `null` when it is not safe: a
 * path of this app (`/…`, not `//…`, no `\`, no control characters), or an
 * absolute `http(s)` URL whose origin is in `allow`.
 */
export function safeRedirectTarget(target: string, allow: readonly string[] = []): string | null {
  if (typeof target !== "string" || target.length === 0 || target.length > 2048) return null;
  if (CONTROL.test(target) || target.includes("\\")) return null;
  if (target.startsWith("/")) return target.startsWith("//") ? null : target;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return origins(allow).has(url.origin) ? url.href : null;
}

export const redirect = {
  /** A redirect `Response` to `target` if it is safe (see {@link safeRedirectTarget}), else to `fallback`. */
  safe(target: string, options: SafeRedirectOptions = {}): Response {
    const fallback = safeRedirectTarget(options.fallback ?? "/") ?? "/";
    const location = safeRedirectTarget(target, options.allow ?? []) ?? fallback;
    return new Response(null, { status: options.status ?? 303, headers: { location } });
  },
};
