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
  config: { max_upload_bytes?: number; allow_svg?: boolean; quota_mb?: number };
}

export class UploadError extends Error {
  constructor(message: string, readonly code: "INVALID" | "TOO_LARGE" | "SVG" | "QUOTA") {
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

const DROPPED = ["script", "foreignObject", "iframe", "object", "embed", "audio", "video", "animate", "set", "animateTransform", "animateMotion", "handler", "listener"];
/** An element name with an optional namespace prefix (`svg:script`). */
const el = (tag: string) => `(?:[\\w.-]+:)?${tag}`;
/** What must not survive: a dropped element, an `on*` attribute, a script URL. */
const LEFT = new RegExp(`<\\/?\\s*${el(`(?:${DROPPED.join("|")})`)}\\b|[\\s/"']on[a-z]+\\s*=|(?:java|vb)script\\s*:|data\\s*:\\s*text\\/html`, "iu");

function pass(s: string): string {
  let out = s.replace(/<!DOCTYPE[\s\S]*?>/giu, "").replace(/<!ENTITY[\s\S]*?>/giu, "");
  for (const tag of DROPPED) {
    out = out.replace(new RegExp(`<${el(tag)}\\b[\\s\\S]*?<\\/\\s*${el(tag)}\\s*>`, "giu"), "").replace(new RegExp(`<\\/?\\s*${el(tag)}\\b[^>]*>`, "giu"), "");
  }
  out = out.replace(/([\s/"'])(?:[\w.-]+:)?on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/giu, "$1");
  out = out.replace(/\s+(?:[\w.-]+:)?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/giu, (m, _q, a, b, c) => ((a ?? b ?? c ?? "").trim().startsWith("#") ? m : ""));
  out = out.replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/giu, "none");
  out = out.replace(/<style\b[\s\S]*?<\/style\s*>/giu, (m) => m.replace(/@import[^;]+;?/giu, "").replace(/expression\s*\(/giu, "("));
  return out;
}

/**
 * A conservative SVG sanitiser: drops script, foreignObject, iframe, object,
 * embed, audio, video, animate and set elements (with or without a
 * namespace prefix), every `on*` attribute, and every href or url() that is
 * not a fragment (`#id`). It repeats until nothing changes, so a removal
 * cannot join two halves into a new tag. Null for a non-SVG, and null (the
 * file refused) when anything dangerous is still left.
 */
export function sanitizeSvg(text: string): string | null {
  const s = text.replace(/^\uFEFF/u, "").trim();
  if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/iu.test(s)) return null;
  let out = s;
  for (let i = 0; i < 10; i++) {
    const next = pass(out);
    if (next === out) return LEFT.test(out) ? null : out;
    out = next;
  }
  return null;
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

// #332 F67-B: per-owner quotas.

/** Every file of an owner (all pages of the listing). */
async function allOf(ctx: StorageCtx, owner: unknown): Promise<StoredFile[]> {
  const out: StoredFile[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page = await list(ctx, owner, { limit: 1000, cursor });
    out.push(...page.items);
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  return out;
}

/** What an owner has stored against `config.quota_mb` (0: no per-owner quota; the tenant's own quota of the tier still applies). */
export async function quota(ctx: StorageCtx, owner: unknown): Promise<{ used_bytes: number; limit_bytes: number | null; files: number }> {
  const files = await allOf(ctx, owner);
  const mb = Number(ctx.config.quota_mb ?? 0);
  return { used_bytes: files.reduce((s, f) => s + f.bytes, 0), limit_bytes: mb > 0 ? mb * 1024 * 1024 : null, files: files.length };
}

/** An upload that keeps the owner within `config.quota_mb` (a replaced file counts once). */
export async function uploadWithin(ctx: StorageCtx, owner: unknown, name: unknown, bytes: unknown, contentType: unknown, opts: { public?: boolean } = {}): Promise<StoredFile> {
  const mb = Number(ctx.config.quota_mb ?? 0);
  if (mb > 0 && bytes instanceof Uint8Array) {
    const key = keyOf(owner, name);
    const files = await allOf(ctx, owner);
    const used = files.filter((f) => f.key !== key).reduce((s, f) => s + f.bytes, 0);
    if (used + bytes.length > mb * 1024 * 1024) throw new UploadError(`over the ${mb} MB quota of this owner`, "QUOTA");
  }
  return upload(ctx, owner, name, bytes, contentType, opts);
}
