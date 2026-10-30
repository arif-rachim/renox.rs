// The repository layer and the role table of #113 (docs/24-threat-model.md E:
// IDOR row, "Teammate with too much power").

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import spec from "../../../docs/contracts/schemas/deploy-api.yaml";
import { ACTIONS } from "../src/auth/tokens.ts";
import { MATRIX, PERMISSIONS, ROLES, ROUTE_PERMISSIONS, SESSION_PERMISSIONS } from "../src/tenancy/roles.ts";
import { checkTenantQuery, crossTenant, guardDb, requestScope, TenantScopeError, withTenant } from "../src/tenancy/scope.ts";
import { assertScoped, harness, tenant } from "./helpers.ts";

afterEach(assertScoped);

const T = "t_a";
const ok = (sql: string, params: unknown[]) => expect(() => checkTenantQuery(sql, params, T)).not.toThrow();
const refused = (sql: string, params: unknown[]) => expect(() => checkTenantQuery(sql, params, T)).toThrow(TenantScopeError);

describe("withTenant: a statement is bound to the principal's tenant", () => {
  test("select, update, delete need tenant_id = $1 with $1 the principal's tenant", () => {
    ok("select name from apps where tenant_id = $1 and name = $2", [T, "x"]);
    ok("select m.role from memberships m join users u on u.id = m.user_id where m.tenant_id = $1", [T]);
    ok("update tokens set revoked_at = $2 where tenant_id = $1 and id = $3", [T, 1, "tok"]);
    ok("delete from permissions where tenant_id = $1 and app = $2", [T, "x"]);
    refused("select name from apps where name = $1", ["x"]);
    refused("select name from apps where tenant_id = $1", ["t_b"]);
    refused("select name from apps where tenant_id = $2 and name = $1", ["x", T]);
    refused("select name from apps where parent_tenant_id = $1", [T]);
    refused("select name from apps where tenant_id = $10", [T]);
  });

  test("inserts need the principal's tenant in the tenant_id column", () => {
    ok("insert into apps (name, tenant_id, created_at) values ($1, $2, $3) on conflict (name) do nothing", ["x", T, 1]);
    refused("insert into apps (name, tenant_id, created_at) values ($1, $2, $3)", ["x", "t_b", 1]);
    refused("insert into apps (name, created_at) values ($1, $2)", ["x", 1]);
    refused("insert into apps (name, tenant_id, created_at) values ($1, 't_a', $2)", ["x", 1]);
  });

  test("the tenants table is bound through id = $1; platform tables and table-less statements pass", () => {
    ok("select tier, state from tenants where id = $1", [T]);
    refused("select tier, state from tenants where id = $1", ["t_b"]);
    ok("select * from route_entries where hostname = $1", ["x.renox.app"]);
    ok("select node_id from workers where healthy", []);
    ok("select pg_advisory_xact_lock($1)", [8]);
    refused("select r.hostname from route_entries r join apps a on a.name = r.app where r.hostname = $1", ["x"]);
  });

  test("withTenant refuses a principal that is not a tenant; exec and listen are not available", async () => {
    const h = await harness();
    expect(() => withTenant(h.db, undefined)).toThrow();
    expect(() => withTenant(h.db, { kind: "node", nodeId: "n" })).toThrow();
    const db = withTenant(h.db, { kind: "tenant", via: "token", tenantId: T, tokenId: "tok_x", scopes: ["*"], userId: null, role: null });
    expect(db.tenantId).toBe(T);
    await expect(db.exec("select 1")).rejects.toThrow(TenantScopeError);
    await expect(db.query("select 1 from apps where name = $1", ["x"])).rejects.toThrow(TenantScopeError);
    await expect(db.transaction((tx) => tx.query("select 1 from apps where name = $1", ["x"]))).rejects.toThrow(TenantScopeError);
  });

  test("the harness reports a raw statement during a tenant request; withTenant and crossTenant do not count", async () => {
    const h = await harness();
    await tenant(h, T);
    const seen: string[] = [];
    const guarded = guardDb(h.db, (sql) => seen.push(sql));
    await guarded.query("select 1 from apps"); // outside a request
    await requestScope.run({ tenantId: T, scoped: false }, async () => {
      await guarded.query("select 1 from apps where name = $1", ["x"]);
      await guarded.query("select 1 from workers");
      await withTenant(guarded, { kind: "tenant", via: "token", tenantId: T, tokenId: "tok_x", scopes: [], userId: null, role: null }).query("select 1 from apps where tenant_id = $1", [T]);
      await crossTenant(guarded, "test").query("select 1 from deployments where hash = $1", ["h"]);
      await guarded.transaction((tx) => tx.query("select 1 from secrets"));
    });
    expect(seen).toEqual(["select 1 from apps where name = $1", "select 1 from secrets"]);
  });
});

describe("crossTenant call sites", () => {
  test("every statement that looks across tenants is listed here with its reason", () => {
    const src = new URL("../src/", import.meta.url).pathname;
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && f !== join("tenancy", "scope.ts"));
    const sites: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(join(src, f), "utf8").matchAll(/crossTenant\(\s*[a-zA-Z.]+,\s*"([^"]+)"\s*\)/gu)) sites.push(`${f}: ${m[1]}`);
    }
    expect(sites.sort()).toEqual([
      "auth/accounts.ts: a pending device code belongs to no tenant until a user approves it",
      "auth/notify.ts: a user's own email address",
      "deployments/repo.ts: an artifact object is shared by every app that uploaded the same hash",
      "domains/ownership.ts: a certificate belongs to a hostname, whichever tenant held it",
      "domains/ownership.ts: a certificate belongs to a hostname, whichever tenant held it",
      "domains/ownership.ts: a hostname is claimed by at most one tenant",
      "domains/repo.ts: a custom hostname mirrors the route entries of whichever tenant holds it verified",
      "domains/repo.ts: the domain job checks and orders for every tenant's domains",
      "domains/routes.ts: a certificate belongs to a hostname, whichever tenant held it",
      "ingest/routes.ts: the tenant's quota is read through control/billing, which binds the tenant id as $3",
      "tenants/backups.ts: a signed export URL names its export, not a tenant",
      "tenants/backups.ts: app names are unique across the platform",
      "tokens/routes.ts: an operator account and its tokens belong to no tenant",
    ]);
  });
});

describe("the role table", () => {
  type Op = { operationId?: string; "x-renox-scope"?: string; security?: { [k: string]: string[] }[] };
  const ops = Object.values((spec as { paths: Record<string, Record<string, Op>> }).paths).flatMap((item) =>
    Object.entries(item)
      .filter(([m]) => ["get", "post", "put", "patch", "delete"].includes(m))
      .map(([, op]) => op),
  );

  test("every operation of deploy-api.yaml is in ROUTE_PERMISSIONS with its x-renox-scope as the permission", () => {
    const wrong: string[] = [];
    for (const op of ops) {
      const id = op.operationId as string;
      const scope = op["x-renox-scope"];
      const ours = ROUTE_PERMISSIONS[id];
      if (scope !== undefined && ours !== scope) wrong.push(`${id}: contract ${scope}, table ${String(ours)}`);
      if (scope === undefined && !["public", "node", "operator", "account"].includes(String(ours))) wrong.push(`${id}: contract has no scope, table ${String(ours)}`);
    }
    expect(wrong).toEqual([]);
  });

  test("every permission in ROUTE_PERMISSIONS exists, and the matrix covers each permission once", () => {
    const callers = new Set<string>([...PERMISSIONS, "account", "public", "node", "operator"]);
    expect(Object.entries(ROUTE_PERMISSIONS).filter(([, p]) => !callers.has(p))).toEqual([]);
    expect(Object.keys(MATRIX).sort()).toEqual([...PERMISSIONS].sort());
    expect([...ACTIONS, ...SESSION_PERMISSIONS].length).toBe(new Set(PERMISSIONS).size);
  });

  test("owner holds everything; each lower role holds a subset of the one above", () => {
    for (const p of PERMISSIONS) expect(MATRIX[p]).toContain("owner");
    for (let i = 1; i < ROLES.length; i++) {
      for (const p of PERMISSIONS) if (MATRIX[p].includes(ROLES[i] as (typeof ROLES)[number])) expect(MATRIX[p]).toContain(ROLES[i - 1] as (typeof ROLES)[number]);
    }
    // docs/24-threat-model.md E: secrets write and team changes require admin.
    expect(MATRIX["secrets:write"]).toEqual(["owner", "admin"]);
    expect(MATRIX["team:write"]).toEqual(["owner", "admin"]);
  });

  /** The `| `permission` | yes | … |` rows of a markdown table, as permission → roles. */
  const matrixRows = (lines: string[]): Record<string, string[]> => {
    const rows = new Map<string, string[]>();
    for (const line of lines) {
      const m = /^\| `([a-z:*]+)` \|(.*)\|$/u.exec(line);
      if (m === null) continue;
      const cells = (m[2] as string).split("|").map((c) => c.trim());
      rows.set(m[1] as string, ROLES.filter((_, i) => cells[i] === "yes"));
    }
    return Object.fromEntries(rows);
  };
  const expected = () => Object.fromEntries(PERMISSIONS.map((p) => [p, [...MATRIX[p]]]));

  test("control/api/README.md prints the same matrix", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url).pathname, "utf8");
    expect(matrixRows(readme.split("\n"))).toEqual(expected());
  });

  test("docs/contracts/deploy-api.md section 2.1 prints the same matrix and operation table", () => {
    const doc = readFileSync(new URL("../../../docs/contracts/deploy-api.md", import.meta.url).pathname, "utf8").split("\n");
    const start = doc.indexOf("<!-- role-matrix -->");
    expect(start).toBeGreaterThan(-1);
    const end = doc.findIndex((l, i) => i > start + 1 && !l.startsWith("|"));
    expect(matrixRows(doc.slice(start + 1, end))).toEqual(expected());
    // The operation table: every listed operation needs exactly the permission of its row.
    const callers: Record<string, string> = { "node token": "node", "operator token": "operator", "signed-in user": "account", none: "public" };
    const listed = new Map<string, string>();
    const table = doc.indexOf("<!-- operation-table -->");
    expect(table).toBeGreaterThan(-1);
    for (const line of doc.slice(table + 1, doc.findIndex((l, i) => i > table + 1 && !l.startsWith("|")))) {
      const m = /^\| (`[a-z:]+`|node token|operator token|signed-in user|none) \| (`[A-Za-z]+`.*) \|$/u.exec(line);
      if (m === null) continue;
      const permission = callers[m[1] as string] ?? (m[1] as string).slice(1, -1);
      for (const id of (m[2] as string).matchAll(/`([A-Za-z]+)`/gu)) listed.set(id[1] as string, permission);
    }
    const ids = new Set(ops.map((op) => op.operationId as string));
    expect([...listed.keys()].sort()).toEqual([...ids].sort());
    expect([...listed].filter(([id, p]) => ROUTE_PERMISSIONS[id] !== p)).toEqual([]);
  });
});
