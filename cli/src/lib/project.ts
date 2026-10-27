// renox.toml: read and validate.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Json, isObject, validate } from "./schema.ts";
import { renoxTomlSchema } from "./schemas.ts";

export interface ProjectConfig {
  app: { name: string; timezone: string };
  permissions: { network: string[]; secrets: string[] };
  limits?: { cpu_ms?: number; wall_ms?: number; memory_mb?: number; concurrency?: number };
}

export class ConfigError extends Error {}

export function readProject(dir: string): ProjectConfig {
  const path = join(dir, "renox.toml");
  if (!existsSync(path)) throw new ConfigError("renox.toml not found (run renox in the app folder)");
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`renox.toml does not parse: ${(e as Error).message}`);
  }
  const errors = validate(renoxTomlSchema, raw as Json);
  if (errors.length > 0) throw new ConfigError(`renox.toml: ${errors.join("; ")}`);
  const c = raw as JsonLike;
  const perms = isObject(c.permissions) ? c.permissions : {};
  return {
    app: c.app as ProjectConfig["app"],
    permissions: {
      network: (perms.network as string[] | undefined) ?? [],
      secrets: (perms.secrets as string[] | undefined) ?? [],
    },
    ...(isObject(c.limits) ? { limits: c.limits as ProjectConfig["limits"] } : {}),
  };
}

type JsonLike = { [key: string]: Json };
