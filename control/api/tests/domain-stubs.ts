// Stubs for the domain tests: a DNS resolver answering from maps, and
// self-signed certificates made by openssl.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssuedCertificate } from "../src/domains/acme.ts";
import type { Resolver } from "../src/domains/dns.ts";

export class StubResolver implements Resolver {
  readonly txts = new Map<string, string[]>();
  readonly cnames = new Map<string, string>();
  readonly addrs = new Map<string, string[]>();
  failing = false;
  /** TXT lookups made, by name. */
  readonly txtLookups = new Map<string, number>();
  /**
   * How many of the next TXT lookups of a name answer "no record" whatever
   * is set: a resolver's negative cache of an NXDOMAIN from before the record
   * existed (#398).
   */
  readonly staleNegatives = new Map<string, number>();
  async txt(name: string): Promise<string[]> {
    if (this.failing) throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
    this.txtLookups.set(name, (this.txtLookups.get(name) ?? 0) + 1);
    const stale = this.staleNegatives.get(name) ?? 0;
    if (stale > 0) {
      this.staleNegatives.set(name, stale - 1);
      return [];
    }
    return this.txts.get(name) ?? [];
  }
  async cname(name: string): Promise<string | null> {
    if (this.failing) throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
    return this.cnames.get(name) ?? null;
  }
  async addresses(name: string): Promise<string[]> {
    if (this.failing) throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
    return this.addrs.get(name) ?? [];
  }
}

/** A self-signed certificate for `hostname` valid `days` days from now, by openssl. */
export function selfSigned(hostname: string, days: number): IssuedCertificate {
  const dir = mkdtempSync(join(tmpdir(), "renox-cert-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", String(days),
    "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`,
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "ignore" });
  return { chainPem: readFileSync(join(dir, "cert.pem"), "utf8"), keyPem: readFileSync(join(dir, "key.pem"), "utf8") };
}

