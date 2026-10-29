// Server stacks against the deployment's private sourcemaps (#261; gate F1
// note on #128). A server line whose `fields.stack` is a V8 stack (the
// `RENOX_INTERNAL` line of a handler that threw, ops.md section 6) is read
// with `fields.frames` added: one `{ file, line, column, function, original }`
// per frame, the shape of the client-events frames (deploy-api.md section
// 11.1). `original` is the TypeScript position from the maps `renox deploy`
// uploaded for the line's deployment, or null. The stored line and its raw
// `fields.stack` are not changed.
//
// Bounded per line: at most MAX_FRAMES frames are read, and lookups stop
// after BUDGET_MS (the frames after that keep `original: null`). Loading a
// deployment's maps from the object store is not counted: it happens once
// per deployment (Symbolicator caches the decoded maps).

import type { Deps } from "../context.ts";
import type { LogLine } from "../ingest/logs.ts";
import { Symbolicator, type Original } from "../sourcemaps/symbolicate.ts";

export const MAX_FRAMES = 50;
export const BUDGET_MS = 2;

export interface ServerFrame {
  file: string;
  line: number;
  column: number;
  function: string | null;
  original: Original | null;
}

/** The virtual module root of the runtime (crates/renox-runtime/src/loader.rs). */
const VIRTUAL_ROOT = "file:///";

/** `at fn (file:///x.js:3:11)`, `at file:///x.js:3:11`, `at async fn (…)`. */
const FRAME = /^\s*at\s+(?:(?:async\s+)?(.+?)\s+\()?(file:\/\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/u;

/** The frames of a V8 stack that name a tenant module, at most MAX_FRAMES. */
export function parseStack(stack: string): Omit<ServerFrame, "original">[] {
  const out: Omit<ServerFrame, "original">[] = [];
  for (const text of stack.split("\n")) {
    if (out.length >= MAX_FRAMES) break;
    const m = FRAME.exec(text);
    if (m === null) continue;
    out.push({ file: `/${(m[2] as string).slice(VIRTUAL_ROOT.length)}`, line: Number(m[3]), column: Number(m[4]), function: m[1] ?? null });
  }
  return out;
}

const symbolicators = new WeakMap<Deps, Symbolicator>();
function symbolicator(deps: Deps): Symbolicator {
  let s = symbolicators.get(deps);
  if (s === undefined) {
    s = new Symbolicator(deps.store);
    symbolicators.set(deps, s);
  }
  return s;
}

/** `line` with `fields.frames` when it is a server line with a stack; otherwise `line` itself. */
export async function withServerFrames<L extends LogLine>(deps: Deps, line: L, now: () => number = () => performance.now()): Promise<L> {
  const stack = line.fields?.stack;
  if (line.source !== "server" || typeof stack !== "string" || stack === "") return line;
  const frames = parseStack(stack);
  if (frames.length === 0) return line;
  const lookup = /^[0-9a-f]{64}$/u.test(line.deployment_hash) ? await symbolicator(deps).lookupFor(line.tenant_id, line.deployment_hash) : null;
  const started = now();
  const out: ServerFrame[] = frames.map((f) => {
    let original: Original | null = null;
    if (lookup !== null && now() - started <= BUDGET_MS) original = lookup(f.file, f.line, f.column);
    return { ...f, original };
  });
  return { ...line, fields: { ...line.fields, frames: out } };
}
