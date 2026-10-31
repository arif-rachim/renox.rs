// The 2fa pages in both directions (#336; docs/08-template-engine.md, RTL):
// the factors page, the authenticator and passkey enrolment, the recovery
// codes and the verification, in `en` (ltr) and `ar` (rtl), snapshotted,
// with no English message of their keys left.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { bothDirections, stableIds } from "../../i18n/tests/rtl.ts";
import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

/** A new secret per enrolment page: its QR code, its text and the passkey options. */
const stable = (html: string): string =>
  stableIds(html)
    .replace(/<div id="qr"[^>]*>[\s\S]*?<\/svg><\/div>/gu, '<div id="qr"><qr></div>')
    .replace(/(<code id="secret"[^>]*>)[A-Z2-7 ]+</gu, "$1<secret><")
    .replace(/data-options="[^"]*"/gu, 'data-options="<options>"');

describe.skipIf(!worker)("2fa in both directions", () => {
  test("every page in en (ltr) and ar (rtl), snapshotted, no English left", async () => {
    const u = t.as("rtl");
    await u.action("/auth/register", "default", { email: "rtl@example.com", password: "correct horse battery", display_name: "Rtl" });
    expect((await u.action("/auth/login", "default", { email: "rtl@example.com", password: "correct horse battery" })).status).toBe(303);
    await bothDirections(
      MODULE,
      [
        { name: "factors", path: "/2fa", as: u, template: "pages/index.html" },
        { name: "enroll totp", path: "/2fa/enroll/totp", as: u, template: "pages/enroll/totp.html" },
        { name: "enroll passkey", path: "/2fa/enroll/passkey", as: u, template: "pages/enroll/passkey.html" },
        { name: "recovery", path: "/2fa/recovery", as: u, template: "pages/recovery.html" },
        { name: "verify", path: "/2fa/verify", as: u, template: "pages/verify.html" },
      ],
      stable,
    );
  });
});
