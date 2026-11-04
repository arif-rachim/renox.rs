// renox new <name> [--template blank|hello]: writes the app, then prints the
// steps to a live app and the docs URL (#449).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import cliPackage from "../../package.json" with { type: "json" };
import { EXIT, UserError } from "../errors.ts";
import { COMMON, TEMPLATES, type TemplateName, TSCONFIG } from "../lib/templates.ts";

/**
 * The CLI's own version, read from cli/package.json at build time (bun
 * build --compile inlines it). `renox new` pins the SDK to it: the CLI and
 * the `@renoxium/sdk` package release at one version (#376), so an app scaffolded by
 * release X installs SDK X.
 */
export const CLI_VERSION: string = cliPackage.version;

const NAME = /^[a-z][a-z0-9-]{0,62}$/u;

export function newApp(name: string, template: string, parent = process.cwd()): string {
  if (!NAME.test(name))
    throw new UserError(`app name ${JSON.stringify(name)} is not valid`, {
      hint: "use lowercase letters, digits, and -, starting with a letter (at most 63 characters)",
    });
  if (!(template in TEMPLATES)) throw new UserError(`unknown template ${JSON.stringify(template)}`, { hint: "use --template blank or --template hello" });
  const dir = resolve(parent, name);
  if (existsSync(dir) && readdirSync(dir).length > 0)
    throw new UserError(`${name}/ exists and is not empty`, { hint: "choose another name, or remove the folder" });
  const files: Record<string, string> = {
    ...COMMON,
    ...TEMPLATES[template as TemplateName],
    "renox.toml": `[app]\nname = "${name}"\ntimezone = "Asia/Dubai"\n\n[permissions]\n# Outbound hosts for fetch, e.g. ["api.stripe.com"]; empty = no network.\nnetwork = []\n# Secret names the app reads from ctx.secrets.\nsecrets = []\n`,
    "package.json": `${JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        scripts: { dev: "renox dev", build: "renox build", check: "renox check", test: "renox test", deploy: "renox deploy" },
        dependencies: { "@renoxium/sdk": `^${CLI_VERSION}` },
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
    writeFileSync(p, content.replaceAll("{{APP}}", name));
  }
  return dir;
}

export const DOCS_URL = "https://renoxium.com/docs";

/** What `renox new` prints after writing the app (#449): every step to a live app, in order. */
export function nextSteps(name: string): string {
  return [
    `Created ${name}/. Next:`,
    "",
    `  cd ${name}`,
    "  bun install        # the @renoxium/sdk types and test helpers",
    "  renox dev          # http://localhost:8787, reloads on save",
    "  renox login        # once: approve the sign-in in the dashboard",
    "  renox deploy       # prints the live URL",
    "",
    `Docs: ${DOCS_URL}`,
  ].join("\n");
}

export function run(args: string[]): number {
  const name = args.find((a) => !a.startsWith("--"));
  const t = args.indexOf("--template");
  const template = t >= 0 ? args[t + 1] : "blank";
  if (!name || template === undefined) {
    console.error("usage: renox new <name> [--template blank|hello]");
    return EXIT.USER;
  }
  newApp(name, template);
  console.log(nextSteps(name));
  return 0;
}
