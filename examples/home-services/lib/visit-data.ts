// The rows of a visit and what reads them: the visit of a job, its photos and
// parts, the signed image object `<x-image>` takes, and the bytes of a data
// URL. No writes and no rules here (lib/visits.ts), so lib/report.ts can read
// a visit without importing the file that builds it.
import type { DbStatements, Storage } from "@renoxium/sdk";

import type { Phase } from "./visit-forms";

export type VisitRow = {
  id: string;
  branch_id: string;
  job_id: string;
  technician_user_id: string;
  checkin_at: number;
  checkin_lat: number | null;
  checkin_lng: number | null;
  checkout_at: number | null;
  notes: string;
  summary_en: string;
  summary_ar: string;
  signature_key: string | null;
  signed_by_name: string;
  report_key: string | null;
};

export type PhotoRow = {
  id: number;
  visit_id: string;
  phase: Phase;
  file_key: string;
  caption: string;
  width: number | null;
  height: number | null;
};

export type PartRow = {
  id: number;
  description: string;
  qty: number;
  unit_price_fils: number;
};

export const VISIT_COLUMNS = "id, branch_id, job_id, technician_user_id, checkin_at, checkin_lat, checkin_lng, checkout_at, notes, summary_en, summary_ar, signature_key, signed_by_name, report_key";

/** The largest photo, as the storage module's `max_upload_bytes` (renox.toml). */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Why a photo of `size` bytes is refused (naming the limit), or null when it is fine. */
export const photoLimitMessage = (size: number): string | null =>
  size > MAX_PHOTO_BYTES ? `A photo is at most 10 MiB (${MAX_PHOTO_BYTES} bytes); this one is ${size} bytes.` : null;

/** A visit by its id, or null. Read through the unfenced database: the caller found the id through a fenced one, and uses `visit.branch_id` to fence the rest. */
export async function visitById(db: DbStatements, id: string): Promise<VisitRow | null> {
  return db.queryOne<VisitRow>("select id, branch_id, job_id, technician_user_id, checkin_at, checkin_lat, checkin_lng, checkout_at, notes, summary_en, summary_ar, signature_key, signed_by_name, report_key from app__visits where id = ?", [id]);
}

/** The visit of a job, or null. */
export async function visitOfJob(sdb: DbStatements, jobId: string): Promise<VisitRow | null> {
  return sdb.queryOne<VisitRow>(`select ${VISIT_COLUMNS} from app__visits where job_id = ?`, [jobId]);
}

export async function photosOf(sdb: DbStatements, visitId: string): Promise<PhotoRow[]> {
  return sdb.query<PhotoRow>("select id, visit_id, phase, file_key, caption, width, height from app__visit_photos where visit_id = ? order by id", [visitId]);
}

export async function partsOf(sdb: DbStatements, visitId: string): Promise<PartRow[]> {
  return sdb.query<PartRow>("select id, description, qty, unit_price_fils from app__visit_parts where visit_id = ? order by id", [visitId]);
}

/** A part's price for its quantity, in fils. */
export const partTotal = (p: Pick<PartRow, "qty" | "unit_price_fils">): number => Math.round(p.qty * p.unit_price_fils);

/** What `<x-image>` takes for a private photo: the key and size, and the signature of a short-lived link (the image pipeline checks it). */
export async function imageOf(storage: Pick<Storage, "sign">, p: Pick<PhotoRow, "file_key" | "width" | "height">, ttlSeconds = 3600) {
  const signed = await storage.sign(p.file_key, ttlSeconds);
  const q = new URL(signed.url, "https://app.invalid").searchParams;
  return { key: p.file_key, width: p.width, height: p.height, exp: q.get("exp"), sig: q.get("sig") };
}

/** The bytes of a `data:<type>;base64,...` URL, or null when it is not one. */
export function bytesOfDataUrl(url: string): { type: string; bytes: Uint8Array } | null {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(url);
  if (m === null) return null;
  try {
    const bin = atob(m[2] as string);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { type: m[1] as string, bytes };
  } catch {
    return null;
  }
}

