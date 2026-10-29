// A page of the app that needs a user: signed out, a 303 to auth's login with `next`.
import { auth } from "renox:modules";

export async function load(ctx) {
  const user = await auth.currentUser();
  if (user === null) return new Response(null, { status: 303, headers: { location: await auth.loginUrl(ctx.url.pathname + ctx.url.search) } });
  return { auth_user: user };
}
