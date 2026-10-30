// renox/fakes (#323): the storage, AI and webhook stand-ins follow the contract.
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { fakeAi, fakeStorage, signWebhook } from "../src/fakes.ts";

test("fakeStorage keeps files under the module prefix and refuses like the ops", async () => {
  const s = fakeStorage("app", { now: () => 1_000_000 });
  const f = await s.put("app/a.txt", new TextEncoder().encode("hi"), { contentType: "text/plain" });
  expect(f).toMatchObject({ key: "app/a.txt", bytes: 2, content_type: "text/plain", public: false });
  expect(f.sha256).toHaveLength(64);
  expect(new TextDecoder().decode(await s.read("app/a.txt"))).toBe("hi");
  await expect(s.put("tax/x", new Uint8Array(1), { contentType: "text/plain" })).rejects.toMatchObject({ code: "RENOX_STORAGE_KEY" });
  await expect(s.put("app/x.svg", new Uint8Array(1), { contentType: "image/svg+xml" })).rejects.toMatchObject({ code: "RENOX_STORAGE_TYPE" });
  await expect(s.get("app/none")).rejects.toMatchObject({ code: "RENOX_STORAGE_NOT_FOUND" });
  await expect(s.sign("app/a.txt", 5)).rejects.toBeInstanceOf(RangeError);
  expect((await s.sign("app/a.txt", 60)).url).toStartWith("/_files/app/a.txt?exp=1060");
  await s.put("app/b.txt", new Uint8Array(1), { contentType: "text/plain" });
  const page = await s.list("app/", { limit: 1 });
  expect(page.items.map((x) => x.key)).toEqual(["app/a.txt"]);
  expect(page.next_cursor).toBe("app/a.txt");
  expect(await s.delete("app/a.txt")).toBe(true);
});

test("fakeAi replays answers and runs local tools in order", async () => {
  let ran = 0;
  const ai = fakeAi([{ tool: "vat", input: { amount: 100 } }, { text: "AED 5" }]);
  const r = await ai.chat({
    messages: [{ role: "user", content: "VAT?" }],
    tools: [{ name: "vat", description: "", input_schema: {}, run: () => (ran++, { rate: 5 }) }],
  });
  expect(ran).toBe(1);
  expect(r.content).toEqual([{ type: "text", text: "AED 5" }]);
  expect(r.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
  expect(ai.requests).toHaveLength(1);
});

test("signWebhook signs as each provider does", async () => {
  const req = await signWebhook("checkout", "k", { id: "evt_1" });
  expect(req.headers.get("cko-signature")).toBe(createHmac("sha256", "k").update('{"id":"evt_1"}').digest("hex"));
  const stripe = await signWebhook("stripe", "whsec", "x", { now: 1_000_000 });
  expect(stripe.headers.get("stripe-signature")).toBe(`t=1000,v1=${createHmac("sha256", "whsec").update("1000.x").digest("hex")}`);
  const generic = await signWebhook("generic", "k", "x", { header: "X-Sig" });
  expect(generic.headers.get("x-sig")).toBe(createHmac("sha256", "k").update("x").digest("hex"));
});
