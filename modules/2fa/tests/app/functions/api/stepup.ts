// Test only (#769): a declared twofa error as a caller in another module
// (twofa_probe) and the app itself see it: RENOX_MODULE_SERVICE with
// details.cause_code STEP_UP_REQUIRED and details.cause_details.verify_url.
import { twofa, twofa_probe } from "renox:modules";

export async function GET({ url }) {
  const next = url.searchParams.get("next") ?? "/";
  const viaModule = await twofa_probe.stepUp(next);
  let direct;
  try {
    await twofa.requireRecent({ within: 5, next });
    direct = { returned: true };
  } catch (e) {
    direct = { code: e.code, cause_code: e.details?.cause_code ?? null, cause_details: e.details?.cause_details ?? null, message: String(e.message) };
  }
  return Response.json({ viaModule, direct });
}
