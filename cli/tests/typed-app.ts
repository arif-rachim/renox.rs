// A new hello app whose node_modules link this repository's typescript,
// bun-types and SDK, as `bun install` gives a real app (#443).
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newApp } from "../src/commands/new.ts";

const repo = join(import.meta.dir, "../..");

export function typedApp(name = "typed"): string {
  const dir = newApp(name, "hello", mkdtempSync(join(tmpdir(), "renox-types-")));
  mkdirSync(join(dir, "node_modules", "@renoxium"), { recursive: true });
  symlinkSync(join(repo, "node_modules", "typescript"), join(dir, "node_modules", "typescript"), "dir");
  symlinkSync(join(repo, "node_modules", "bun-types"), join(dir, "node_modules", "bun-types"), "dir");
  symlinkSync(join(repo, "sdk"), join(dir, "node_modules", "@renoxium", "sdk"), "dir");
  return dir;
}

export const NUMBER_HANDLER = `import type { Handler } from "@renoxium/sdk";\n\nexport const GET: Handler = async () => 41 + 1;\n`;
