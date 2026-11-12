// Test only: the 2fa `reset` service for the user in the body. A service error
// reaches the caller as RENOX_MODULE_SERVICE with the service's own code in
// details.cause_code when it is a platform error (RENOX_FORBIDDEN), else null
// and only the message survives; both come back as JSON.
import { twofa } from "renox:modules";

export async function POST({ req }) {
  const { user_id } = await req.json();
  try {
    return Response.json(await twofa.reset(user_id));
  } catch (e) {
    return Response.json({ error: e.details?.cause_code ?? e.code ?? "UNKNOWN", message: String(e.message) }, { status: 403 });
  }
}
