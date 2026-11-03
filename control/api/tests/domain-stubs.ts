// StubCloudflare: Cloudflare for SaaS custom hostnames in memory (#419). The
// domain tests never call Cloudflare. A test moves a hostname through
// Cloudflare's statuses with `setStatus`, makes the API fail with `failing`,
// or "loses" a hostname with `forget`.

import type { CustomHostname, CustomHostnames } from "../src/domains/cloudflare.ts";
import { CloudflareError } from "../src/domains/cloudflare.ts";

export const EDGE = "edge.renoxium.app";

export class StubCloudflare implements CustomHostnames {
  readonly fallbackOrigin = EDGE;
  readonly hostnames = new Map<string, CustomHostname>();
  /** Every call, as `create <hostname>`, `get <id>`, `delete <id>`. */
  readonly calls: string[] = [];
  /** Every call fails with an API error (no verdict on any hostname). */
  failing = false;
  private next = 1;

  private check(): void {
    if (this.failing) throw new CloudflareError("Cloudflare read failed: HTTP 503", 503);
  }

  async create(hostname: string): Promise<CustomHostname> {
    this.calls.push(`create ${hostname}`);
    this.check();
    const existing = [...this.hostnames.values()].find((h) => h.hostname === hostname);
    if (existing !== undefined) return { ...existing };
    const id = `cf-${String(this.next++).padStart(4, "0")}`;
    const h: CustomHostname = {
      id,
      hostname,
      status: "pending",
      ssl_status: "pending_validation",
      verification: [
        { purpose: "ownership", type: "TXT", name: `_cf-custom-hostname.${hostname}`, value: `own-${id}` },
        { purpose: "dcv", type: "TXT", name: `_acme-challenge.${hostname}`, value: `dcv-${id}` },
      ],
      errors: [],
    };
    this.hostnames.set(id, h);
    return { ...h };
  }

  async get(id: string): Promise<CustomHostname | null> {
    this.calls.push(`get ${id}`);
    this.check();
    const h = this.hostnames.get(id);
    return h === undefined ? null : { ...h };
  }

  async delete(id: string): Promise<void> {
    this.calls.push(`delete ${id}`);
    this.check();
    this.hostnames.delete(id);
  }

  /** The custom hostname of `hostname`. */
  of(hostname: string): CustomHostname | undefined {
    return [...this.hostnames.values()].find((h) => h.hostname === hostname);
  }

  /** Cloudflare reports `status` for `hostname` from now on; `active` also clears the records. */
  setStatus(hostname: string, status: string, ssl = status === "active" ? "active" : "pending_validation"): void {
    const h = this.of(hostname);
    if (h === undefined) throw new Error(`no custom hostname ${hostname}`);
    this.hostnames.set(h.id, { ...h, status, ssl_status: ssl, verification: status === "active" ? [] : h.verification });
  }

  /** Cloudflare no longer knows the hostname (get answers not found). */
  forget(hostname: string): void {
    const h = this.of(hostname);
    if (h !== undefined) this.hostnames.delete(h.id);
  }
}
