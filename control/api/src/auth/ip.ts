// The client address of a request. By default the socket address Bun reports:
// a forwarded-for header is never trusted. With `CONTROL_TRUSTED_PROXIES`
// (#366) the public listener sits behind a proxy on a known address (on the
// single host: `cloudflared` on loopback, ops/single-host.md); a request whose
// socket peer is one of those addresses takes its client address from
// `CONTROL_CLIENT_IP_HEADER` (default `CF-Connecting-IP`). A request from any
// other peer keeps its socket address, whatever header it sends, and a header
// that is missing, malformed or carries more than one value falls back to the
// peer address. The per-IP buckets of sign-up, login and mail key on the
// result (docs/24-threat-model.md, "Login brute force…", "Bot signups").

import { BlockList, isIP } from "node:net";
import type { Context } from "hono";
import type { Env } from "../context.ts";

/** What Bun passes as the second argument of `fetch`: the server, which knows each request's socket address. */
export interface AddressSource {
  requestIP?: (req: Request) => { address: string } | null;
}

export function clientIp(c: Context<Env>): string | null {
  const server = c.env as AddressSource | undefined;
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? null;
  } catch {
    return null;
  }
}

/** `::ffff:192.0.2.1` (an IPv4 peer on a dual-stack socket) → `192.0.2.1`; anything else unchanged. */
export function normalizeIp(address: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  return m !== null && isIP(m[1] as string) === 4 ? (m[1] as string) : address;
}

/** Parses one `CONTROL_TRUSTED_PROXIES` entry, an address or a CIDR; null when it is neither. */
export function parseProxyEntry(entry: string): { address: string; prefix: number; family: 4 | 6 } | null {
  const [address, prefixText, extra] = entry.split("/");
  if (address === undefined || extra !== undefined) return null;
  const family = isIP(address);
  if (family !== 4 && family !== 6) return null;
  const max = family === 4 ? 32 : 128;
  if (prefixText === undefined) return { address, prefix: max, family };
  if (!/^\d{1,3}$/u.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > max) return null;
  return { address, prefix, family };
}

/** The set of trusted proxy addresses. Throws on an entry that is not an address or a CIDR (config.ts checks first). */
export class TrustedProxies {
  private readonly list = new BlockList();
  readonly size: number;
  constructor(readonly entries: readonly string[]) {
    for (const entry of entries) {
      const p = parseProxyEntry(entry);
      if (p === null) throw new Error(`not an address or a CIDR: ${entry}`);
      this.list.addSubnet(p.address, p.prefix, p.family === 4 ? "ipv4" : "ipv6");
    }
    this.size = entries.length;
  }
  has(address: string): boolean {
    const a = normalizeIp(address);
    const family = isIP(a);
    if (family === 0) return false;
    return this.list.check(a, family === 4 ? "ipv4" : "ipv6");
  }
  /** True when every entry lies inside 127.0.0.0/8 or is ::1 (config.ts's listen check). */
  loopbackOnly(): boolean {
    return this.entries.every((entry) => {
      const p = parseProxyEntry(entry);
      if (p === null) return false;
      const a = normalizeIp(p.address);
      if (isIP(a) === 4) return p.prefix >= (p.family === 4 ? 8 : 104) && a.startsWith("127.");
      return p.prefix === 128 && LOOPBACK_V6.check(a, "ipv6");
    });
  }
}

const LOOPBACK_V6 = new BlockList();
LOOPBACK_V6.addAddress("::1", "ipv6");

/** The client address a header names: one address, nothing else; null otherwise. */
export function headerAddress(value: string | null): string | null {
  if (value === null) return null;
  const v = value.trim();
  if (v === "" || v.includes(",") || v.includes(" ")) return null;
  return isIP(v) === 0 ? null : normalizeIp(v);
}

/**
 * Wraps the server Bun passes to `fetch` (main.ts, the public listener) so that
 * `clientIp` sees the proxied client address for a request from a trusted
 * peer. With no trusted proxies it returns the server unchanged: today's
 * behaviour exactly.
 */
export function behindProxies(server: AddressSource, proxies: TrustedProxies, header: string): AddressSource {
  if (proxies.size === 0) return server;
  return {
    requestIP(req: Request) {
      const peer = server.requestIP?.(req) ?? null;
      if (peer === null) return null;
      if (!proxies.has(peer.address)) return peer;
      const forwarded = headerAddress(req.headers.get(header));
      return forwarded === null ? peer : { address: forwarded };
    },
  };
}
