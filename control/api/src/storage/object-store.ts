// Object storage for artifacts and sourcemaps (S3-compatible: MinIO locally,
// the UAE-region bucket in production). Keys are content-addressed and
// written once (deploy-api.md section 4). Exports (#308) are written with
// SSE-KMS (`PutOptions.sseKmsKeyId`): the export bucket refuses any other put
// (ops/terraform/bucket.tf, DenyUnencryptedPut).

import { S3Client } from "bun";
import type { S3Config } from "../config.ts";

export interface ObjectStore {
  /** Writes `key` unless it exists; returns whether this call wrote it. */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<"created" | "exists">;
  /** Writes or replaces `key` (sourcemaps, exports); with `sseKmsKeyId`, encrypted with that KMS key. */
  put(key: string, bytes: Uint8Array, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** A presigned GET URL valid for `seconds`, or null when the store cannot presign. */
  presign(key: string, seconds: number): string | null;
  /** Throws when the store does not answer. */
  ping(): Promise<void>;
}

export interface PutOptions {
  /** `x-amz-server-side-encryption: aws:kms` with this key id (EXPORT_KMS_KEY_ID). */
  sseKmsKeyId?: string;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  /** The server-side encryption headers each key was written with (tests, #308). */
  readonly encryption = new Map<string, Record<string, string>>();
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<"created" | "exists"> {
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, bytes.slice());
    return "created";
  }
  async put(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
    this.objects.set(key, bytes.slice());
    this.encryption.set(key, sseHeaders(options));
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.slice() ?? null;
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  presign(): string | null {
    return null;
  }
  async ping(): Promise<void> {}
}

/** The SSE headers of a put: none, or SSE-KMS with the key. */
export function sseHeaders(options: PutOptions): Record<string, string> {
  if (options.sseKmsKeyId === undefined) return {};
  return { "x-amz-server-side-encryption": "aws:kms", "x-amz-server-side-encryption-aws-kms-key-id": options.sseKmsKeyId };
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array<ArrayBuffer>): Promise<string> => hex(await crypto.subtle.digest("SHA-256", b));
async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/**
 * A path-style PUT signed with AWS Signature Version 4, for the puts Bun's
 * S3Client cannot make (it has no server-side encryption options): the
 * SSE headers are signed with the rest.
 */
export async function signedPut(config: S3Config, key: string, bytes: Uint8Array, headers: Record<string, string>, now = new Date()): Promise<Response> {
  const path = `/${config.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const url = new URL(`${config.endpoint.replace(/\/+$/u, "")}${path}`);
  const body = new Uint8Array(bytes);
  const amzDate = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  const day = amzDate.slice(0, 8);
  const payload = await sha256(body);
  const h: Record<string, string> = { ...headers, host: url.host, "x-amz-date": amzDate, "x-amz-content-sha256": payload };
  const names = Object.keys(h).map((n) => n.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const canonical = ["PUT", url.pathname, "", ...names.map((n) => `${n}:${lower[n]}`), "", names.join(";"), payload].join("\n");
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(enc.encode(canonical))].join("\n");
  let k = await hmac(enc.encode(`AWS4${config.secretAccessKey}`), day);
  for (const part of [config.region, "s3", "aws4_request"]) k = await hmac(k, part);
  const signature = hex(await hmac(k, toSign));
  delete h.host;
  h.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return fetch(url, { method: "PUT", headers: h, body });
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly config: S3Config;
  constructor(config: S3Config) {
    this.config = config;
    this.client = new S3Client({
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
  }
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<"created" | "exists"> {
    // Content-addressed: a concurrent writer of the same key writes the same bytes.
    if (await this.client.exists(key)) return "exists";
    await this.client.write(key, bytes);
    return "created";
  }
  async put(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
    if (options.sseKmsKeyId === undefined) {
      await this.client.write(key, bytes);
      return;
    }
    const res = await signedPut(this.config, key, bytes, sseHeaders(options));
    if (!res.ok) throw new Error(`put ${key}: ${res.status}`);
    await res.arrayBuffer();
  }
  async get(key: string): Promise<Uint8Array | null> {
    if (!(await this.client.exists(key))) return null;
    return new Uint8Array(await this.client.file(key).arrayBuffer());
  }
  exists(key: string): Promise<boolean> {
    return this.client.exists(key);
  }
  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }
  presign(key: string, seconds: number): string {
    return this.client.presign(key, { expiresIn: seconds, method: "GET" });
  }
  async ping(): Promise<void> {
    await this.client.exists("health/ping");
  }
}
