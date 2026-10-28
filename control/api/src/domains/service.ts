// The per-process domain machinery: DNS resolver, ACME client, challenge
// responder, the edge the hostnames must point at, and the delivery of
// certificate messages to nodes. Configured from the environment (variables
// in src/domains/README.md); tests replace the parts with `configureDomains`.

import type { Deps } from "../context.ts";
import { EnvMasterKey, type KeyProvider } from "../secrets/crypto.ts";
import { routeService } from "../routes/service.ts";
import { AcmeClient, type CertificateIssuer } from "./acme.ts";
import { accountStore } from "./certs.ts";
import { DirChallengeResponder, type ChallengeResponder } from "./challenges.ts";
import { SystemResolver, type Edge, type Resolver } from "./dns.ts";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** deploy-api.md section 10: certificate messages to the nodes of every API instance. */
export const CERTIFICATES_CHANNEL = "renox_certificates";

export interface DomainService {
  resolver: Resolver;
  /** null: no ACME directory configured; verified domains stay without a certificate. */
  issuer: CertificateIssuer | null;
  responder: ChallengeResponder | null;
  edge: Edge;
  /** null: no master key; certificates cannot be stored or served. */
  keys: KeyProvider | null;
  /** This instance, so it ignores its own notifications. */
  instance: string;
}

type Env = Record<string, string | undefined>;

const list = (v: string | undefined): string[] => (v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

export function domainServiceFromEnv(deps: Deps, env: Env = process.env): DomainService {
  const keys = deps.config.masterKey === null ? null : new EnvMasterKey(deps.config.masterKey);
  const directoryUrl = env.CONTROL_ACME_DIRECTORY_URL;
  const challengeDir = env.CONTROL_ACME_CHALLENGE_DIR;
  const responder = challengeDir === undefined ? null : new DirChallengeResponder(challengeDir);
  const issuer =
    directoryUrl === undefined || keys === null || responder === null
      ? null
      : new AcmeClient(
          {
            directoryUrl,
            ...(env.CONTROL_ACME_CA_FILE === undefined ? {} : { ca: readFileSync(env.CONTROL_ACME_CA_FILE, "utf8") }),
            ...(env.CONTROL_ACME_EMAIL === undefined ? {} : { contact: env.CONTROL_ACME_EMAIL }),
          },
          accountStore(deps.db, keys, directoryUrl, deps.now),
        );
  return {
    resolver: new SystemResolver(list(env.CONTROL_DNS_SERVERS)),
    issuer,
    responder,
    edge: { hostname: env.CONTROL_EDGE_HOSTNAME ?? `edge.${deps.config.platformDomain}`, addresses: list(env.CONTROL_EDGE_ADDRESSES) },
    keys,
    instance: randomUUID(),
  };
}

const services = new WeakMap<Deps, DomainService>();

export function domainService(deps: Deps): DomainService {
  let s = services.get(deps);
  if (s === undefined) {
    s = domainServiceFromEnv(deps, {});
    services.set(deps, s);
  }
  return s;
}

/** Replaces parts of the service (main.ts with the environment; tests with stubs). */
export function configureDomains(deps: Deps, parts: Partial<DomainService>): DomainService {
  const s = { ...domainService(deps), ...parts };
  services.set(deps, s);
  return s;
}

export type CertificateMessage =
  | { type: "certificate_update"; schema_version: 0; hostname: string; version: number; not_after: number }
  | { type: "certificate_remove"; schema_version: 0; hostname: string; version: number };

/** Sends a certificate message to this instance's nodes and, through NOTIFY, to the other instances' nodes. */
export async function sendCertificateMessage(deps: Deps, message: CertificateMessage): Promise<void> {
  const s = domainService(deps);
  routeService(deps).hub.broadcast(message);
  await deps.db.query("select pg_notify($1, $2)", [CERTIFICATES_CHANNEL, JSON.stringify({ from: s.instance, message })]).catch(() => {});
}

/** Forwards the other instances' certificate messages to this instance's nodes. */
export function listenCertificates(deps: Deps): Promise<() => Promise<void>> {
  return deps.db.listen(CERTIFICATES_CHANNEL, (payload) => {
    try {
      const { from, message } = JSON.parse(payload) as { from: string; message: CertificateMessage };
      if (from !== domainService(deps).instance) routeService(deps).hub.broadcast(message);
    } catch {
      // Not ours.
    }
  });
}
