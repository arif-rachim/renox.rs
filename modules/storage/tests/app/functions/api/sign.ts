// Test only: signs an upload into the signed-in user's folder through the service (an app's own action would check who may upload what).
import { auth, storage } from "renox:modules";

export async function POST(ctx) {
  const user = await auth.requireUser();
  const q = ctx.url.searchParams;
  try {
    const signed = await storage.uploadUrl(user.id.toLowerCase(), q.get("name") ?? "big.txt", { contentType: q.get("type") ?? "text/plain", maxBytes: Number(q.get("max") ?? 1024 * 1024) });
    return Response.json(signed);
  } catch (e) {
    return Response.json({ message: (e as Error).message, code: (e as { code?: string }).code ?? null }, { status: 422 });
  }
}
