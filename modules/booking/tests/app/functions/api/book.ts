// Test only (#799): books and confirms a slot for any customer id, as an app does with its own ids.
// `?customer=&start=`; `?cancel=1` cancels it at once (the old booking of a moved visit).
import { booking } from "renox:modules";

export async function POST(ctx) {
  const q = ctx.url.searchParams;
  const held = await booking.book("cut", "sara", Number(q.get("start")), q.get("customer"));
  await booking.confirm(held.id);
  if (q.get("cancel") === "1") await booking.cancel(held.id);
  return Response.json({ id: held.id });
}
