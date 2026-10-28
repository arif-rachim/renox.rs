// Upload, validation, storage and reading of deployments (docs/contracts/
// deploy-api.md sections 4 and 5): POST /v1/apps/{app}/deployments,
// GET .../deployments, GET .../deployments/{hash}, PUT .../sourcemaps.

import type { Context, Hono } from "hono";
import { checkArtifactFiles, TIERS, writeTar, type Violation } from "@renox/artifact-validate";
import { operation } from "../audit.ts";
import { tenantAuth, tenantId } from "../auth/middleware.ts";
import { requireApp } from "../apps/repo.ts";
import { check } from "../contract.ts";
import { ApiError, conflict, invalid } from "../errors.ts";
import { pathParam } from "../http.ts";
import { extractSourcemaps, extractUpload, gzipOf } from "./extract.ts";
import { bundleViolations } from "./validate-bundle.ts";
import { actorOf, type Deps, type Env } from "../context.ts";
import type { Db } from "../db/db.ts";
import {
  artifactKey,
  deploymentView,
  findDeployment,
  insertUploaded,
  listDeployments,
  prune,
  requireDeployment,
  sourcemapKey,
  transition,
  type Actor,
} from "./repo.ts";

async function tenantGuard(db: Db, tenant: string): Promise<{ tier: "free" | "paid" }> {
  const rows = await db.query<{ tier: "free" | "paid"; state: string }>("select tier, state from tenants where id = $1", [tenant]);
  const row = rows[0];
  if (row === undefined) throw new ApiError("RENOX_UNAUTHENTICATED");
  if (row.state === "suspended") throw conflict("tenant", "the tenant is suspended");
  return { tier: row.tier };
}

export function registerDeployments(app: Hono<Env>, deps: Deps): void {
  const { db, store } = deps;
  const actor = (c: Context<Env>): Actor => ({ actor: actorOf(c.get("principal")), requestId: c.get("requestId"), now: deps.now() });

  app.post("/v1/apps/:app/deployments", operation(deps, "uploadDeployment"), tenantAuth(deps, "deploy"), async (c) => {
    const tenant = tenantId(c);
    const name = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const { tier } = await tenantGuard(db, tenant);
    const claimed = c.req.header("x-renox-artifact-hash") ?? "";
    if (!/^[0-9a-f]{64}$/u.test(claimed)) throw invalid("x-renox-artifact-hash", "must be 64 lower-case hex characters");
    gzipOf(c);

    // Idempotent: a hash this app already holds is returned as it is, unread.
    const existing = await findDeployment(db, tenant, name, claimed);
    if (existing !== null && existing.state !== "rejected" && existing.state !== "pruned" && existing.state !== "uploaded") {
      await c.req.raw.body?.cancel().catch(() => {});
      return c.json(deploymentView(existing), 200);
    }

    const extracted = await extractUpload(c);
    const files = "files" in extracted ? extracted.files : null;
    let violations: Violation[] = "violation" in extracted ? [extracted.violation] : [];
    const result = files === null ? null : checkArtifactFiles(files, { expectedHash: claimed, tier: TIERS[tier], app: name });
    if (result !== null) violations = [...result.violations, ...bundleViolations(files as Map<string, Uint8Array>)];
    const ok = violations.length === 0 && result !== null && files !== null;

    // Store before recording, so a validated deployment always has its object.
    if (ok) await store.putIfAbsent(artifactKey(claimed), writeTar(files as Map<string, Uint8Array>));

    const by = actor(c);
    const orphaned = await db.transaction(async (tx) => {
      const current = await findDeployment(tx, tenant, name, claimed, true);
      if (current === null) await insertUploaded(tx, tenant, name, claimed, by);
      else if (current.state === "rejected" || current.state === "pruned") await transition(tx, current, current.state, "uploaded", by);
      else if (current.state !== "uploaded") return null; // a concurrent upload of the same hash won
      const d = { tenant_id: tenant, app: name, hash: claimed };
      if (!ok) {
        await transition(tx, d, "uploaded", "rejected", by, { violations: violations.slice(0, 50), manifest: result?.manifest ?? null });
        return [];
      }
      await transition(tx, d, "uploaded", "validated", by, {
        size_bytes: result.sizeBytes,
        manifest: result.manifest,
        violations: null,
        last_error: null,
      });
      await tx.query("delete from permissions where app = $1 and hash = $2", [name, claimed]);
      const perms = result.manifest?.permissions as { network: string[]; secrets: string[] };
      for (const [kind, values] of [
        ["network", perms.network],
        ["secret", perms.secrets],
      ] as const) {
        for (const value of values) {
          await tx.query("insert into permissions (tenant_id, app, hash, kind, value, approved_at) values ($1, $2, $3, $4, $5, $6)", [
            tenant,
            name,
            claimed,
            kind,
            value,
            by.now,
          ]);
        }
      }
      return prune(tx, tenant, name, by);
    });
    for (const key of orphaned ?? []) await store.delete(key).catch(() => {});

    const row = await requireDeployment(db, tenant, name, claimed);
    if (orphaned === null) return c.json(deploymentView(row), 200);
    if (!ok) {
      throw new ApiError(
        "RENOX_DEPLOY_REJECTED",
        violations.slice(0, 50).map((v) => ({ ...v })),
        { deployment: claimed },
      );
    }
    return c.json(deploymentView(row), 201);
  });

  app.get("/v1/apps/:app/deployments", operation(deps, "listDeployments"), tenantAuth(deps, "apps:read"), async (c) => {
    const tenant = tenantId(c);
    const name = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const state = c.req.query("state");
    if (state !== undefined) check("DeploymentState", state);
    const limit = Number(c.req.query("limit") ?? "20");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("limit", "must be an integer from 1 to 100");
    const rows = await listDeployments(db, tenant, name, state, limit);
    return c.json({ deployments: rows.map(deploymentView) });
  });

  app.get("/v1/apps/:app/deployments/:hash", operation(deps, "getDeployment"), tenantAuth(deps, "apps:read"), async (c) => {
    const tenant = tenantId(c);
    const name = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const row = await requireDeployment(db, tenant, name, pathParam(c, "hash", "Sha256"));
    return c.json(deploymentView(row));
  });

  app.put("/v1/apps/:app/deployments/:hash/sourcemaps", operation(deps, "putSourcemaps"), tenantAuth(deps, "deploy"), async (c) => {
    const tenant = tenantId(c);
    const name = (await requireApp(db, tenant, pathParam(c, "app", "AppName"))).name;
    const hash = pathParam(c, "hash", "Sha256");
    await requireDeployment(db, tenant, name, hash);
    const files = await extractSourcemaps(c);
    const notMaps = [...files.keys()].filter((p) => !p.endsWith(".map"));
    if (notMaps.length > 0) {
      throw new ApiError("RENOX_VALIDATION", notMaps.slice(0, 50).map((p) => ({ field: p, reason: "only .map files are accepted" })), { status: 422 });
    }
    await store.put(sourcemapKey(tenant, hash), writeTar(files));
    return c.body(null, 204);
  });
}
