// #235: the `shop` app with the `auth` module (path:modules/auth) installed:
// a module page and a function under its mount, services, a migration with a
// public view, a slot partial; the app's own page, a function, and an
// override of auth's login template.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { addModule } from "../src/commands/add.ts";

export const AUTH_TOML = `[module]
name = "auth"
version = "1.0.0"

[permissions]
tables = "auth__*"
slots = ["app.header"]

[exports]
views = ["auth__public_users_v1"]

[exports.services]
currentUser = "The signed-in user"

[exports.events."auth.user_registered"]
payload = { type = "object", required = ["user_id"], properties = { user_id = { type = "string" } } }

[[slots]]
name = "app.header"
template = "partials/menu.html"
`;

export const LOGIN_HTML = `<main class="auth-login"><h1>Sign in</h1></main>\n`;

const AUTH_FILES: Record<string, string> = {
  "module.toml": AUTH_TOML,
  "services.ts": `export async function currentUser(ctx) { return null; }\n`,
  "pages/login.ts": `export async function load(ctx) { return { title: "Sign in" }; }\n`,
  "pages/login.html": LOGIN_HTML,
  "partials/menu.html": `<a class="account" href="/auth/login">Account</a>\n`,
  "functions/logout.ts": `export function POST() { return new Response(null, { status: 204 }); }\n`,
  "migrations/001_users.sql": "create table auth__users (id text primary key, email text not null);\ncreate view auth__public_users_v1 as select id from auth__users;\n",
};

const APP_FILES: Record<string, string> = {
  "renox.toml": `[app]\nname = "shop"\ntimezone = "Asia/Dubai"\n`,
  "pages/_layouts/main.html": `<!doctype html><html><body><header><r-slot name="app.header" /></header><slot /></body></html>\n`,
  "pages/index.html": `<r-layout use="main"><h1>Shop</h1></r-layout>\n`,
  "functions/api/health.ts": `export function GET() { return Response.json({ ok: true }); }\n`,
  "migrations/001_init.sql": "create table app__orders (id text primary key);\n",
};

export function write(dir: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
}

/** The app with `auth` installed (renox add --yes), plus `extra` files. */
export async function shopWithAuth(extra: Record<string, string> = {}, auth: Record<string, string> = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "renox-shop-auth-"));
  write(dir, APP_FILES);
  write(join(dir, "modules/auth"), { ...AUTH_FILES, ...auth });
  write(dir, extra);
  const log = console.log;
  console.log = () => {};
  try {
    const code = await addModule(dir, "auth", { source: "path:modules/auth", mount: "/auth", yes: true }, async () => true);
    if (code !== 0) throw new Error(`renox add auth: exit ${code}`);
  } finally {
    console.log = log;
  }
  return dir;
}
