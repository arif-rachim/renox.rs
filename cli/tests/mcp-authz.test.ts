// #294: the CLI MCP server's authorization tools, run in process on an app
// with [authz], a policy, a tool and a dev database (the protocol itself is
// tests/mcp.test.ts): authz_explain, list_policies, list_tools,
// list_agent_tokens and a confirmed revoke_agent_token, and the
// policies:// resource. Model input never becomes a path or SQL.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { devDb } from "../src/commands/migrate.ts";
import { readResource } from "../src/mcp/resources.ts";
import { callTool } from "../src/mcp/tools.ts";
import { app, BASE } from "./authz-fixture.ts";
import { testWorker } from "./worker-env.ts";

const worker = testWorker();
if (worker) process.env.RENOX_WORKER_PATH = worker;
const repo = join(import.meta.dir, "../..");

const TOOL = `import { tool } from "renox";
import { z } from "zod";
export default tool({
  name: "edit_doc",
  description: "Edit a document's title",
  input: z.object({ id: z.string().min(1), title: z.string() }),
  action: "doc.edit",
  confirm: true,
  async run({ tool }) { return { id: tool.input.id }; },
});
`;

function project(): string {
  const dir = app({ ...BASE, "functions/tools/edit-doc.ts": TOOL, "policies/tests/docs.json": '[{"description":"an editor edits","principal":{"type":"User","id":"u1","roles":["editor"]},"action":"doc.edit","expected":"allow"}]\n' });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(join(repo, "sdk"), join(dir, "node_modules/renox"));
  symlinkSync(join(repo, "sdk/node_modules/zod"), join(dir, "node_modules/zod"));
  return dir;
}

const value = async (name: string, args: Record<string, unknown>, dir: string) => {
  const r = await callTool(name, args, dir);
  if (r === null) throw new Error(`no tool ${name}`);
  return { error: r.isError, value: r.structuredContent };
};

test.skipIf(!worker)("authz_explain: the decision and the deciding policy, with the dev database's roles", async () => {
  const dir = project();
  const denied = await value("authz_explain", { user: "u1", action: "doc.edit" }, dir);
  expect(denied.error).toBe(false);
  expect(denied.value).toMatchObject({ allow: false, policies: [] });
  const allowed = await value("authz_explain", { user: "u1", action: "doc.edit", roles: ["editor"] }, dir);
  expect(allowed.value).toMatchObject({ allow: true });
  expect(String(allowed.value.explanation)).toContain('permit (principal in Renox::Role::"editor"');
  // Input is checked, never interpreted.
  const bad = await value("authz_explain", { user: "u1; rm -rf /", action: "doc.edit" }, dir);
  expect(bad.error).toBe(true);
  expect(bad.value).toMatchObject({ error: { code: "invalid_input" } });
});

test.skipIf(!worker)("list_policies and list_tools from a build; the policies:// resource", async () => {
  const dir = project();
  const p = await value("list_policies", {}, dir);
  expect(p.value.files).toContain("policies/app/docs.cedar");
  expect(p.value.owners).toEqual([{ owner: "app", actions: ["doc.read", "doc.edit"], sensitive: ["doc.edit"], entities: { Doc: { table: "app__docs", attrs: ["owner"] } }, default_roles: { editor: ["doc.edit"] } }]);
  const t = await value("list_tools", {}, dir);
  expect(t.value).toEqual({ endpoint: "/mcp", tools: [expect.objectContaining({ name: "edit_doc", action: "doc.edit", confirm: true, module: "functions/tools/edit-doc" })] });
  const r = readResource("policies://", dir);
  const files = (JSON.parse(r?.text ?? "{}") as { files: Record<string, string> }).files;
  expect(Object.keys(files)).toEqual(["policies/app/docs.cedar", "policies/tests/docs.json"]);
});

test("list_agent_tokens shows no secret; revoke_agent_token needs the id twice", async () => {
  const dir = app({ "renox.toml": '[app]\nname = "x"\ntimezone = "Asia/Dubai"\n' });
  const file = devDb(dir);
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`create table auth__users (id text primary key, email text);
    create table auth__agent_tokens (id text primary key, token_hash text, user_id text, client_id text, client_name text, scopes text, created_at integer, expires_at integer, last_used_at integer, revoked_at integer);
    insert into auth__users values ('u1', 'lina@example.com');`);
  const now = Math.floor(Date.now() / 1000);
  db.query(`insert into auth__agent_tokens values ('agt_0123456789abcdef01234567', 'secret-hash-value', 'u1', 'c1', 'Claude', '["tools:*"]', ?, ?, null, null)`).run(now, now + 3600);
  db.close();
  const list = await value("list_agent_tokens", {}, dir);
  expect(list.value).toEqual({ tokens: [{ id: "agt_0123456789abcdef01234567", email: "lina@example.com", client_name: "Claude", scopes: ["tools:*"], created_at: now, expires_at: now + 3600, last_used_at: null }] });
  expect(JSON.stringify(list.value)).not.toContain("secret-hash-value");
  const unconfirmed = await value("revoke_agent_token", { id: "agt_0123456789abcdef01234567", confirm: "yes" }, dir);
  expect(unconfirmed.error).toBe(true);
  const done = await value("revoke_agent_token", { id: "agt_0123456789abcdef01234567", confirm: "agt_0123456789abcdef01234567" }, dir);
  expect(done.value).toEqual({ revoked: true, id: "agt_0123456789abcdef01234567" });
  expect((await value("list_agent_tokens", {}, dir)).value).toEqual({ tokens: [] });
});
