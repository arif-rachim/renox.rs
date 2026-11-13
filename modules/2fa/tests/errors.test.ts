// The 2fa module's declared errors (#769, ops.md section 15.2, "Errors"):
// module.toml lists STEP_UP_REQUIRED, INVALID, UNAUTHENTICATED and
// SELF_RESET in [exports.errors], so a caller in another module (the test
// module twofa_probe, tests/caller) and the app see the code as
// details.cause_code of the RENOX_MODULE_SERVICE error, and the step-up's
// details.verify_url as details.cause_details.verify_url, as the README
// promises.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { app, type TestApp } from "../../../sdk/src/test.ts";

const MODULE = join(import.meta.dir, "..");
const worker = process.env.RENOX_TEST_SPEC ?? process.env.RENOX_WORKER_PATH;
const t = worker ? await app({ project: MODULE }) : (undefined as unknown as TestApp);

type Seen = { code: string; cause_code: string | null; cause_details: { verify_url?: string } | null; message: string };

describe.skipIf(!worker)("2fa declared errors", () => {
  test("a caller in another module sees STEP_UP_REQUIRED and details.verify_url", async () => {
    const r = await t.as("anon").request("GET", "/api/stepup?next=/admin/refunds");
    expect(r.status).toBe(200);
    const { viaModule, direct } = r.json<{ viaModule: Seen; direct: Seen }>();
    for (const seen of [viaModule, direct]) {
      expect(seen.code).toBe("RENOX_MODULE_SERVICE");
      expect(seen.cause_code).toBe("STEP_UP_REQUIRED");
      expect(seen.cause_details).toEqual({ verify_url: "/2fa/verify?next=%2Fadmin%2Frefunds" });
      expect(seen.message).toContain("twofa.requireRecent failed");
    }
  });

  test("reset's own codes cross too: UNAUTHENTICATED without a signed-in caller", async () => {
    const r = await t.as("nobody").request("POST", "/api/reset", { body: { user_id: "someone" } });
    // tests/app/functions/api/reset.ts answers `error: details.cause_code ?? code`.
    expect(r.json<{ error: string }>().error).toBe("UNAUTHENTICATED");
    const bad = await t.as("nobody").request("POST", "/api/reset", { body: { user_id: "" } });
    expect(bad.json<{ error: string }>().error).toBe("INVALID");
  });
});
