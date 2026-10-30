// Abuse reports and takedowns (#123; deploy-api.md 0.5 section 22). A
// public report becomes a ticket for the hostname's tenant; an operator
// moves it through the `abuse` table; `taken_down` suspends the tenant's
// routes (the same path as suspendTenant) and `restored` brings them back.

import type { Hono } from "hono";

import { operation } from "../audit.ts";
import type { Deps, Env } from "../context.ts";
import { num } from "../db/db.ts";
import { ApiError, conflict, invalid, notFound } from "../errors.ts";
import { readBody } from "../http.ts";
import { ulid } from "../ids.ts";
import { opsAuth } from "../ops/auth.ts";
import { onTenantState } from "../routes/activation.ts";

export const ABUSE_TRANSITIONS: Record<string, string[]> = {
  open: ["reviewing", "taken_down", "dismissed"],
  reviewing: ["taken_down", "dismissed"],
  taken_down: ["restored"],
  dismissed: ["reviewing"],
  restored: ["reviewing"],
};

const CATEGORIES = ["phishing", "malware", "spam", "csam", "copyright", "other"];
type Row = Record<string, unknown>;

const ticketJson = (r: Row) => ({
  id: r.id,
  hostname: r.hostname,
  tenant_id: r.tenant_id ?? null,
  category: r.category,
  state: r.state,
  safe_browsing: r.safe_browsing,
  reported_at: num(r.reported_at),
  updated_at: num(r.updated_at),
  reason: r.reason ?? null,
});

/** Reports per IP per hour (*proposed* 5). */
const reports = new Map<string, number[]>();
function limited(ip: string, now: number): boolean {
  const recent = (reports.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  reports.set(ip, recent);
  return recent.length > 5;
}

export function registerAbuse(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/abuse", operation(deps, "reportAbuse"), async (c) => {
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(c, 16 * 1024))) as Record<string, unknown>;
    } catch {
      throw invalid("body", "must be JSON");
    }
    const now = deps.now();
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (limited(ip, now)) throw new ApiError("RENOX_RATE_LIMITED");
    let url: URL;
    try {
      url = new URL(String(b.url));
    } catch {
      throw invalid("url", "an http(s) URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid("url", "an http(s) URL");
    if (!CATEGORIES.includes(String(b.category))) throw invalid("category", CATEGORIES.join(", "));
    const description = typeof b.description === "string" ? b.description.trim() : "";
    if (description.length < 10 || description.length > 4000) throw invalid("description", "10 to 4000 characters");
    if (typeof b.captcha_token !== "string" || b.captcha_token.length === 0) throw invalid("captcha_token", "required");
    const hostname = url.hostname.toLowerCase();
    const owner = (await deps.db.query<{ tenant_id: string }>("select tenant_id from route_entries where hostname = $1 limit 1", [hostname]))[0]?.tenant_id ?? null;
    const id = `abt_${ulid(now)}`;
    await deps.db.query(
      "insert into abuse_tickets (id, hostname, tenant_id, category, description, reporter_email, state, reported_at, updated_at) values ($1, $2, $3, $4, $5, $6, 'open', $7, $7)",
      [id, hostname, owner, b.category, description, typeof b.reporter_email === "string" ? b.reporter_email : null, now],
    );
    c.set("auditTarget", { ticket: id, hostname, category: String(b.category) });
    return c.json({ ticket_id: id }, 202);
  });

  app.get("/v1/ops/abuse", operation(deps, "listAbuseTickets"), opsAuth(deps, "ops:read"), async (c) => {
    const state = c.req.query("state");
    const rows = state
      ? await deps.db.query<Row>("select * from abuse_tickets where state = $1 order by reported_at limit 100", [state])
      : await deps.db.query<Row>("select * from abuse_tickets order by (state = 'open') desc, reported_at limit 100", []);
    return c.json({ items: rows.map(ticketJson) });
  });

  app.post("/v1/ops/abuse/:ticket_id", operation(deps, "setAbuseTicket"), opsAuth(deps), async (c) => {
    const id = c.req.param("ticket_id") ?? "";
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(new TextDecoder().decode(await readBody(c, 16 * 1024))) as Record<string, unknown>;
    } catch {
      throw invalid("body", "must be JSON");
    }
    const to = String(b.state);
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!(to in ABUSE_TRANSITIONS)) throw invalid("state", Object.keys(ABUSE_TRANSITIONS).join(", "));
    if (reason.length < 10 || reason.length > 500) throw invalid("reason", "10 to 500 characters");
    const t = (await deps.db.query<Row>("select * from abuse_tickets where id = $1", [id]))[0];
    if (t === undefined) throw notFound();
    if (!(ABUSE_TRANSITIONS[t.state as string] ?? []).includes(to)) throw conflict("state", `${t.state} -> ${to} is not allowed`);
    const now = deps.now();
    const tenant = t.tenant_id as string | null;
    if (tenant !== null && (to === "taken_down" || to === "restored")) {
      const state = to === "taken_down" ? "suspended" : "active";
      await deps.db.transaction(async (tx) => {
        await tx.query("update tenants set state = $1 where id = $2", [state, tenant]);
        await onTenantState(deps, tx, tenant, state, now);
      });
    }
    await deps.db.query("update abuse_tickets set state = $2, reason = $3, updated_at = $4 where id = $1", [id, to, reason, now]);
    c.set("auditTarget", { ticket: id, from: String(t.state), to, reason });
    return c.json(ticketJson((await deps.db.query<Row>("select * from abuse_tickets where id = $1", [id]))[0] as Row));
  });
}
