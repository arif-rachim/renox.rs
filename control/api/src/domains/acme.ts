// A minimal ACME client (RFC 8555) for one job: a certificate for one DNS
// name through HTTP-01. The account key is ECDSA P-256 (ES256); requests are
// JWS with the nonce of the previous response, retried once on badNonce.
// Tested against Pebble, Let's Encrypt's test server (tests/domains-e2e.test.ts).

import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { b64url, csrDer, keyPem, newCertificateKey } from "./csr.ts";
import type { ChallengeResponder } from "./challenges.ts";

export interface AcmeOptions {
  directoryUrl: string;
  /** Extra CA certificates (PEM) for the ACME server's TLS, e.g. Pebble's. */
  ca?: string;
  contact?: string;
  /** Polling of authorizations and orders. */
  pollMs?: number;
  timeoutMs?: number;
}

/** A saved account: its key (PKCS#8 PEM) and its URL (the JWS `kid`). */
export interface AcmeAccount {
  keyPem: string;
  kid: string;
}

export interface IssuedCertificate {
  chainPem: string;
  keyPem: string;
}

export class AcmeError extends Error {
  constructor(
    message: string,
    readonly problem?: { type?: string; detail?: string },
  ) {
    super(message);
  }
}

/** What the domain job needs from an ACME client; tests replace it. */
export interface CertificateIssuer {
  issue(hostname: string, responder: ChallengeResponder): Promise<IssuedCertificate>;
}

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The RFC 7638 thumbprint of a P-256 public key. */
export function thumbprint(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { crv: string; kty: string; x: string; y: string };
  return b64url(createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}

export class AcmeClient implements CertificateIssuer {
  private directory: Directory | null = null;
  private nonce: string | null = null;
  private key: KeyObject | null = null;
  private kid: string | null = null;

  /**
   * `load` returns the saved account for this directory or null; `save`
   * stores a new one (encrypted, src/domains/certs.ts).
   */
  constructor(
    private readonly options: AcmeOptions,
    private readonly accounts: { load(): Promise<AcmeAccount | null>; save(a: AcmeAccount): Promise<void> },
  ) {}

  private fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const tls = this.options.ca === undefined ? {} : { tls: { ca: [this.options.ca] } };
    return fetch(url, { ...init, ...tls, redirect: "error" } as RequestInit);
  }

  private async dir(): Promise<Directory> {
    if (this.directory === null) {
      const res = await this.fetch(this.options.directoryUrl);
      if (!res.ok) throw new AcmeError(`ACME directory answered ${res.status}`);
      this.directory = (await res.json()) as Directory;
    }
    return this.directory;
  }

  private async freshNonce(): Promise<string> {
    if (this.nonce !== null) {
      const n = this.nonce;
      this.nonce = null;
      return n;
    }
    const res = await this.fetch((await this.dir()).newNonce, { method: "HEAD" });
    const n = res.headers.get("replay-nonce");
    if (n === null) throw new AcmeError("ACME newNonce without Replay-Nonce");
    return n;
  }

  /** One signed POST; `payload` null is POST-as-GET. Retries once on badNonce. */
  private async post(url: string, payload: unknown, opts: { jwk?: boolean; accept?: string } = {}, retried = false): Promise<Response> {
    const key = this.key as KeyObject;
    const header: Record<string, unknown> = { alg: "ES256", nonce: await this.freshNonce(), url };
    if (opts.jwk === true) {
      const { crv, kty, x, y } = key.export({ format: "jwk" }) as Record<string, string>;
      header.jwk = { crv, kty, x, y };
    } else header.kid = this.kid;
    const protectedB64 = b64url(JSON.stringify(header));
    const payloadB64 = payload === null ? "" : b64url(JSON.stringify(payload));
    const signature = b64url(sign("sha256", Buffer.from(`${protectedB64}.${payloadB64}`), { key, dsaEncoding: "ieee-p1363" }));
    const res = await this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/jose+json", ...(opts.accept === undefined ? {} : { accept: opts.accept }) },
      body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature }),
    });
    this.nonce = res.headers.get("replay-nonce");
    if (res.status >= 400) {
      const problem = (await res.json().catch(() => ({}))) as { type?: string; detail?: string };
      if (problem.type === "urn:ietf:params:acme:error:badNonce" && !retried) return this.post(url, payload, opts, true);
      throw new AcmeError(`ACME ${new URL(url).pathname} answered ${res.status}: ${problem.type ?? "unknown"}`, problem);
    }
    return res;
  }

  private async account(): Promise<void> {
    if (this.key !== null) return;
    const saved = await this.accounts.load();
    if (saved !== null) {
      this.key = createPrivateKey(saved.keyPem);
      this.kid = saved.kid;
      return;
    }
    this.key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const contact = this.options.contact === undefined ? {} : { contact: [`mailto:${this.options.contact}`] };
    const res = await this.post((await this.dir()).newAccount, { termsOfServiceAgreed: true, ...contact }, { jwk: true });
    const kid = res.headers.get("location");
    if (kid === null) throw new AcmeError("ACME newAccount without Location");
    this.kid = kid;
    await this.accounts.save({ keyPem: keyPem(this.key), kid });
  }

  private async poll<T extends { status: string }>(url: string, done: (s: string) => boolean): Promise<T> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 120_000);
    for (;;) {
      const body = (await (await this.post(url, null)).json()) as T;
      if (done(body.status)) return body;
      if (Date.now() > deadline) throw new AcmeError(`ACME ${new URL(url).pathname} still ${body.status}`);
      await sleep(this.options.pollMs ?? 1_000);
    }
  }

  async issue(hostname: string, responder: ChallengeResponder): Promise<IssuedCertificate> {
    await this.account();
    const res = await this.post((await this.dir()).newOrder, { identifiers: [{ type: "dns", value: hostname }] });
    const orderUrl = res.headers.get("location");
    if (orderUrl === null) throw new AcmeError("ACME newOrder without Location");
    const order = (await res.json()) as { authorizations: string[]; finalize: string };
    const published: string[] = [];
    try {
      for (const authzUrl of order.authorizations) {
        const authz = (await (await this.post(authzUrl, null)).json()) as { status: string; challenges: { type: string; url: string; token: string }[] };
        if (authz.status === "valid") continue;
        const ch = authz.challenges.find((c) => c.type === "http-01");
        if (ch === undefined) throw new AcmeError("ACME offered no http-01 challenge");
        await responder.publish(ch.token, `${ch.token}.${thumbprint(this.key as KeyObject)}`);
        published.push(ch.token);
        await this.post(ch.url, {});
        const final = await this.poll<{ status: string; challenges: { error?: { type?: string; detail?: string } }[] }>(authzUrl, (s) => s !== "pending");
        if (final.status !== "valid") {
          const error = final.challenges.find((c) => c.error !== undefined)?.error;
          throw new AcmeError(`ACME authorization ${final.status}: ${error?.type ?? "unknown"}`, error);
        }
      }
      const key = newCertificateKey();
      await this.post(order.finalize, { csr: b64url(csrDer(key, hostname)) });
      const done = await this.poll<{ status: string; certificate?: string }>(orderUrl, (s) => s === "valid" || s === "invalid");
      if (done.status !== "valid" || done.certificate === undefined) throw new AcmeError(`ACME order ${done.status}`);
      const chainPem = await (await this.post(done.certificate, null, { accept: "application/pem-certificate-chain" })).text();
      return { chainPem, keyPem: keyPem(key) };
    } finally {
      for (const t of published) await responder.remove(t).catch(() => {});
    }
  }
}
