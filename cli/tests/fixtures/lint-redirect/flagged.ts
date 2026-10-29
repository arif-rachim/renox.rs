// no-unsafe-redirect fixture (#111): every line marked FLAG is one finding.
import type { Ctx } from "renox";

export function GET({ url }: Ctx): Response {
  return Response.redirect(url.searchParams.get("next") ?? "/"); // FLAG
}

export async function POST({ req }: Ctx): Promise<Response> {
  const form = await req.formData();
  const next = String(form.get("next") ?? "/");
  const target = next.trim();
  if (target.length > 100) return Response.redirect(target, 302); // FLAG
  return new Response(null, {
    status: 303,
    headers: { location: target }, // FLAG
  });
}

export function PUT({ params, headers }: Ctx): Response {
  const back = headers.get("referer") ?? "/";
  const res = new Response(null, { status: 302, headers: { "Location": `${params.id}` } }); // FLAG
  res.headers.set("location", back); // FLAG
  return res;
}
