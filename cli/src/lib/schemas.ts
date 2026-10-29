// The contract schemas, bundled into the compiled CLI.
import manifest from "../../../docs/contracts/schemas/manifest.schema.json";
import migrationsChecksums from "../../../docs/contracts/schemas/migrations-checksums.schema.json";
import publicManifest from "../../../docs/contracts/schemas/public-manifest.schema.json";
import routeTable from "../../../docs/contracts/schemas/route-table.schema.json";
import type { Json } from "./schema.ts";

export const schemas = {
  manifest: manifest as Json,
  migrationsChecksums: migrationsChecksums as Json,
  publicManifest: publicManifest as Json,
  routeTable: routeTable as Json,
};

/** renox.toml: the app, permissions, limit overrides, and [security] (#47). */
export const renoxTomlSchema: Json = {
  type: "object",
  additionalProperties: false,
  required: ["app"],
  properties: {
    app: {
      type: "object",
      additionalProperties: false,
      required: ["name", "timezone"],
      properties: {
        name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
        timezone: { type: "string", pattern: "^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$" },
      },
    },
    permissions: {
      type: "object",
      additionalProperties: false,
      properties: {
        network: { type: "array", items: { type: "string" }, uniqueItems: true },
        secrets: { type: "array", items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" }, uniqueItems: true },
      },
    },
    // Checked in depth against manifest.schema.json's `security` and V16 by
    // src/check/security.ts; here only the table names, for "unknown key".
    security: {
      type: "object",
      additionalProperties: false,
      properties: {
        csp: { type: "object" },
        cors: { type: "object" },
        headers: { type: "object" },
        ratelimit: { type: "array" },
      },
    },
    // [modules] (docs/contracts/manifest.md section 4): checked in depth by
    // src/lib/modules/resolve.ts against module-manifest.schema.json.
    modules: { type: "object" },
    // [authz] and [realtime] of the app (manifest.md 1.1, #283): the keys
    // here; references are V25/V26 (src/lib/policies.ts).
    authz: {
      type: "object",
      additionalProperties: false,
      properties: {
        actions: { type: "array", items: { type: "string", pattern: "^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$" }, uniqueItems: true },
        ownership: { type: "object" },
        entities: { type: "object" },
        default_roles: { type: "object" },
        sensitive: { type: "array", items: { type: "string" }, uniqueItems: true },
      },
    },
    realtime: {
      type: "object",
      additionalProperties: false,
      properties: {
        feeds: { type: "object" },
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        cpu_ms: { type: "integer", minimum: 1, maximum: 500 },
        wall_ms: { type: "integer", minimum: 1000, maximum: 60000 },
        memory_mb: { type: "integer", minimum: 16, maximum: 512 },
        concurrency: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
};
