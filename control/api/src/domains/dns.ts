// DNS checks of custom domains (docs/05-tenant-lifecycle.md "Attaching a
// domain"): the ownership TXT record, and whether the hostname points at
// the edge (a CNAME to the edge hostname, or addresses that are all edge
// addresses). The resolver is an interface so tests use a stub, and the
// end-to-end test a local DNS server.

import { Resolver as NodeResolver } from "node:dns/promises";

export interface Resolver {
  /** TXT strings of `name` (each record's chunks joined); [] when none. */
  txt(name: string): Promise<string[]>;
  /** The CNAME target of `name`, lower case, without the trailing dot; null when none. */
  cname(name: string): Promise<string | null>;
  /** A and AAAA addresses of `name`; [] when none. */
  addresses(name: string): Promise<string[]>;
}

/** Answers that mean "no such record", as opposed to a failed lookup. */
const ABSENT = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN", "ENONAME"]);

async function orEmpty<T>(p: Promise<T>, empty: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (ABSENT.has((e as { code?: string }).code ?? "")) return empty;
    throw e;
  }
}

export class SystemResolver implements Resolver {
  /** `servers`: `ip` or `ip:port`; empty uses the system's resolvers. */
  constructor(private readonly servers: string[] = []) {}
  /**
   * A new resolver per lookup: a resolver caches answers, also "no such
   * record", and a record the tenant just created must be seen at the next poll.
   */
  private fresh(): NodeResolver {
    const r = new NodeResolver({ timeout: 5_000, tries: 2 });
    if (this.servers.length > 0) r.setServers(this.servers);
    return r;
  }
  async txt(name: string): Promise<string[]> {
    return (await orEmpty(this.fresh().resolveTxt(name), [] as string[][])).map((chunks) => chunks.join(""));
  }
  async cname(name: string): Promise<string | null> {
    const [first] = await orEmpty(this.fresh().resolveCname(name), [] as string[]);
    return first === undefined ? null : first.toLowerCase().replace(/\.$/u, "");
  }
  async addresses(name: string): Promise<string[]> {
    const r = this.fresh();
    const [v4, v6] = await Promise.all([orEmpty(r.resolve4(name), [] as string[]), orEmpty(r.resolve6(name), [] as string[])]);
    return [...v4, ...v6];
  }
}

/** The name of the ownership record. */
export const verifyName = (hostname: string): string => `_renox-verify.${hostname}`;

/** True when a TXT record of `_renox-verify.<hostname>` equals `token`. */
export async function txtMatches(resolver: Resolver, hostname: string, token: string): Promise<boolean> {
  return (await resolver.txt(verifyName(hostname))).some((v) => v.trim() === token);
}

export interface Edge {
  /** The CNAME target tenants use (`edge.renox.app`). */
  hostname: string;
  /** Addresses an apex may point at with A/AAAA records. */
  addresses: string[];
}

/** True when `hostname` reaches the edge: a CNAME to the edge hostname, or only edge addresses. */
export async function pointsAtEdge(resolver: Resolver, hostname: string, edge: Edge): Promise<boolean> {
  const target = await resolver.cname(hostname);
  if (target !== null && target === edge.hostname) return true;
  const addresses = await resolver.addresses(hostname);
  return addresses.length > 0 && addresses.every((a) => edge.addresses.includes(a));
}
