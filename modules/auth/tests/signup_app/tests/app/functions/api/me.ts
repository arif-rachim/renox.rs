// requireUser from an API route: 401 when signed out.
import { auth } from "renox:modules";

export async function GET() {
  try {
    return Response.json(await auth.requireUser());
  } catch (e) {
    return Response.json({ error: e?.details?.cause_code ?? e?.code }, { status: 401 });
  }
}
