// renox new <name> [--template blank|hello]

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { TEMPLATES, type TemplateName, TSCONFIG } from "../lib/templates.ts";

const NAME = /^[a-z][a-z0-9-]{0,62}$/u;

export function newApp(name: string, template: string, parent = process.cwd()): string {
  if (!NAME.test(name)) throw new Error(`app name ${JSON.stringify(name)} must match ${NAME.source}`);
  if (!(template in TEMPLATES)) throw new Error(`unknown template ${template} (blank, hello)`);
  const dir = resolve(parent, name);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${name}/ exists and is not empty`);
  const files: Record<string, string> = {
    ...TEMPLATES[template as TemplateName],
    "renox.toml": `[app]\nname = "${name}"\ntimezone = "Asia/Dubai"\n\n[permissions]\n# Outbound hosts for fetch, e.g. ["api.stripe.com"]; empty = no network.\nnetwork = []\n# Secret names the app reads from ctx.secrets.\nsecrets = []\n`,
    "package.json": `${JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        scripts: { dev: "renox dev", build: "renox build", check: "renox check" },
        dependencies: { renox: "^0.1.0" },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": TSCONFIG,
    ".gitignore": "node_modules/\n.renox/\n.env\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

export function run(args: string[]): number {
  const name = args.find((a) => !a.startsWith("--"));
  const t = args.indexOf("--template");
  const template = t >= 0 ? args[t + 1] : "blank";
  if (!name || template === undefined) {
    console.error("usage: renox new <name> [--template blank|hello]");
    return 2;
  }
  const dir = newApp(name, template);
  console.log(`created ${name}/ from the ${template} template\n  cd ${name} && renox dev`);
  void dir;
  return 0;
}
