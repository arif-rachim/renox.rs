// The module registry (#324; docs/contracts/deploy-api.md 0.5 section 19,
// manifest.md 1.2 section 5). Publishers belong to a tenant; a version is
// written once, after its tree hash is recomputed (without `module.sig`)
// and its signature verified against an unrevoked key of the publisher.
// The catalog is shared by every tenant; an app's approval is its own row.
//
// | Operation | Here |
// | --- | --- |
// | createPublisher, rotatePublisherKey | the publisher and its Ed25519 keys |
// | publishModuleVersion | tar -> files, MF15, the manifest's name/version/publisher, immutable |
// | listRegistryModules, getModuleVersion, downloadModuleVersion, diffModuleVersions | reads |
// | disableModuleVersion | operator, by hash: every version with it, the apps that have it counted and their owners emailed |
// | listAppModules, installModule | the app's approval records |

import { createPublicKey, verify as edVerify } from "node:crypto";

import type { Context, Hono } from "hono";
import { contentHash, extractTar, TarRejected } from "@renox/artifact-validate";

import { operation } from "../audit.ts";
import { tenantAuth } from "../auth/middleware.ts";
import type { Deps, Env } from "../context.ts";
import { num, type Db } from "../db/db.ts";
import { ApiError, conflict, invalid, notFound } from "../errors.ts";
import { pathParam, readBody } from "../http.ts";
import { opsAuth } from "../ops/auth.ts";
import { tenantDb } from "../tenancy/scope.ts";

const MAX_TREE_BYTES = 20 * 1024 * 1024;
const PUBLISHER = /^[a-z0-9][a-z0-9-]{0,38}$/u;
const MODULE = /^[a-z][a-z0-9_]{0,31}$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/u;
const PUBKEY = /^[A-Za-z0-9_-]{43}$/u;
const RESERVED = new Set(["renox", "official", "app"]);

type Row = Record<string, unknown>;

interface Permissions {
  tables?: string;
  network: string[];
  secrets: string[];
  slots: string[];
  hooks: string[];
  roles?: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function permissionsOf(v: unknown): Permissions {
  const p = (v !== null && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    ...(typeof p.tables === "string" ? { tables: p.tables } : {}),
    network: strings(p.network),
    secrets: strings(p.secrets),
    slots: strings(p.slots),
    hooks: strings(p.hooks),
    ...(Array.isArray(p.roles) ? { roles: strings(p.roles) } : {}),
  };
}

const canonical = (p: Permissions): string =>
  JSON.stringify({ tables: p.tables ?? null, network: [...p.network].sort(), secrets: [...p.secrets].sort(), slots: [...p.slots].sort(), hooks: [...p.hooks].sort(), roles: [...(p.roles ?? [])].sort() });

async function body(c: Context<Env>): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/u.test(c.req.header("content-type") ?? "")) throw invalid("content-type", "must be application/json");
  const bytes = await readBody(c, 64 * 1024);
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("body", "not valid UTF-8 JSON");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw invalid("body", "must be a JSON object");
  return v as Record<string, unknown>;
}

function param(c: Context<Env>, name: string, re: RegExp): string {
  const v = c.req.param(name) ?? "";
  if (!re.test(v)) throw notFound();
  return v;
}

const keyIdOf = (publicKey: string): string => `ed25519:${publicKey}`;

async function publisherOf(db: Db, name: string): Promise<Row | undefined> {
  return (await db.query<Row>("select name, tenant_id, created_at from registry_publishers where name = $1", [name]))[0];
}

async function publisherJson(db: Db, name: string): Promise<unknown> {
  const p = (await publisherOf(db, name)) as Row;
  const keys = await db.query<Row>("select key_id, added_at, revoked_at from registry_keys where publisher = $1 order by added_at, key_id", [name]);
  return {
    name,
    tenant_id: p.tenant_id,
    keys: keys.map((k) => ({ key_id: k.key_id, added_at: num(k.added_at), revoked_at: k.revoked_at === null ? null : num(k.revoked_at) })),
    created_at: num(p.created_at),
  };
}

function versionJson(r: Row): unknown {
  return {
    publisher: r.publisher,
    name: r.name,
    version: r.version,
    hash: r.hash,
    key_id: r.key_id,
    description: r.description ?? null,
    isolation: r.isolation,
    permissions: JSON.parse(r.permissions as string),
    migrations: (JSON.parse(r.migration_files as string) as string[]).length,
    price: r.price === null ? null : JSON.parse(r.price as string),
    published_at: num(r.published_at),
    disabled: r.disabled_at === null ? null : { at: num(r.disabled_at), reason: r.disabled_reason },
  };
}

async function versionRow(db: Db, publisher: string, name: string, version: string): Promise<Row> {
  const r = (await db.query<Row>("select * from registry_versions where publisher = $1 and name = $2 and version = $3", [publisher, name, version]))[0];
  if (r === undefined) throw notFound();
  return r;
}

/** MF15 at publish: the tree, its module.sig, and the publisher's keys. */
async function checkUpload(db: Db, publisher: string, name: string, version: string, files: Map<string, Uint8Array>): Promise<{ hash: string; keyId: string; signature: string; manifest: Record<string, unknown> }> {
  const reject = (reason: string) => new ApiError("RENOX_DEPLOY_REJECTED", [{ rule: "MF15", reason }]);
  const rawSig = files.get("module.sig");
  const rawToml = files.get("module.toml");
  if (rawSig === undefined) throw reject("module.sig is missing");
  if (rawToml === undefined) throw reject("module.toml is missing");
  let sig: Record<string, unknown>;
  let manifest: Record<string, unknown>;
  try {
    sig = JSON.parse(new TextDecoder().decode(rawSig)) as Record<string, unknown>;
    manifest = Bun.TOML.parse(new TextDecoder().decode(rawToml)) as Record<string, unknown>;
  } catch {
    throw reject("module.sig or module.toml does not parse");
  }
  const mod = (manifest.module ?? {}) as Record<string, unknown>;
  const pub = (manifest.publisher ?? {}) as Record<string, unknown>;
  if (mod.name !== name || mod.version !== version) throw reject(`module.toml is ${String(mod.name)} ${String(mod.version)}, not ${name} ${version}`);
  if (pub.name !== publisher) throw reject("[publisher] name is not the path's publisher");
  if (sig.publisher !== publisher || sig.name !== name || sig.module_version !== version || typeof sig.key_id !== "string" || typeof sig.signature !== "string") throw reject("module.sig does not name this version");
  const key = (await db.query<Row>("select key_id, revoked_at from registry_keys where publisher = $1 and key_id = $2", [publisher, sig.key_id]))[0];
  if (key === undefined) throw reject("the signing key is not a key of the publisher");
  if (key.revoked_at !== null) throw reject("the signing key is revoked");
  const tree = new Map(files);
  tree.delete("module.sig");
  const hash = contentHash(tree);
  if (sig.hash !== hash) throw reject("module.sig hashes another tree");
  const message = new TextEncoder().encode(`renox-module-v1\n${publisher}/${name}@${version}\n${hash}\n`);
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: sig.key_id.replace(/^ed25519:/u, "") }, format: "jwk" });
  let ok = false;
  try {
    ok = edVerify(null, message, publicKey, Buffer.from(sig.signature, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) throw reject("the signature does not verify");
  return { hash, keyId: sig.key_id, signature: sig.signature, manifest };
}

export function registerRegistry(app: Hono<Env>, deps: Deps): void {
  app.post("/v1/publishers", operation(deps, "createPublisher"), tenantAuth(deps, "registry:publish"), async (c) => {
    const db = tenantDb(deps, c);
    const b = await body(c);
    const name = typeof b.name === "string" ? b.name : "";
    const pk = typeof b.public_key === "string" ? b.public_key : "";
    if (!PUBLISHER.test(name)) throw invalid("name", "must match ^[a-z0-9][a-z0-9-]{0,38}$");
    if (!PUBKEY.test(pk)) throw invalid("public_key", "must be the 32-byte Ed25519 key, base64url");
    if (RESERVED.has(name) || (await publisherOf(db, name)) !== undefined) throw conflict("name", "taken");
    const now = deps.now();
    await db.query("insert into registry_publishers (name, tenant_id, created_at) values ($1, $2, $3)", [name, db.tenantId, now]);
    await db.query("insert into registry_keys (key_id, publisher, added_at) values ($1, $2, $3)", [keyIdOf(pk), name, now]);
    c.set("auditTarget", { publisher: name, key_id: keyIdOf(pk) });
    return c.json(await publisherJson(db, name), 201);
  });

  app.post("/v1/publishers/:publisher/keys", operation(deps, "rotatePublisherKey"), tenantAuth(deps, "registry:publish"), async (c) => {
    const db = tenantDb(deps, c);
    const name = param(c, "publisher", PUBLISHER);
    const p = await publisherOf(db, name);
    if (p === undefined || p.tenant_id !== db.tenantId) throw notFound();
    const b = await body(c);
    const pk = typeof b.public_key === "string" ? b.public_key : "";
    if (!PUBKEY.test(pk)) throw invalid("public_key", "must be the 32-byte Ed25519 key, base64url");
    const revoke = strings(b.revoke);
    const now = deps.now();
    await db.query("insert into registry_keys (key_id, publisher, added_at) values ($1, $2, $3) on conflict (key_id) do nothing", [keyIdOf(pk), name, now]);
    for (const k of revoke) {
      if (k === keyIdOf(pk)) throw conflict("revoke", "the new key cannot be revoked");
      await db.query("update registry_keys set revoked_at = $3 where publisher = $1 and key_id = $2 and revoked_at is null", [name, k, now]);
    }
    c.set("auditTarget", { publisher: name, key_id: keyIdOf(pk), revoked: revoke.join(",") });
    return c.json(await publisherJson(db, name));
  });

  app.put("/v1/registry/:publisher/:name/:version", operation(deps, "publishModuleVersion"), tenantAuth(deps, "registry:publish"), async (c) => {
    const db = tenantDb(deps, c);
    const publisher = param(c, "publisher", PUBLISHER);
    const name = param(c, "name", MODULE);
    const version = c.req.param("version") ?? "";
    if (!SEMVER.test(version)) throw invalid("version", "must be semver");
    const p = await publisherOf(db, publisher);
    if (p === undefined || p.tenant_id !== db.tenantId) throw notFound();
    const exists = await db.query<Row>("select 1 from registry_versions where publisher = $1 and name = $2 and version = $3", [publisher, name, version]);
    if (exists.length > 0) throw conflict("version", "published; versions are immutable");
    const raw = await readBody(c, MAX_TREE_BYTES);
    let files: Map<string, Uint8Array>;
    try {
      files = await extractTar(raw, { gzip: false });
    } catch (e) {
      if (e instanceof TarRejected) throw new ApiError("RENOX_DEPLOY_REJECTED", [{ rule: "T1", reason: e.message }]);
      throw e;
    }
    const { hash, keyId, signature, manifest } = await checkUpload(db, publisher, name, version, files);
    const mod = (manifest.module ?? {}) as Record<string, unknown>;
    const permissions = permissionsOf(manifest.permissions);
    const migrations = [...files.keys()].filter((f) => /^migrations\/[0-9]{3}_[a-z0-9_]+\.sql$/u.test(f)).map((f) => f.slice("migrations/".length)).sort();
    const templates = [...files.keys()].filter((f) => /^(pages|partials)\/.+\.html$/u.test(f)).sort();
    await deps.store.putIfAbsent(`registry/${publisher}/${name}/${version}.tar`, raw);
    await db.query(
      "insert into registry_versions (publisher, name, version, hash, key_id, signature, description, isolation, permissions, migration_files, template_files, price, published_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
      [
        publisher,
        name,
        version,
        hash,
        keyId,
        signature,
        typeof mod.description === "string" ? mod.description : null,
        mod.isolation === "isolate" ? "isolate" : "shared",
        JSON.stringify(permissions),
        JSON.stringify(migrations),
        JSON.stringify(templates),
        mod.price === undefined ? null : JSON.stringify(mod.price),
        deps.now(),
      ],
    );
    c.set("auditTarget", { publisher, name, version, hash, key_id: keyId });
    return c.json(versionJson(await versionRow(db, publisher, name, version)), 201);
  });

  app.get("/v1/registry", operation(deps, "listRegistryModules"), tenantAuth(deps, "registry:read"), async (c) => {
    const db = tenantDb(deps, c);
    const q = (c.req.query("q") ?? "").toLowerCase().slice(0, 100);
    const rows = await db.query<Row>("select * from registry_versions where disabled_at is null order by publisher, name, published_at desc", []);
    // The newest version of each module by semver (a prerelease is older than its release).
    const key = (v: string): number[] => {
      const [core, pre] = v.split("-", 2) as [string, string | undefined];
      return [...core.split(".").map(Number), pre === undefined ? 1 : 0];
    };
    const newer = (a: string, b: string): boolean => {
      const [x, y] = [key(a), key(b)];
      for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
      return false;
    };
    const newest = new Map<string, Row>();
    for (const r of rows) {
      const k = `${r.publisher}/${r.name}`;
      const seen = newest.get(k);
      if (seen === undefined || newer(r.version as string, seen.version as string)) newest.set(k, r);
    }
    const items = [...newest.values()]
      .filter((r) => q === "" || `${r.publisher} ${r.name} ${r.description ?? ""}`.toLowerCase().includes(q))
      .slice(0, 50)
      .map(versionJson);
    return c.json({ items, next_cursor: null });
  });

  app.get("/v1/registry/:publisher/:name/diff", operation(deps, "diffModuleVersions"), tenantAuth(deps, "registry:read"), async (c) => {
    const db = tenantDb(deps, c);
    const publisher = param(c, "publisher", PUBLISHER);
    const name = param(c, "name", MODULE);
    const from = c.req.query("from") ?? "";
    const to = c.req.query("to") ?? "";
    if (!SEMVER.test(from) || !SEMVER.test(to)) throw invalid("from", "from and to are semver");
    const [a, b] = [await versionRow(db, publisher, name, from), await versionRow(db, publisher, name, to)];
    const pa = JSON.parse(a.permissions as string) as Permissions;
    const pb = JSON.parse(b.permissions as string) as Permissions;
    const side = (x: Permissions, y: Permissions) => ({
      tables: x.tables !== undefined && x.tables !== y.tables ? x.tables : null,
      network: x.network.filter((n) => !y.network.includes(n)),
      secrets: x.secrets.filter((n) => !y.secrets.includes(n)),
      slots: x.slots.filter((n) => !y.slots.includes(n)),
      hooks: x.hooks.filter((n) => !y.hooks.includes(n)),
      roles: (x.roles ?? []).filter((n) => !(y.roles ?? []).includes(n)),
    });
    const ma = JSON.parse(a.migration_files as string) as string[];
    const mb = JSON.parse(b.migration_files as string) as string[];
    const ta = new Set(JSON.parse(a.template_files as string) as string[]);
    return c.json({
      from,
      to,
      permissions: { added: side(pb, pa), removed: side(pa, pb) },
      migrations: mb.filter((m) => !ma.includes(m)),
      contract: { ops_from: null, ops_to: null },
      templates: (JSON.parse(b.template_files as string) as string[]).filter((t) => !ta.has(t) || a.hash !== b.hash),
    });
  });

  app.get("/v1/registry/:publisher/:name/:version", operation(deps, "getModuleVersion"), tenantAuth(deps, "registry:read"), async (c) => {
    const db = tenantDb(deps, c);
    return c.json(versionJson(await versionRow(db, param(c, "publisher", PUBLISHER), param(c, "name", MODULE), c.req.param("version") ?? "")));
  });

  app.get("/v1/registry/:publisher/:name/:version/tree", operation(deps, "downloadModuleVersion"), tenantAuth(deps, "registry:read"), async (c) => {
    const db = tenantDb(deps, c);
    const [publisher, name, version] = [param(c, "publisher", PUBLISHER), param(c, "name", MODULE), c.req.param("version") ?? ""];
    const r = await versionRow(db, publisher, name, version);
    if (r.disabled_at !== null) throw conflict("hash", "disabled");
    const tar = await deps.store.get(`registry/${publisher}/${name}/${version}.tar`);
    if (tar === null) throw notFound();
    return new Response(tar as BodyInit, { headers: { "content-type": "application/x-tar" } });
  });

  app.post("/v1/registry/disable", operation(deps, "disableModuleVersion"), opsAuth(deps), async (c) => {
    const b = await body(c);
    const hash = typeof b.hash === "string" && /^[0-9a-f]{64}$/u.test(b.hash) ? b.hash : null;
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (hash === null) throw invalid("hash", "must be 64 hex");
    if (reason.length < 10 || reason.length > 500) throw invalid("reason", "10 to 500 characters");
    const enabled = b.enabled === true;
    const versions = await deps.db.query<Row>("select publisher, name, version from registry_versions where hash = $1", [hash]);
    if (versions.length === 0) throw notFound();
    const at = enabled ? null : deps.now();
    await deps.db.query("update registry_versions set disabled_at = $2, disabled_reason = $3 where hash = $1", [hash, at, enabled ? null : reason]);
    const installs = await deps.db.query<Row>("select distinct tenant_id from app_modules where hash = $1", [hash]);
    if (!enabled) {
      for (const t of installs) {
        const owner = await deps.db.query<Row>(
          "select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.role = 'owner'",
          [t.tenant_id],
        );
        const email = owner[0]?.email;
        if (typeof email === "string") {
          await deps.mailer
            .send({ to: email, kind: "module_disabled", subject: "A module of your app was disabled", text: `A module version your app uses (${versions.map((v) => `${v.publisher}/${v.name}@${v.version}`).join(", ")}) was disabled by Renox: ${reason}. Running deployments keep running; plan its removal or an upgrade.` })
            .catch(() => undefined);
        }
      }
    }
    c.set("auditTarget", { hash, reason, enabled: String(enabled), tenants_notified: String(installs.length) });
    return c.json({ hash, disabled_at: at, tenants_notified: enabled ? 0 : installs.length });
  });

  app.get("/v1/apps/:app/modules", operation(deps, "listAppModules"), tenantAuth(deps, "apps:read"), async (c) => {
    const db = tenantDb(deps, c);
    const appName = pathParam(c, "app", "AppName");
    const known = await db.query<Row>("select 1 from apps where tenant_id = $1 and name = $2", [db.tenantId, appName]);
    if (known.length === 0) throw notFound();
    const rows = await db.query<Row>("select * from app_modules where tenant_id = $1 and app = $2 order by name", [db.tenantId, appName]);
    const items = [];
    for (const r of rows) {
      const d = (await db.query<Row>("select disabled_at, disabled_reason from registry_versions where hash = $1 and disabled_at is not null", [r.hash]))[0];
      items.push({
        name: r.name,
        source: r.source,
        version: r.version,
        hash: r.hash,
        approved: JSON.parse(r.approved as string),
        approved_at: num(r.approved_at),
        approved_by: r.approved_by ?? null,
        disabled: d === undefined ? null : { at: num(d.disabled_at), reason: d.disabled_reason },
      });
    }
    return c.json({ items });
  });

  app.post("/v1/apps/:app/modules", operation(deps, "installModule"), tenantAuth(deps, "apps:write"), async (c) => {
    const db = tenantDb(deps, c);
    const appName = pathParam(c, "app", "AppName");
    const known = await db.query<Row>("select 1 from apps where tenant_id = $1 and name = $2", [db.tenantId, appName]);
    if (known.length === 0) throw notFound();
    const b = await body(c);
    const m = /^registry:([a-z0-9][a-z0-9-]{0,38})\/([a-z][a-z0-9_]{0,31})$/u.exec(typeof b.source === "string" ? b.source : "");
    if (m === null) throw invalid("source", "must be registry:<publisher>/<name>");
    const version = typeof b.version === "string" ? b.version : "";
    const v = await versionRow(db, m[1] as string, m[2] as string, version);
    if (v.disabled_at !== null) throw conflict("hash", "disabled");
    if (b.hash !== v.hash) throw conflict("hash", "not the version's tree");
    const approved = permissionsOf(b.approved);
    if (canonical(approved) !== canonical(JSON.parse(v.permissions as string) as Permissions)) throw conflict("approved", "not the version's permission request");
    const user = c.get("principal");
    const userId = user !== undefined && user.kind === "tenant" ? (user.userId ?? null) : null;
    const now = deps.now();
    await db.query(
      "insert into app_modules (tenant_id, app, name, source, version, hash, approved, approved_at, approved_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (tenant_id, app, name) do update set source = excluded.source, version = excluded.version, hash = excluded.hash, approved = excluded.approved, approved_at = excluded.approved_at, approved_by = excluded.approved_by",
      [db.tenantId, appName, m[2], b.source, version, v.hash, JSON.stringify(approved), now, userId],
    );
    c.set("auditTarget", { app: appName, name: m[2] as string, version, hash: v.hash as string, approved: JSON.stringify(approved) });
    return c.json({ name: m[2], source: b.source, version, hash: v.hash, approved, approved_at: now, approved_by: userId, disabled: null }, 201);
  });
}

