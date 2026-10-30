// The storage module in an app, on the real worker (#332): a stored image
// through <x-image> (its dimensions and srcset from the stored metadata), a
// multipart upload through the page, the per-owner quota, an owner's folder
// closed to another user and open to an admin (storage.manage).
// docs/23 "Storage".
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);
const PASSWORD = "correct horse battery";

async function user(name: string, role?: string): Promise<TestApp> {
  const u = t.as(name);
  expect((await u.action("/auth/register", "default", { email: `${name}@example.com`, password: PASSWORD, display_name: name })).status).toBe(200);
  expect((await u.action("/auth/login", "default", { email: `${name}@example.com`, password: PASSWORD })).status).toBe(303);
  if (role) expect((await u.request("POST", `/api/grant?role=${role}`)).status).toBe(200);
  return u;
}

const idOf = (name: string): string => (t.db.query<{ id: string }>("select id from auth__users where email = ?", [`${name}@example.com`])[0]?.id as string).toLowerCase();

/** A multipart page action with the page's own CSRF token. */
async function uploadText(u: TestApp, name: string, text: string) {
  const page = await u.page("/files");
  const csrf = /name="_csrf" value="([^"]+)"/u.exec(page.html)?.[1] as string;
  const b = "----renoxtest";
  const body = `--${b}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrf}\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--${b}--\r\n`;
  return u.request("POST", "/files?/upload", { body, headers: { "content-type": `multipart/form-data; boundary=${b}` } });
}

describe.skipIf(!worker)("storage in an app", () => {
  test("a stored image renders through <x-image> with its dimensions and srcset; a text file through the page's multipart form", async () => {
    const lina = await user("lina");
    const f = (await lina.request("POST", "/api/photo")).json<{ key: string; width: number; height: number }>();
    expect([f.width, f.height]).toEqual([64, 48]);
    const r = await lina.page("/files");
    expect(r.status).toBe(200);
    expect(r.html).toMatch(/<img src="\/_img\/[^"]*chair\.png\?w=160"[^>]* srcset="[^"]+"/u);
    expect(r.html).toContain('width="160"');
    expect(r.html).toContain('height="120"');
    const up = await uploadText(lina, "Notes 2026.txt", "hello");
    expect(up.status).toBe(200);
    expect(up.html).toContain("notes-2026.txt");
  });

  test("the per-owner quota refuses a file past it; another user does not see the folder, an admin does", async () => {
    const lina = t.as("lina");
    // 400 KB at a time (the gateway's body limit is under the 1 MB quota): the third goes past it.
    const part = "x".repeat(400 * 1024);
    expect((await uploadText(lina, "a.txt", part)).html).not.toContain("(quota)");
    expect((await uploadText(lina, "b.txt", part)).html).not.toContain("(quota)");
    const r = await uploadText(lina, "c.txt", part);
    expect(r.html).toContain("(quota)");
    expect(r.html).not.toContain("c.txt");
    const omar = await user("omar");
    expect((await omar.page("/files")).html).not.toContain("chair.png");
    expect((await omar.page(`/files?owner=${idOf("lina")}`)).status).toBe(403);
    const admin = await user("adel", "admin");
    const a = await admin.page(`/files?owner=${idOf("lina")}`);
    expect(a.status).toBe(200);
    expect(a.html).toContain("chair.png");
  });
});
