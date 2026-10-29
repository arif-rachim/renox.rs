// Certificates and the ACME account key at rest (deploy-api.md section 10):
// encrypted with the platform's own data key, the same envelope scheme as
// secrets (section 9). The platform DEK is wrapped by the master key with
// the key id "_platform", which no tenant id can equal (tenant ids start
// with a letter or digit). Associated data binds each ciphertext to its row.

import { X509Certificate } from "node:crypto";
import { num, type Db } from "../db/db.ts";
import { decryptValue, encryptValue, newDek, type KeyProvider } from "../secrets/crypto.ts";
import type { AcmeAccount } from "./acme.ts";

const PLATFORM = "_platform";

async function platformDek(db: Db, keys: KeyProvider, now: number): Promise<Uint8Array> {
  const rows = await db.query<{ wrapped_dek: Uint8Array; nonce: Uint8Array }>("select wrapped_dek, nonce from platform_keys where id = $1", [PLATFORM]);
  const row = rows[0];
  if (row !== undefined) return keys.unwrap(new Uint8Array(row.wrapped_dek), new Uint8Array(row.nonce), PLATFORM);
  const dek = newDek();
  const { wrapped, nonce } = await keys.wrap(dek, PLATFORM);
  const inserted = await db.query(
    "insert into platform_keys (id, wrapped_dek, nonce, master_key_id, created_at) values ($1, $2, $3, $4, $5) on conflict (id) do nothing returning id",
    [PLATFORM, wrapped, nonce, keys.id, now],
  );
  return inserted.length === 0 ? platformDek(db, keys, now) : dek;
}

const chainAad = (hostname: string, version: number): string => `certificate-chain\n${hostname}\n${version}`;
const keyAad = (hostname: string, version: number): string => `certificate-key\n${hostname}\n${version}`;
const accountAad = (directoryUrl: string): string => `acme-account\n${directoryUrl}`;

/** The certificate's expiry (Unix ms) from the first certificate of a PEM chain. */
export function notAfterOf(chainPem: string): number {
  return Date.parse(new X509Certificate(chainPem).validTo);
}

export const nextCertificateVersion = async (db: Db): Promise<number> =>
  num((await db.query<{ v: unknown }>("select nextval('certificate_version_seq') as v"))[0]?.v);

/** Stores a new certificate for `hostname` under a new version; returns the version. */
export async function storeCertificate(db: Db, keys: KeyProvider, hostname: string, chainPem: string, keyPem: string, notAfter: number, now: number): Promise<number> {
  const dek = await platformDek(db, keys, now);
  const version = await nextCertificateVersion(db);
  const chain = encryptValue(dek, chainPem, chainAad(hostname, version));
  const key = encryptValue(dek, keyPem, keyAad(hostname, version));
  await db.query(
    `insert into certificates (hostname, version, not_after, chain_cipher, chain_nonce, key_cipher, key_nonce, issued_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (hostname) do update set version = excluded.version, not_after = excluded.not_after, chain_cipher = excluded.chain_cipher,
       chain_nonce = excluded.chain_nonce, key_cipher = excluded.key_cipher, key_nonce = excluded.key_nonce, issued_at = excluded.issued_at`,
    [hostname, version, notAfter, chain.ciphertext, chain.nonce, key.ciphertext, key.nonce, now],
  );
  return version;
}

export interface CertificateInfo {
  hostname: string;
  version: number;
  not_after: number;
}

export async function certificateInfo(db: Db, hostname: string): Promise<CertificateInfo | null> {
  const rows = await db.query<{ version: unknown; not_after: unknown }>("select version, not_after from certificates where hostname = $1", [hostname]);
  const r = rows[0];
  return r === undefined ? null : { hostname, version: num(r.version), not_after: num(r.not_after) };
}

/** The decrypted chain and key. Only for a node's `certificate_bundle`. */
export async function loadCertificate(db: Db, keys: KeyProvider, hostname: string): Promise<(CertificateInfo & { chain_pem: string; key_pem: string }) | null> {
  const rows = await db.query<{ version: unknown; not_after: unknown; chain_cipher: Uint8Array; chain_nonce: Uint8Array; key_cipher: Uint8Array; key_nonce: Uint8Array }>(
    "select version, not_after, chain_cipher, chain_nonce, key_cipher, key_nonce from certificates where hostname = $1",
    [hostname],
  );
  const r = rows[0];
  if (r === undefined) return null;
  const version = num(r.version);
  const dek = await platformDek(db, keys, 0);
  return {
    hostname,
    version,
    not_after: num(r.not_after),
    chain_pem: decryptValue(dek, new Uint8Array(r.chain_cipher), new Uint8Array(r.chain_nonce), chainAad(hostname, version)),
    key_pem: decryptValue(dek, new Uint8Array(r.key_cipher), new Uint8Array(r.key_nonce), keyAad(hostname, version)),
  };
}

export async function deleteCertificate(db: Db, hostname: string): Promise<boolean> {
  return (await db.query("delete from certificates where hostname = $1 returning hostname", [hostname])).length > 0;
}

/** The ACME account store of AcmeClient for one directory. */
export function accountStore(db: Db, keys: KeyProvider, directoryUrl: string, now: () => number): { load(): Promise<AcmeAccount | null>; save(a: AcmeAccount): Promise<void> } {
  return {
    async load() {
      const rows = await db.query<{ kid: string; key_cipher: Uint8Array; key_nonce: Uint8Array }>(
        "select kid, key_cipher, key_nonce from acme_accounts where directory_url = $1",
        [directoryUrl],
      );
      const r = rows[0];
      if (r === undefined) return null;
      const dek = await platformDek(db, keys, now());
      return { kid: r.kid, keyPem: decryptValue(dek, new Uint8Array(r.key_cipher), new Uint8Array(r.key_nonce), accountAad(directoryUrl)) };
    },
    async save(a) {
      const dek = await platformDek(db, keys, now());
      const sealed = encryptValue(dek, a.keyPem, accountAad(directoryUrl));
      await db.query(
        `insert into acme_accounts (directory_url, kid, key_cipher, key_nonce, created_at) values ($1, $2, $3, $4, $5)
         on conflict (directory_url) do update set kid = excluded.kid, key_cipher = excluded.key_cipher, key_nonce = excluded.key_nonce`,
        [directoryUrl, a.kid, sealed.ciphertext, sealed.nonce, now()],
      );
    },
  };
}
