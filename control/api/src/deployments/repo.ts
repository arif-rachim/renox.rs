// Deployment records and their state machine (docs/contracts/deploy-api.md
// section 5). Every transition is checked against the contract's table,
// applied only if the row is still in the expected state, and audited.

import { writeAudit } from "../audit.ts";
import { assertTransition } from "../contract.ts";
import { jsonb, num, numOrNull, type Db } from "../db/db.ts";
import { conflict, notFound } from "../errors.ts";

export type DeploymentState = "uploaded" | "validated" | "rejected" | "activating" | "active" | "superseded" | "suspended" | "pruned";

export interface DeploymentRow {
  tenant_id: string;
  app: string;
  hash: string;
  state: DeploymentState;
  created_at: number;
  updated_at: number;
  size_bytes: number;
  manifest: Record<string, unknown> | null;
  secrets_version: number | null;
  activated_at: number | null;
  last_error: Record<string, unknown> | null;
  violations: Record<string, unknown>[] | null;
}

/** Who causes a transition, for its audit row. */
export interface Actor {
  actor: string;
  requestId: string;
  now: number;
}

const COLUMNS = "tenant_id, app, hash, state, created_at, updated_at, size_bytes, manifest, secrets_version, activated_at, last_error, violations";

function toRow(r: Record<string, unknown>): DeploymentRow {
  return {
    tenant_id: r.tenant_id as string,
    app: r.app as string,
    hash: r.hash as string,
    state: r.state as DeploymentState,
    created_at: num(r.created_at),
    updated_at: num(r.updated_at),
    size_bytes: num(r.size_bytes),
    manifest: (r.manifest as Record<string, unknown> | null) ?? null,
    secrets_version: numOrNull(r.secrets_version),
    activated_at: numOrNull(r.activated_at),
    last_error: (r.last_error as Record<string, unknown> | null) ?? null,
    violations: (r.violations as Record<string, unknown>[] | null) ?? null,
  };
}

/** The deployment `(app, hash)` of `tenantId`, or null. `lock` takes a row lock inside a transaction. */
export async function findDeployment(db: Db, tenantId: string, app: string, hash: string, lock = false): Promise<DeploymentRow | null> {
  const rows = await db.query(
    `select ${COLUMNS} from deployments where tenant_id = $1 and app = $2 and hash = $3${lock ? " for update" : ""}`,
    [tenantId, app, hash],
  );
  return rows[0] === undefined ? null : toRow(rows[0]);
}

export async function requireDeployment(db: Db, tenantId: string, app: string, hash: string, lock = false): Promise<DeploymentRow> {
  const row = await findDeployment(db, tenantId, app, hash, lock);
  if (row === null) throw notFound();
  return row;
}

export async function listDeployments(db: Db, tenantId: string, app: string, state: string | undefined, limit: number): Promise<DeploymentRow[]> {
  const rows = await db.query(
    `select ${COLUMNS} from deployments where tenant_id = $1 and app = $2 and ($3::text is null or state = $3) order by created_at desc, hash limit $4`,
    [tenantId, app, state ?? null, limit],
  );
  return rows.map(toRow);
}

/** The `Deployment` schema of the contract. */
export function deploymentView(d: DeploymentRow): Record<string, unknown> {
  const permissions = (d.manifest?.permissions as { network?: string[]; secrets?: string[] } | undefined) ?? {};
  return {
    app: d.app,
    hash: d.hash,
    state: d.state,
    created_at: d.created_at,
    updated_at: d.updated_at,
    size_bytes: d.size_bytes,
    permissions: { network: permissions.network ?? [], secrets: permissions.secrets ?? [] },
    secrets_version: d.secrets_version,
    activated_at: d.activated_at,
    last_error: d.last_error,
    violations: d.violations,
  };
}

async function auditTransition(tx: Db, d: { tenant_id: string; app: string; hash: string }, from: string, to: string, by: Actor): Promise<void> {
  await writeAudit(tx, {
    at: by.now,
    tenantId: d.tenant_id,
    actor: by.actor,
    action: "deploymentState",
    target: { app: d.app, hash: d.hash, from, to },
    status: 200,
    requestId: by.requestId,
  });
}

/** Inserts a new deployment in the machine's initial state, `uploaded`. */
export async function insertUploaded(tx: Db, tenantId: string, app: string, hash: string, by: Actor): Promise<void> {
  await tx.query(
    "insert into deployments (tenant_id, app, hash, state, created_at, updated_at) values ($1, $2, $3, 'uploaded', $4, $4)",
    [tenantId, app, hash, by.now],
  );
  await auditTransition(tx, { tenant_id: tenantId, app, hash }, "", "uploaded", by);
}

export interface Changes {
  size_bytes?: number;
  manifest?: unknown;
  secrets_version?: number | null;
  activated_at?: number | null;
  last_error?: unknown;
  violations?: unknown;
}

/** Moves `(app, hash)` from `from` to `to` with `changes`; 409 if the table forbids it or the row moved meanwhile. */
export async function transition(tx: Db, d: { tenant_id: string; app: string; hash: string }, from: DeploymentState, to: DeploymentState, by: Actor, changes: Changes = {}): Promise<void> {
  assertTransition("deployment", from, to);
  const sets = ["state = $4", "updated_at = $5"];
  const params: unknown[] = [d.tenant_id, d.app, d.hash, to, by.now, from];
  for (const [key, value] of Object.entries(changes)) {
    params.push(key === "manifest" || key === "last_error" || key === "violations" ? (value === null ? null : jsonb(value)) : value);
    sets.push(`${key} = $${params.length}${key === "manifest" || key === "last_error" || key === "violations" ? "::jsonb" : ""}`);
  }
  const rows = await tx.query(
    `update deployments set ${sets.join(", ")} where tenant_id = $1 and app = $2 and hash = $3 and state = $6 returning hash`,
    params,
  );
  if (rows.length === 0) throw conflict("state", `the deployment is no longer ${from}`);
  await auditTransition(tx, d, from, to, by);
}

/** deploy-api.md section 5: at most this many validated + superseded deployments per app. */
export const RETAINED = 50;

/**
 * Prunes the oldest validated and superseded deployments of `app` beyond
 * RETAINED. Returns the object keys that no deployment refers to any more;
 * the caller deletes them after the transaction commits.
 */
export async function prune(tx: Db, tenantId: string, app: string, by: Actor): Promise<string[]> {
  const old = await tx.query<{ hash: string; state: DeploymentState }>(
    `select hash, state from deployments where tenant_id = $1 and app = $2 and state in ('validated', 'superseded')
     order by updated_at desc, hash offset $3 for update`,
    [tenantId, app, RETAINED],
  );
  const orphaned: string[] = [];
  for (const d of old) {
    await transition(tx, { tenant_id: tenantId, app, hash: d.hash }, d.state, "pruned", by);
    const refs = await tx.query("select 1 from deployments where hash = $1 and state not in ('pruned', 'rejected') limit 1", [d.hash]);
    if (refs.length === 0) orphaned.push(artifactKey(d.hash));
  }
  return orphaned;
}

export const artifactKey = (hash: string): string => `artifacts/${hash}.tar`;
export const sourcemapKey = (tenantId: string, hash: string): string => `sourcemaps/${tenantId}/${hash}.tar`;
