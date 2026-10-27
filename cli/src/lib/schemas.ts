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

/** renox.toml (F1): the app, permissions, and limit overrides. */
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
