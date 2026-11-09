// The whatsapp module in sandbox mode on the real worker (#591): no
// WHATSAPP_* secrets, yet a send ends as a `sent` row holding the rendered
// template, and outbox() reads it back.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
/**
 * The harness runs a module's tests in `tests/app/` only. The sandbox app (sandbox = true, no `.env.test`, so no
 * secrets) lives in `tests/app-sandbox/`: it is staged as the `tests/app/` of a scratch module folder, its
 * `path:` sources made absolute.
 */
function stage(): string {
  const src = join(MODULE, "tests/app-sandbox");
  const root = mkdtempSync(join(tmpdir(), "wa-sandbox-"));
  const dest = join(root, "tests", "app");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(root, "module.toml"), "");
  cpSync(src, dest, { recursive: true });
  const toml = readFileSync(join(src, "renox.toml"), "utf8").replace(/"path:([^"]+)"/gu, (_m, rel: string) => JSON.stringify(`path:${resolve(src, rel)}`));
  writeFileSync(join(dest, "renox.toml"), toml);
  return root;
}

const t = worker ? await app({ project: stage() }) : (undefined as unknown as TestApp);

type Row = { id: string; status: string; wa_id: string | null; body: string; error: string | null };
const rowOf = (id: string) => t.db.query<Row>("select id, status, wa_id, body, error from whatsapp__messages where id = ?", [id])[0] as Row;

describe.skipIf(!worker)("whatsapp sandbox in an app", () => {
  test("a template send with no secrets ends sent, with the rendered template", async () => {
    const { id } = (await t.service("whatsapp").sendTemplate("+971501234567", "order_shipped", ["#42"], "en")) as { id: string };
    let row = rowOf(id);
    for (let i = 0; i < 60 && row.status !== "sent"; i++) {
      await Bun.sleep(50);
      row = rowOf(id);
    }
    expect(row).toMatchObject({ status: "sent", wa_id: `sandbox-${id}`, error: null });
    expect(JSON.parse(row.body)).toEqual({ name: "order_shipped", language: "en", components: [{ type: "body", parameters: [{ type: "text", text: "#42" }] }] });
    const out = (await t.service("whatsapp").outbox(10)) as { id: string; status: string }[];
    expect(out.find((m) => m.id === id)).toMatchObject({ status: "sent" });
  });
});
