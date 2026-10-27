import { expect, test } from "bun:test";
import { GET } from "../functions/api/hello.ts";

test('GET /api/hello returns {"ok":true}', async () => {
  const res = await GET({ req: new Request("http://localhost/api/hello") });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.text()).toBe('{"ok":true}');
});

test("spike adapter registers a Deno.serve handler that calls GET", async () => {
  let registered: ((req: Request) => Response | Promise<Response>) | undefined;
  (globalThis as { Deno?: unknown }).Deno = {
    serve: (h: (req: Request) => Response | Promise<Response>) => {
      registered = h;
    },
  };
  await import("../_spike/index.ts");
  expect(registered).toBeDefined();
  const ok = await registered!(new Request("http://localhost/"));
  expect(await ok.json()).toEqual({ ok: true });
  const denied = await registered!(new Request("http://localhost/", { method: "POST" }));
  expect(denied.status).toBe(405);
  delete (globalThis as { Deno?: unknown }).Deno;
});
