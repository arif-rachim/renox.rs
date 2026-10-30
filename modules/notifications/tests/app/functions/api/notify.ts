// Test only: the app notifies a user (an app calls notify like any module).
import { notifications } from "renox:modules";

export async function POST(ctx) {
  const { user, item } = await ctx.req.json();
  return Response.json(await notifications.notify(user, item));
}
