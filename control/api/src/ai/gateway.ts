// The AI gateway (#327; deploy-api.md 0.5 section 23): `ctx.ai` in gateway
// mode reaches this through the owning node. The platform holds the provider
// keys; nodes and isolates never see them. Before the call, the tenant's
// monthly `ai_tokens` quota (its plan, section 20) is checked against the
// tokens used plus `max_tokens`; after it, the tokens are metered. A
// byte-identical request of the same tenant within 24 hours answers from
// the cache. Requests and answers are never logged.

import { createHash } from "node:crypto";

import { planOf } from "@renox/billing";
import type { Hono } from "hono";

import { operation } from "../audit.ts";
import { nodeAuth } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import { num } from "../db/db.ts";
import { ApiError, invalid } from "../errors.ts";
import { readBody } from "../http.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
const CACHE_MS = 86_400_000;

/** One provider of the model table. */
export interface AiProvider {
  /** The Anthropic Messages answer for `body` (model resolved), or throws. */
  call(body: Record<string, unknown>): Promise<{ model: string; content: unknown[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number } }>;
}

/** Anthropic with `ANTHROPIC_API_KEY`; 30 s per call. */
export const anthropic: AiProvider = {
  async call(body) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("no provider key");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`provider answered ${res.status}`);
    return (await res.json()) as Awaited<ReturnType<AiProvider["call"]>>;
  },
};

/** The model table: model -> providers, tried in order. `default` is the latest Claude model. */
let table: Record<string, AiProvider[]> = { [DEFAULT_MODEL]: [anthropic], "claude-sonnet-5-5": [anthropic], "claude-haiku-5-5": [anthropic] };
/** Tests: a provider table of stand-ins. */
export function setModelTable(t: Record<string, AiProvider[]>): void {
  table = t;
}

const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function registerAiGateway(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/ai/chat", operation(deps, "aiChat"), nodeAuth(deps), async (c) => {
    const p = c.get("principal");
    const nodeId = p !== undefined && p.kind === "node" ? p.nodeId : "";
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, 1024 * 1024))) as Record<string, unknown>;
    } catch {
      throw invalid("body", "must be JSON");
    }
    const tenantId = typeof b.tenant_id === "string" ? b.tenant_id : "";
    const maxTokens = b.max_tokens;
    if (!Array.isArray(b.messages) || b.messages.length === 0) throw invalid("messages", "a non-empty array");
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 64_000) throw invalid("max_tokens", "1 to 64000");
    // The node must own the tenant (one of its route entries).
    const owned = await deps.db.query("select 1 from route_entries where tenant_id = $1 and node_id = $2 limit 1", [tenantId, nodeId]);
    if (owned.length === 0) throw new ApiError("RENOX_TOKEN_SCOPE");
    const asked = typeof b.model === "string" ? b.model : "default";
    const model = asked === "default" ? DEFAULT_MODEL : asked;
    const providers = table[model];
    if (providers === undefined) throw invalid("model", "not a model of the gateway's table");
    const request = { model, messages: b.messages, max_tokens: maxTokens, ...(typeof b.system === "string" ? { system: b.system } : {}), ...(Array.isArray(b.tools) ? { tools: b.tools } : {}) };
    const now = deps.now();
    const key = createHash("sha256").update(tenantId).update("\0").update(canonical(request)).digest("hex");
    const hit = (await deps.db.query<{ answer: string; created_at: unknown }>("select answer, created_at from ai_cache where key = $1 and tenant_id = $2", [key, tenantId]))[0];
    if (hit !== undefined && now - num(hit.created_at) < CACHE_MS) return c.json({ ...JSON.parse(hit.answer), cached: true, usage: { input_tokens: 0, output_tokens: 0 } });
    // Quota: the plan's monthly tokens.
    const billing = (await deps.db.query<{ plan: string }>("select plan from tenant_billing where tenant_id = $1", [tenantId]))[0];
    const quota = planOf(billing?.plan ?? "free")?.quotas.ai_tokens ?? 0;
    const used = (await deps.db.query<{ i: unknown; o: unknown }>("select tokens_in as i, tokens_out as o from ai_usage where tenant_id = $1 and month = $2", [tenantId, monthOf(now)]))[0];
    const spent = used === undefined ? 0 : num(used.i) + num(used.o);
    if (quota !== null && spent + maxTokens > quota) {
      c.set("auditTarget", { tenant_id: tenantId, model, reason: "quota" });
      throw new ApiError("RENOX_AI_QUOTA");
    }
    let answer: Awaited<ReturnType<AiProvider["call"]>> | null = null;
    for (const provider of providers) {
      try {
        answer = await provider.call(request);
        break;
      } catch {
        // The next provider of the row.
      }
    }
    if (answer === null) {
      c.set("auditTarget", { tenant_id: tenantId, model, reason: "unavailable" });
      throw new ApiError("RENOX_AI_UNAVAILABLE");
    }
    const usage = { input_tokens: Math.max(0, Math.floor(answer.usage?.input_tokens ?? 0)), output_tokens: Math.max(0, Math.floor(answer.usage?.output_tokens ?? 0)) };
    await deps.db.query(
      "insert into ai_usage (tenant_id, month, tokens_in, tokens_out) values ($1, $2, $3, $4) on conflict (tenant_id, month) do update set tokens_in = ai_usage.tokens_in + excluded.tokens_in, tokens_out = ai_usage.tokens_out + excluded.tokens_out",
      [tenantId, monthOf(now), usage.input_tokens, usage.output_tokens],
    );
    const out = { model: answer.model, content: answer.content, stop_reason: answer.stop_reason, usage };
    await deps.db.query("insert into ai_cache (key, tenant_id, answer, created_at) values ($1, $2, $3, $4) on conflict (key) do update set answer = excluded.answer, created_at = excluded.created_at", [key, tenantId, JSON.stringify(out), now]);
    return c.json({ ...out, cached: false });
  });
}
