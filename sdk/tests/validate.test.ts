// validate() with Standard Schema libraries (#44; docs/04-isolation-security.md,
// "Input validation"): zod and valibot, every input kind, and the failures.
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { z } from "zod";

import { formToObject, validate, ValidationError } from "../src/index.ts";

const Zod = z.object({ sku: z.string().min(1), qty: z.coerce.number().int().positive(), tags: z.array(z.string()).default([]) });
const Valibot = v.object({
  sku: v.pipe(v.string(), v.minLength(1)),
  qty: v.pipe(v.unknown(), v.transform(Number), v.integer(), v.minValue(1)),
  tags: v.optional(v.array(v.string()), []),
});

const json = (body: unknown, type = "application/json"): Request =>
  new Request("https://app.test/x", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

for (const [name, schema] of [
  ["zod", Zod],
  ["valibot", Valibot],
] as const) {
  describe(name, () => {
    test("a valid JSON body returns the schema output (defaults applied)", async () => {
      const out = await validate(json({ sku: "a1", qty: 2 }), schema);
      expect(out).toEqual({ sku: "a1", qty: 2, tags: [] });
    });

    test("a +json content type is read as JSON", async () => {
      expect(await validate(json({ sku: "a1", qty: 1 }, "application/vnd.api+json; charset=utf-8"), schema)).toEqual({
        sku: "a1",
        qty: 1,
        tags: [],
      });
    });

    test("an invalid body throws ValidationError with paths", async () => {
      const e = await validate(json({ sku: "", qty: 0, tags: ["ok", 3] }), schema).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ValidationError);
      const paths = (e as ValidationError).issues.map((i) => i.path.join("."));
      expect(paths).toContain("sku");
      expect(paths).toContain("qty");
      expect(paths).toContain("tags.1");
      for (const i of (e as ValidationError).issues) expect(typeof i.message).toBe("string");
    });

    test("an urlencoded body, FormData, and URLSearchParams validate as objects", async () => {
      const req = new Request("https://app.test/x", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "sku=a1&qty=3&tags=x&tags=y",
      });
      expect(await validate(req, schema)).toEqual({ sku: "a1", qty: 3, tags: ["x", "y"] });
      const form = new FormData();
      form.append("sku", "b2");
      form.append("qty", "4");
      form.append("tags", "only");
      form.append("tags", "two");
      expect(await validate(form, schema)).toEqual({ sku: "b2", qty: 4, tags: ["only", "two"] });
      expect(await validate(new URLSearchParams("sku=c3&qty=5"), schema)).toEqual({ sku: "c3", qty: 5, tags: [] });
    });

    test("a multipart body is read as a form", async () => {
      const form = new FormData();
      form.append("sku", "m1");
      form.append("qty", "1");
      const req = new Request("https://app.test/x", { method: "POST", body: form });
      expect(req.headers.get("content-type")).toStartWith("multipart/form-data");
      expect(await validate(req, schema)).toEqual({ sku: "m1", qty: 1, tags: [] });
    });

    test("a plain value is validated as is", async () => {
      expect(await validate({ sku: "p", qty: 9 }, schema)).toEqual({ sku: "p", qty: 9, tags: [] });
    });
  });
}

test("malformed JSON and an unsupported content type are ValidationErrors on the root", async () => {
  const bad = new Request("https://app.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  const e1 = (await validate(bad, Zod).catch((x: unknown) => x)) as ValidationError;
  expect(e1).toBeInstanceOf(ValidationError);
  expect(e1.issues).toEqual([{ message: "request body is not valid JSON", path: [] }]);
  const text = new Request("https://app.test/x", { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
  const e2 = (await validate(text, Zod).catch((x: unknown) => x)) as ValidationError;
  expect(e2.issues[0]?.message).toBe('unsupported content type "text/plain": expected JSON or a form');
});

test("toResponse() is a 400 with the issues; the message names the first issue", async () => {
  const e = (await validate({ sku: 1, qty: 1 }, Zod).catch((x: unknown) => x)) as ValidationError;
  expect(e.message).toStartWith("validation failed: sku: ");
  const res = e.toResponse();
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toStartWith("application/json");
  expect(await res.json()).toEqual({ issues: e.issues.map((i) => ({ message: i.message, path: [...i.path] })) });
});

test("a schema without ~standard is a TypeError, not a ValidationError", async () => {
  const e = await validate({}, { parse: () => ({}) } as never).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(TypeError);
});

test("formToObject keeps uploads as File and never inherits prototype keys", () => {
  const form = new FormData();
  form.append("doc", new File(["abc"], "a.txt", { type: "text/plain" }));
  form.append("__proto__", "x");
  const o = formToObject(form);
  expect(o.doc).toBeInstanceOf(File);
  expect(Object.getPrototypeOf(o)).toBeNull();
  expect(o["__proto__"]).toBe("x");
});
