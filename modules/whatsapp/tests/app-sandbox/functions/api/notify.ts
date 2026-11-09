// Test only: the app notifies a user; the WhatsApp channel goes through the deliver hook.
import { notifications } from "renox:modules";

export async function POST(ctx) {
  const { user, item } = await ctx.req.json();
  return Response.json(await notifications.notify(user, item));
}
