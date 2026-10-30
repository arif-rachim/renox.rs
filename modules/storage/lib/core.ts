// The storage module (#332): uploads under `storage/<owner>/<name>` through
// ctx.storage (the platform keeps the bytes and renox__files; ops.md 1.7.0
// section 21), and the SVG sanitiser whose output the platform accepts with
// `sanitised: true`.

export interface StoredFile {
  key: string;
  bytes: number;
  content_type: string;
  sha256: string;
  width: number | null;
  height: number | null;
  public: boolean;
  created_at: number;
}

export interface StorageCtx {
  storage: {
    put(key: string, bytes: Uint8Array, o: { contentType: string; public?: boolean; sanitised?: boolean }): Promise<StoredFile>;
    delete(key: string): Promise<boolean>;
    sign(key: string, ttl: number): Promise<{ url: string; expires_at: number }>;
    list(prefix: string, o?: { limit?: number; cursor?: string | null }): Promise<{ items: StoredFile[]; next_cursor: string | null }>;
  };
  config: { max_upload_bytes?: number; allow_svg?: boolean };
}

export class UploadError extends Error {
  constructor(message: string, readonly code: "INVALID" | "TOO_LARGE" | "SVG") {
    super(message);
    this.name = "UploadError";
  }
}

const SEGMENT = /^[a-z0-9][a-z0-9_.-]{0,99}$/u;

/** `storage/<owner>/<name>`, both checked so a caller cannot reach another owner's folder. */
export function keyOf(owner: unknown, name: unknown): string {
  if (typeof owner !== "string" || !SEGMENT.test(owner)) throw new UploadError("owner: lower-case letters, digits, _ . -", "INVALID");
  if (typeof name !== "string") throw new UploadError("name", "INVALID");
  const n = name.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^[^a-z0-9]+/u, "").slice(0, 100);
  if (!SEGMENT.test(n) || n.includes("..")) throw new UploadError("name: a file name", "INVALID");
  return `storage/${owner}/${n}`;
}

/**
 * A conservative SVG sanitiser: drops script, foreignObject, iframe, object,
 * embed, audio, video, animate and set elements, every `on*` attribute, and
 * every href or url() that is not a fragment (`#id`). Null for a non-SVG.
 */
export function sanitizeSvg(text: string): string | null {
  const s = text.replace(/^﻿/u, "").trim();
  if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/iu.test(s)) return null;
  let out = s.replace(/<!DOCTYPE[\s\S]*?>/giu, "").replace(/<!ENTITY[\s\S]*?>/giu, "");
  for (const tag of ["script", "foreignObject", "iframe", "object", "embed", "audio", "video", "animate", "set", "animateTransform", "animateMotion", "handler"]) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "giu"), "").replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "giu"), "");
  }
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/giu, "");
  out = out.replace(/\s+(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/giu, (m, _q, a, b) => ((a ?? b ?? "").trim().startsWith("#") ? m : ""));
  out = out.replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/giu, "none");
  out = out.replace(/<style\b[\s\S]*?<\/style\s*>/giu, (m) => m.replace(/@import[^;]+;/giu, "").replace(/expression\s*\(/giu, "("));
  return out;
}

export async function upload(ctx: StorageCtx, owner: unknown, name: unknown, bytes: unknown, contentType: unknown, opts: { public?: boolean } = {}): Promise<StoredFile> {
  if (!(bytes instanceof Uint8Array)) throw new UploadError("bytes: a Uint8Array", "INVALID");
  if (typeof contentType !== "string") throw new UploadError("content_type", "INVALID");
  const max = Number(ctx.config.max_upload_bytes ?? 10 * 1024 * 1024);
  if (bytes.length > max) throw new UploadError(`at most ${max} bytes`, "TOO_LARGE");
  const key = keyOf(owner, name);
  if (contentType === "image/svg+xml") {
    if (ctx.config.allow_svg !== true) throw new UploadError("SVG uploads are off (allow_svg)", "SVG");
    const clean = sanitizeSvg(new TextDecoder().decode(bytes));
    if (clean === null) throw new UploadError("not an SVG", "SVG");
    return ctx.storage.put(key, new TextEncoder().encode(clean), { contentType, public: opts.public === true, sanitised: true });
  }
  return ctx.storage.put(key, bytes, { contentType, public: opts.public === true });
}

export const list = (ctx: StorageCtx, owner: unknown, o: { limit?: number; cursor?: string | null } = {}) => ctx.storage.list(`${keyOf(owner, "x").slice(0, -1)}`, o);
export const remove = (ctx: StorageCtx, owner: unknown, name: unknown) => ctx.storage.delete(keyOf(owner, name));
export const link = (ctx: StorageCtx, owner: unknown, name: unknown, ttl: unknown) => ctx.storage.sign(keyOf(owner, name), typeof ttl === "number" ? ttl : 3600);
