// Test helpers for the module commands (#234): a temporary app with module
// trees written from small manifests.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ModuleDef {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  /** Extra TOML appended to module.toml. */
  extra?: string;
}

export function moduleToml(m: ModuleDef): string {
  const deps = Object.entries(m.dependencies ?? {});
  return [
    "[module]",
    `name = "${m.name}"`,
    `version = "${m.version}"`,
    ...(deps.length ? ["", "[dependencies]", ...deps.map(([d, r]) => `${d} = "${r}"`)] : []),
    "",
    m.extra ?? "",
  ].join("\n");
}

/** Writes `<dir>/<name>/module.toml` (and a migration so the tree has more than one file). */
export function writeModule(dir: string, m: ModuleDef): string {
  const tree = join(dir, m.name);
  mkdirSync(join(tree, "migrations"), { recursive: true });
  writeFileSync(join(tree, "module.toml"), moduleToml(m));
  writeFileSync(join(tree, "migrations", "001_init.sql"), `create table ${m.name}__items (id text primary key);\n`);
  return tree;
}

/** A temporary app: renox.toml with `modules` (one line per entry) and the trees under modules/. */
export function app(modules: Record<string, string> = {}, trees: ModuleDef[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "renox-modules-"));
  for (const t of trees) writeModule(join(dir, "modules"), t);
  const lines = ['[app]', 'name = "shop"', 'timezone = "Asia/Dubai"'];
  if (Object.keys(modules).length) lines.push("", "[modules]", ...Object.entries(modules).map(([k, v]) => `${k} = ${v}`));
  writeFileSync(join(dir, "renox.toml"), `${lines.join("\n")}\n`);
  return dir;
}

export const AUTH_EXTRA = `[config]
registration = { type = "enum", values = ["open", "invite"], default = "open" }
session_days = { type = "int", min = 1, max = 365, default = 30 }

[permissions]
tables = "auth__*"
network = ["accounts.google.com"]
secrets = ["AUTH_GOOGLE_CLIENT_SECRET"]

[exports]
views = ["auth__public_users_v1"]

[exports.services]
currentUser = "The signed-in user"
`;
