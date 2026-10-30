// `GET /.well-known/security.txt` on the control API's own host (#310;
// RFC 9116; docs/24-threat-model.md "Vulnerability disclosure"). The same
// fields as the gateway's file for the platform hosts
// (crates/renox-gateway/src/well_known.rs): the contacts, English and
// Arabic, a canonical URL on this host, and `Expires` 180 days ahead.

import type { Hono } from "hono";
import { operation } from "./audit.ts";
import type { Deps, Env } from "./context.ts";

/** RFC 9116 section 2.5.5: less than a year; the gateway uses 180 days. */
export const EXPIRES_AFTER_MS = 180 * 86_400_000;

export function securityTxt(deps: Deps): string {
  const contacts = deps.config.securityContacts ?? ["mailto:security@renox.app"];
  const lines = contacts.map((c) => `Contact: ${c}`);
  lines.push(`Expires: ${new Date(deps.now() + EXPIRES_AFTER_MS).toISOString().replace(/\.\d{3}Z$/u, "Z")}`);
  if ((deps.config.securityPolicy ?? null) !== null) lines.push(`Policy: ${deps.config.securityPolicy}`);
  lines.push(`Canonical: https://api.${deps.config.platformDomain}/.well-known/security.txt`);
  lines.push("Preferred-Languages: en, ar");
  return `${lines.join("\n")}\n`;
}

export function registerWellKnown(app: Hono<Env>, deps: Deps): void {
  app.get("/.well-known/security.txt", operation(deps, "getSecurityTxt"), (c) =>
    c.body(securityTxt(deps), 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "max-age=86400" }),
  );
}
