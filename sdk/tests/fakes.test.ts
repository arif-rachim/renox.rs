// @renoxium/sdk/fakes (#323): the storage, AI and webhook stand-ins follow the contract.
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { fakeAi, fakeStorage, fakeUpload, signWebhook } from "../src/fakes.ts";

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

test("fakeStorage().signUpload signs like op_storage_sign_upload and refuses at signing", async () => {
  const s = fakeStorage("app", { now: () => 1_000_000, maxFileBytes: 1000, allowedTypes: ["application/pdf"] });
  const u = await s.signUpload("app/up/a.pdf", { contentType: "application/pdf", maxBytes: 500 });
  expect(u).toEqual({ url: "/_files/app/up/a.pdf?exp=1900&max=500&ct=application%2Fpdf&pub=0&sig=fake", expires_at: 1_900_000, max_bytes: 500 });
  expect((await s.signUpload("app/up/b.pdf", { contentType: "application/pdf", maxBytes: 1, ttlSeconds: 60, public: true })).url).toContain("exp=1060&max=1&ct=application%2Fpdf&pub=1");
  await expect(s.signUpload("app/up/a.pdf", { contentType: "application/pdf", maxBytes: 5, ttlSeconds: 30 })).rejects.toBeInstanceOf(RangeError);
  await expect(s.signUpload("app/up/a.pdf", { contentType: "application/pdf", maxBytes: 5, ttlSeconds: 3601 })).rejects.toBeInstanceOf(RangeError);
  await expect(s.signUpload("app/up/a.pdf", { contentType: "image/png", maxBytes: 5 })).rejects.toMatchObject({ code: "RENOX_STORAGE_TYPE" });
  await expect(s.signUpload("app/up/a.pdf", { contentType: "application/pdf", maxBytes: 1001 })).rejects.toMatchObject({ code: "RENOX_STORAGE_TOO_LARGE" });
  await expect(s.signUpload("app/up/a.pdf", { contentType: "application/pdf", maxBytes: 0 })).rejects.toMatchObject({ code: "RENOX_STORAGE_TOO_LARGE" });
  await expect(s.signUpload("tax/x.pdf", { contentType: "application/pdf", maxBytes: 5 })).rejects.toMatchObject({ code: "RENOX_STORAGE_KEY" });
});

test("fakeUpload enforces max, type, expiry and single use, and stores like put", async () => {
  let t = 1_000_000;
  const s = fakeStorage("app", { now: () => t });
  const { url } = await s.signUpload("app/up/a.txt", { contentType: "text/plain", maxBytes: 4, public: true });
  await expect(fakeUpload(s, url, new Uint8Array(5), "text/plain")).rejects.toMatchObject({ code: "RENOX_BODY_TOO_LARGE" });
  await expect(fakeUpload(s, url, new Uint8Array(2), "text/csv")).rejects.toMatchObject({ code: "RENOX_STORAGE_TYPE" });
  await expect(fakeUpload(s, `${url}x`, new Uint8Array(2), "text/plain")).rejects.toMatchObject({ code: "RENOX_STORAGE_NOT_FOUND" });
  const f = await fakeUpload(s, url, new TextEncoder().encode("abcd"), "text/plain");
  expect(f).toMatchObject({ key: "app/up/a.txt", bytes: 4, content_type: "text/plain", public: true });
  expect(new TextDecoder().decode(await s.read("app/up/a.txt"))).toBe("abcd");
  await expect(fakeUpload(s, url, new Uint8Array(1), "text/plain")).rejects.toMatchObject({ code: "RENOX_STORAGE_CONFLICT" });
  const again = await s.signUpload("app/up/b.txt", { contentType: "text/plain", maxBytes: 4 });
  t += 901_000;
  await expect(fakeUpload(s, again.url, new Uint8Array(1), "text/plain")).rejects.toMatchObject({ code: "RENOX_STORAGE_NOT_FOUND" });
});
