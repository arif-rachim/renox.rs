// The help of every command (#449): `renox --help` groups the commands,
// `renox <command> --help` prints one command's usage, an unknown command
// gets a "did you mean", and an unknown flag is named before the command
// runs. The flag lists are what each command's own parser accepts; a test
// (cli/tests/usage.test.ts) checks that every command of main.ts has an entry.

export interface CommandHelp {
  group: Group;
  /** One line per form of the command, without the leading `renox `. */
  usage: string[];
  /** What it does, in one or two sentences. */
  summary: string;
  /** Every flag the command accepts (`--name` or `-x`). */
  flags: string[];
  /** The command passes its remaining arguments on (renox test to bun test): flags are not checked. */
  passThrough?: boolean;
}

export const GROUPS = ["Start", "Develop", "Deploy and operate", "Modules", "Other"] as const;
export type Group = (typeof GROUPS)[number];

export const HELP: Record<string, CommandHelp> = {
  new: { group: "Start", usage: ["new <name> [--template blank|hello]"], summary: "Create an app in ./<name> (hello: a function, a page and a test; blank: one function). Prints the next steps.", flags: ["--template"] },
  dev: {
    group: "Develop",
    usage: ["dev [--port 8787] [--jobs]", "dev --worker <path>"],
    summary: "Run the app on the local worker at http://localhost:8787 and rebuild on every save. --worker runs another renox-worker: the pinned release, or one with a sigstore signature and provenance that cosign verifies.",
    flags: ["--port", "--worker", "--jobs"],
  },
  build: { group: "Develop", usage: ["build [--out <dir>]"], summary: "Build the artifact into .renox/artifact/<hash>/.", flags: ["--out"] },
  check: {
    group: "Develop",
    usage: ["check [--json] [--strict] [--secrets] [--security] [--types-only | --no-types]"],
    summary:
      "Validate config, routes, templates, manifest, modules and renox.lock; type check the TypeScript (the app's own typescript); lint SQL, fetch and global state; scan for secrets. --security prints the effective headers per route; --strict fails on a drifted template override.",
    flags: ["--json", "--strict", "--secrets", "--security", "--target", "--types-only", "--no-types"],
  },
  test: {
    group: "Develop",
    usage: ["test [pattern...] [--seed <file.sql>]... [-u]"],
    summary: "Run tests/*.test.ts on the local worker with a temporary database per test file (@renoxium/sdk/test), and the policy cases of policies/tests/*.json. Needs bun on PATH.",
    flags: ["--seed", "-u", "--update-snapshots"],
    passThrough: true,
  },
  migrate: { group: "Develop", usage: ["migrate [--db <file>]"], summary: "Run the migrations of the installed modules (lock order) and the app's own on the dev database.", flags: ["--db"] },
  jobs: { group: "Develop", usage: ["jobs list [--state <s>] [--json]", "jobs run <name> [--module <m>]", "jobs retry <id>"], summary: "The dev app's jobs: scheduled, queued, running and dead.", flags: ["--state", "--json", "--module", "--db"] },
  authz: {
    group: "Develop",
    usage: ["authz explain --user <id> --action <a> [--resource <type:id>] [--role <r>]... [--db <file>] [--json]"],
    summary: "Why the policies allow or deny a request, with roles and resource attributes from the dev database.",
    flags: ["--user", "--action", "--resource", "--role", "--db", "--json"],
  },
  mcp: { group: "Develop", usage: ["mcp [--project <dir>]"], summary: "The local MCP server on stdio for coding agents: docs, check, tests, dev status.", flags: ["--project"] },
  login: { group: "Deploy and operate", usage: ["login [--api <url>] [--with-token]"], summary: "Sign the CLI in: it prints a link to approve in the dashboard. --with-token reads a token from stdin (CI).", flags: ["--api", "--with-token"] },
  deploy: {
    group: "Deploy and operate",
    usage: ["deploy [--json] [--skip-types]", "deploy --rollback [<hash>] [--app <name>] [--json]"],
    summary: "Type check, build, upload, validate and activate the app; prints the live URL. --rollback switches back to the previous (or the named) deployment.",
    flags: ["--json", "--rollback", "--app", "--skip-types"],
  },
  logs: {
    group: "Deploy and operate",
    usage: ["logs [--follow] [--since <t>] [--source all|server|client] [--deployment <hash>] [--app <name>] [--json] [--raw]"],
    summary: "The app's log lines; --follow keeps streaming.",
    flags: ["--follow", "-f", "--since", "--source", "--deployment", "--app", "--json", "--raw"],
  },
  secrets: { group: "Deploy and operate", usage: ["secrets set <NAME> [--app <name>]", "secrets list [--app <name>]", "secrets rm <NAME> [--app <name>]"], summary: "The app's secrets. set reads the value from stdin and never prints it.", flags: ["--app"] },
  tokens: { group: "Deploy and operate", usage: ["tokens list", "tokens create <name> --scope <s>... [--expires-days <n>]", "tokens revoke <id>"], summary: "Tenant tokens for CI and scripts; a new value is shown once.", flags: ["--scope", "--expires-days"] },
  db: {
    group: "Deploy and operate",
    usage: ["db export [--out <file>] [--app <name>]", "db import <file> [--app <name>]", "db restore --at <time> --as <new-app> [--app <name>]", "db seed [--db <file>]"],
    summary: "Download the production database (sha256 checked), import into a staging app, restore a point in time into a new app; seed loads seeds/*.sql into the dev database.",
    flags: ["--out", "--app", "--at", "--as", "--db"],
  },
  add: {
    group: "Modules",
    usage: ["add <module> [--version <range>] [--source path:<dir>|git:<url>#<ref>] [--mount <path>] [--yes]"],
    summary: "Install a module: resolve it, show the permissions it (and any official module it needs) asks for, then write renox.toml and renox.lock.",
    flags: ["--version", "--source", "--mount", "--yes", "-y"],
  },
  remove: { group: "Modules", usage: ["remove <module>"], summary: "Uninstall a module (its tables stay: migrations are forward-only).", flags: [] },
  approve: { group: "Modules", usage: ["approve <module> [--yes]"], summary: "Show the permission diff of a module upgrade and approve it.", flags: ["--yes", "-y"] },
  publish: { group: "Modules", usage: ["publish [--dir <tree>] [--dry-run]"], summary: "Sign a module tree (module.sig) and upload it to the registry.", flags: ["--dir", "--dry-run"] },
};

/** `renox --help`: the commands by group. */
export function overview(version: string): string {
  const out = [`renox ${version}: build and deploy Renoxium apps`, "", "Usage: renox <command> [options]    renox <command> --help for one command", ""];
  for (const g of GROUPS) {
    const names = Object.entries(HELP).filter(([, h]) => h.group === g);
    if (names.length === 0) continue;
    out.push(`${g}:`);
    for (const [, h] of names) for (const u of h.usage) out.push(`  ${u}`);
    out.push("");
  }
  out.push(
    "Other:",
    "  --version                              the CLI version and the renox-worker it pins",
    "  --help, help [<command>]               this text, or one command's",
    "",
    "Exit codes: 0 ok, 1 user error, 2 validation error, 3 environment error, 130 interrupted.",
    "Environment: RENOX_TOKEN and RENOX_API_URL override the credentials of renox login; RENOX_WORKER_PATH",
    "overrides the renox-worker binary of dev and test (not verified: for a worker you built).",
    "Docs: https://renoxium.com/docs",
  );
  return out.join("\n");
}

/** `renox <command> --help`. */
export function commandHelp(name: string): string {
  const h = HELP[name] as CommandHelp;
  return [...h.usage.map((u, i) => `${i === 0 ? "usage:" : "      "} renox ${u}`), "", h.summary, "", "Docs: https://renoxium.com/docs/cli"].join("\n");
}

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/** The closest known name within two edits (or a prefix match), else null. */
export function suggest(input: string, names: readonly string[]): string | null {
  let best: string | null = null;
  let score = Infinity;
  for (const n of names) {
    const s = n.startsWith(input) && input.length >= 2 ? 0.5 : distance(input, n);
    if (s < score) {
      best = n;
      score = s;
    }
  }
  return score <= 2 ? best : null;
}

/** The first argument that looks like a flag the command does not take, or null. A lone `-` and values after `--` are not flags. */
export function unknownFlag(name: string, args: readonly string[]): string | null {
  const h = HELP[name];
  if (h === undefined || h.passThrough) return null;
  for (const a of args) {
    if (a === "--") return null;
    if (!a.startsWith("-") || a === "-" || /^-\d/u.test(a)) continue;
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (!h.flags.includes(flag)) return flag;
  }
  return null;
}
