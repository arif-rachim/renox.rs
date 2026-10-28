// Object storage for artifacts and sourcemaps (S3-compatible: MinIO locally,
// the UAE-region bucket in production). Keys are content-addressed and
// written once (deploy-api.md section 4).

import { S3Client } from "bun";
import type { S3Config } from "../config.ts";

export interface ObjectStore {
  /** Writes `key` unless it exists; returns whether this call wrote it. */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<"created" | "exists">;
  /** Writes or replaces `key` (sourcemaps only). */
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** A presigned GET URL valid for `seconds`, or null when the store cannot presign. */
  presign(key: string, seconds: number): string | null;
  /** Throws when the store does not answer. */
  ping(): Promise<void>;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<"created" | "exists"> {
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, bytes.slice());
    return "created";
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes.slice());
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

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  constructor(config: S3Config) {
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
  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.client.write(key, bytes);
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
