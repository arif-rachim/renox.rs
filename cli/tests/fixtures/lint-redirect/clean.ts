// no-unsafe-redirect fixture (#111): nothing here is flagged.
import { type Ctx, redirect, safeRedirectTarget } from "renox";

export function GET({ url }: Ctx): Response {
  return redirect.safe(url.searchParams.get("next") ?? "/", { allow: ["https://accounts.example.com"] });
}

export async function POST({ req }: Ctx): Promise<Response> {
  const form = await req.formData();
  const next = safeRedirectTarget(String(form.get("next") ?? "/")) ?? "/";
  const res = new Response(null, { status: 303, headers: { location: next } });
  res.headers.set("location", next);
  return res;
}

export function PUT(): Response {
  const home = "/";
  const item = (params: { id: string }): Response => new Response(null, { headers: { location: `/items/${params.id}` } });
  void item;
  // Response.redirect(url.searchParams.get("next"))
  const s = 'Response.redirect(form.get("x"))';
  return s ? Response.redirect(new URL(home, "https://shop.example").href) : new Response(null, { headers: { location: "/done" } });
}
