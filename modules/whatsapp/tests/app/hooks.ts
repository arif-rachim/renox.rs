// Test only: the app's handler of `whatsapp.message_received` reads the text of the
// message the event names with `whatsapp.message(id)` and keeps it (#705).
import { whatsapp } from "renox:modules";

export const on = {
  "whatsapp.message_received": async (ctx, e) => {
    const m = await whatsapp.message(e.payload.message_id);
    if (m === null) return;
    await ctx.db.execute("insert or ignore into app__seen (message_id, body) values (?, ?)", [m.id, m.body]);
  },
};
