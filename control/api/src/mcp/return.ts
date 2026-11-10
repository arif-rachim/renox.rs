// What the consent flow shares with sign-up (#688; docs/20-ai-agents-mcp.md
// 1b, "Sign-up inside the consent flow"): the sealed authorization request
// that a sign-up carries as `return_to`, the API's public origin, and the
// small HTML pages. Kept apart from oauth.ts so that auth/accounts.ts can use
// it without importing the OAuth routes.

import type { Context } from "hono";
import type { Deps, Env } from "../context.ts";
import { open, seal } from "./seal.ts";

/** The life of the sealed authorization request on the sign-up path: the owner has time to open the verification email. */
export const AUTHREQ_TTL_MS = 30 * 60_000;

/** The authorize parameters a sealed request keeps. */
const AUTHREQ_KEYS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;

interface AuthRequest {
  /** The authorize query, known keys only. */
  q: Record<string, string>;
  /** issued at */
  i: number;
  /** expires */
  e: number;
}

/**
 * The origin clients use for this API (the issuer): `CONTROL_MCP_URL` when set,
 * which it must be behind a TLS terminator that hands the request on as plain
 * http; otherwise the request's own origin.
 */
export const originOf = (c: Context<Env>, deps: Deps): string => deps.config.mcpUrl ?? new URL(c.req.url).origin;

/** The authorize query sealed for 30 minutes (`rnxreq_…`). */
export function sealAuthRequest(deps: Deps, query: Record<string, string | undefined>, now: number): string {
  const q: Record<string, string> = {};
  for (const k of AUTHREQ_KEYS) if (typeof query[k] === "string") q[k] = query[k] as string;
  return seal(deps, "authreq", "rnxreq_", { q, i: now, e: now + AUTHREQ_TTL_MS } satisfies AuthRequest);
}

/** The authorize query of a sealed request of this API, or null for anything else (never an error: a bad `return_to` is ignored). */
export function openAuthRequest(deps: Deps, sealed: unknown, now: number): { query: Record<string, string>; issuedAt: number; expired: boolean } | null {
  try {
    const r = open<AuthRequest>(deps, "authreq", "rnxreq_", typeof sealed === "string" ? sealed : null);
    if (r === null || typeof r.q !== "object" || r.q === null || typeof r.i !== "number" || typeof r.e !== "number") return null;
    const query: Record<string, string> = {};
    for (const k of AUTHREQ_KEYS) if (typeof r.q[k] === "string") query[k] = r.q[k] as string;
    return { query, issuedAt: r.i, expired: r.e < now };
  } catch {
    // No master key (503) or an unreadable value.
    return null;
  }
}

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/gu, (ch) => `&#${ch.charCodeAt(0)};`);

/** A small HTML page: no script, no external resource, never framed. `head` is trusted markup for the head (a refresh, for one). */
export function htmlPage(status: number, title: string, body: string, head = ""): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${head}<title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
