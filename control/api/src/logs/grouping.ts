// Grouping of browser errors by fingerprint (deploy-api.md section 11.1,
// client-events.md Open 5): kind + top frame + message template. Numbers, ids,
// and content hashes in file names are normalised away so the same bug is one
// group across deployments, pages, and users.

import { createHash } from "node:crypto";

export interface RawFrame {
  file: string;
  line: number;
  column: number;
  function: string | null;
}

/** What grouping needs of a stored `source: client` line (client-events.md section 9). */
export interface ClientLine {
  message: string;
  fields: Record<string, unknown> | null;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const LONG_HEX = /\b[0-9a-f]{8,}\b/giu;
const NUMBER = /\b\d+(?:\.\d+)?\b/gu;
const MAX_FRAMES = 50;

/** The message with its kind prefix removed, and ids and numbers replaced by placeholders. */
export function messageTemplate(message: string, kind: string): string {
  const bare = message.startsWith(`${kind}: `) ? message.slice(kind.length + 2) : message === kind ? "" : message;
  return bare.replace(UUID, "<id>").replace(LONG_HEX, "<id>").replace(NUMBER, "<n>").replace(/\s+/gu, " ").trim().slice(0, 512);
}

/** A script URL path without query, fragment, or the content hash a bundler puts in the name: `/app.3f9a1c2b.js` → `/app.js`. */
export function normalizeFile(file: string): string {
  const path = file.replace(/[?#].*$/u, "");
  return path.replace(/[.-][0-9a-f]{8,}(?=\.[a-z0-9]+$)/iu, "");
}

const int = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** The stack frames of a client line: `detail.stack`, else the single position the kind carries (`source`, `source_file`). */
export function framesOf(line: ClientLine): RawFrame[] {
  const detail = (line.fields?.detail ?? null) as Record<string, unknown> | null;
  if (detail === null || typeof detail !== "object") return [];
  const out: RawFrame[] = [];
  if (Array.isArray(detail.stack)) {
    for (const f of detail.stack.slice(0, MAX_FRAMES)) {
      const o = f as Record<string, unknown>;
      if (typeof o?.file === "string" && o.file !== "") out.push({ file: o.file, line: int(o.line), column: int(o.column), function: typeof o.function === "string" ? o.function : null });
    }
  }
  if (out.length === 0) {
    const file = detail.source ?? detail.source_file;
    if (typeof file === "string" && file !== "") out.push({ file, line: int(detail.line), column: int(detail.column), function: null });
  }
  return out;
}

/** What else tells two events of a kind apart when there is no stack (htmx target, transport, directive). */
function discriminator(line: ClientLine): string {
  const d = (line.fields?.detail ?? {}) as Record<string, unknown>;
  return ["target", "transport", "effective_directive", "status", "code"].map((k) => (d[k] === undefined || d[k] === null ? "" : String(d[k]))).join("|");
}

/** The fingerprint: 16 hex characters of SHA-256 over kind, normalised top frame, and message template. */
export function fingerprintOf(kind: string, line: ClientLine, frames: RawFrame[]): string {
  const top = frames[0];
  const parts = [kind, top === undefined ? "" : normalizeFile(top.file), top?.function ?? "", messageTemplate(line.message, kind), top === undefined ? discriminator(line) : ""];
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}
