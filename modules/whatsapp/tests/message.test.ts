// whatsapp.message(id) on the real worker (#705): found, not found, a bad id, and an
// app's whatsapp.message_received handler (tests/app/hooks.ts) reading the text of the
// message the event names.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";
import { hmacHex } from "../lib/cloud-api.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const SECRET = (readFileSync(join(MODULE, "tests/app/.env.test"), "utf8").match(/^WHATSAPP_APP_SECRET=(.*)$/mu) as RegExpMatchArray)[1] as string;

const wa = () => t.service("whatsapp");
type Msg = { id: string; direction: string; kind: string; phone: string; body: string; status: string; at: number };

async function deliver(id: string, from: string, body: string) {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from, timestamp: "1700000000", type: "text", text: { body } }] } }] }] });
  return t.request("POST", "/whatsapp/webhook/whatsapp", { headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${await hmacHex(SECRET, raw)}` }, body: raw });
}

describe.skipIf(!worker)("whatsapp message(id)", () => {
  test("found: the same row inbox() has; not found: null", async () => {
    expect((await deliver("wamid.m1", "971508888801", "cancel please")).json()).toEqual({ received: 1 });
    const inbox = (await wa().inbox({ phone: "+971508888801", direction: "in" })) as Msg[];
    expect(inbox).toHaveLength(1);
    const m = (await wa().message((inbox[0] as Msg).id)) as Msg;
    expect(m).toEqual(inbox[0] as Msg);
    expect(m).toMatchObject({ direction: "in", phone: "+971508888801", body: "cancel please", status: "received" });
    expect(await wa().message("no-such-id")).toBeNull();
  });

  test("a bad id is a TypeError: empty, 129 characters, not a string", async () => {
    for (const bad of ["", "x".repeat(129), 42, null, undefined, { id: "a" }]) {
      await expect(wa().message(bad)).rejects.toThrow(/id must be a non-empty string/u);
    }
    expect(await wa().message("x".repeat(128))).toBeNull();
  });

  test("the app's event handler reads the text of the message the event names", async () => {
    expect((await deliver("wamid.m2", "971508888802", "reschedule to Friday")).json()).toEqual({ received: 1 });
    const id = (t.db.query<{ id: string }>("select id from whatsapp__messages where wa_id = 'wamid.m2'")[0] as { id: string }).id;
    let seen: { body: string }[] = [];
    for (let i = 0; i < 100 && seen.length === 0; i++) {
      seen = t.db.query<{ body: string }>("select body from app__seen where message_id = ?", [id]);
      if (seen.length === 0) await Bun.sleep(50);
    }
    expect(seen).toEqual([{ body: "reschedule to Friday" }]);
  });
});
