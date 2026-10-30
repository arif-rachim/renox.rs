// `renox/fakes` (#323; docs/contracts/ops.md 1.7.0 sections 21-23): stand-ins
// for `ctx.storage`, `ctx.ai` and webhook deliveries in a tenant's unit
// tests, so a handler can be called without a worker.
//
//   import { fakeStorage, fakeAi, signWebhook } from "renox/fakes";
//   const ctx = { ...base, storage: fakeStorage(), ai: fakeAi([{ text: "AED 5" }]) };
//   const req = await signWebhook("stripe", "whsec_test", { id: "evt_1" });
//
// The fakes follow the contract's rules (key prefix, ttl range, the
// `StorageError` codes), never the network.

import type { Ai, AiContent, AiRequest, AiResult, Storage, StoredFile, StoragePage, StoragePutOptions, WebhookProvider } from "./ctx.ts";
import { StorageError } from "./errors.ts";

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,255}$/u;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An in-memory `ctx.storage` for `module` (keys under `<module>/`). */
export function fakeStorage(module = "app", options: { maxFileBytes?: number; now?: () => number } = {}): Storage & { files: Map<string, { file: StoredFile; bytes: Uint8Array }> } {
  const files = new Map<string, { file: StoredFile; bytes: Uint8Array }>();
  const now = options.now ?? Date.now;
  const check = (key: string): void => {
    if (!KEY.test(key) || key.split("/").some((s) => s === "" || s === "." || s === "..") || !key.startsWith(`${module}/`)) {
      throw new StorageError("RENOX_STORAGE_KEY", "The storage key is not allowed.", { key });
    }
  };
  const found = (key: string) => {
    const f = files.get(key);
    if (f === undefined) throw new StorageError("RENOX_STORAGE_NOT_FOUND", "No stored file has this key.", { key });
    return f;
  };
  return {
    files,
    async put(key: string, bytes: Uint8Array, opts: StoragePutOptions): Promise<StoredFile> {
      check(key);
      if (bytes.length > (options.maxFileBytes ?? 10 * 1024 * 1024)) throw new StorageError("RENOX_STORAGE_TOO_LARGE", "The file is over the per-file limit.", { key });
      if (opts.contentType === "image/svg+xml" && opts.sanitised !== true) throw new StorageError("RENOX_STORAGE_TYPE", "The content type is not allowed for this file.", { key, reason: "svg_unsanitised" });
      const file: StoredFile = { key, bytes: bytes.length, content_type: opts.contentType, sha256: await sha256Hex(bytes), width: null, height: null, public: opts.public === true, created_at: now() };
      files.set(key, { file, bytes: bytes.slice() });
      return file;
    },
    async get(key: string) {
      check(key);
      return found(key).file;
    },
    async read(key: string) {
      check(key);
      return found(key).bytes.slice();
    },
    async delete(key: string) {
      check(key);
      return files.delete(key);
    },
    async sign(key: string, ttlSeconds: number) {
      check(key);
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 604800) throw new RangeError("storage.sign: ttl is 60 to 604800 seconds");
      found(key);
      const exp = Math.floor(now() / 1000) + ttlSeconds;
      return { url: `/_files/${key}?exp=${exp}&sig=fake`, expires_at: exp * 1000 };
    },
    async list(prefix: string, opts: { limit?: number; cursor?: string | null } = {}): Promise<StoragePage> {
      const p = prefix === "" ? `${module}/` : prefix;
      if (!p.startsWith(`${module}/`)) throw new StorageError("RENOX_STORAGE_KEY", "The storage key is not allowed.", { key: p });
      const keys = [...files.keys()].filter((k) => k.startsWith(p) && k > (opts.cursor ?? "")).sort();
      const limit = opts.limit ?? 100;
      const page = keys.slice(0, limit);
      return { items: page.map((k) => (files.get(k) as { file: StoredFile }).file), next_cursor: keys.length > limit ? (page[page.length - 1] ?? null) : null };
    },
  };
}

/** One recorded answer: text, or a tool call the code under test must answer. */
export type RecordedTurn = { text: string } | { tool: string; input?: unknown };

/**
 * A `ctx.ai` that replays recorded answers in order, running local tools
 * like the platform does; `requests` keeps what the code asked.
 */
export function fakeAi(turns: RecordedTurn[]): Ai & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  let i = 0;
  const next = (): RecordedTurn => {
    const t = turns[i++];
    if (t === undefined) throw new Error("fakeAi: no recorded answer left");
    return t;
  };
  return {
    requests,
    async chat(request: AiRequest): Promise<AiResult> {
      requests.push(request);
      let input = 0;
      let output = 0;
      for (let round = 0; round < 8; round++) {
        const t = next();
        input += 10;
        output += 5;
        if ("text" in t) {
          return { id: `fake_${i}`, model: request.model ?? "default", content: [{ type: "text", text: t.text }], stop_reason: "end_turn", usage: { input_tokens: input, output_tokens: output } };
        }
        const tool = request.tools?.find((x) => x.name === t.tool);
        if (typeof tool?.run !== "function") {
          const content: AiContent[] = [{ type: "tool_use", id: `tu_${i}`, name: t.tool, input: (t.input ?? {}) as never }];
          return { id: `fake_${i}`, model: request.model ?? "default", content, stop_reason: "tool_use", usage: { input_tokens: input, output_tokens: output } };
        }
        await tool.run((t.input ?? {}) as never);
      }
      throw new Error("fakeAi: more than 8 tool rounds");
    },
  };
}

const HEADERS: Record<string, string> = {
  checkout: "cko-signature",
  telr: "x-telr-signature",
  paytabs: "signature",
  ngenius: "x-ngenius-signature",
  tabby: "x-tabby-signature",
  tamara: "tamara-signature",
};

async function hmacHex(secret: string, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, data as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A webhook delivery signed the way `provider` signs it (ops.md section 22),
 * for a test of a `functions/webhooks/*.ts` handler against `renox test`.
 * `generic` signs into `header` (default `x-webhook-signature`).
 */
export async function signWebhook(provider: Exclude<WebhookProvider, "apple" | "google">, secret: string, payload: unknown, options: { url?: string; header?: string; now?: number } = {}): Promise<Request> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const bytes = new TextEncoder().encode(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider === "stripe") {
    const t = Math.floor((options.now ?? Date.now()) / 1000);
    headers["stripe-signature"] = `t=${t},v1=${await hmacHex(secret, new TextEncoder().encode(`${t}.${body}`))}`;
  } else if (provider === "generic") {
    headers[(options.header ?? "x-webhook-signature").toLowerCase()] = await hmacHex(secret, bytes);
  } else {
    headers[HEADERS[provider] as string] = await hmacHex(secret, bytes);
  }
  return new Request(options.url ?? `https://app.renox.test/webhooks/${provider}`, { method: "POST", headers, body });
}
