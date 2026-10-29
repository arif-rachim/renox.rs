// The app's home page: the header's switcher (org's partial in the
// app.header slot) gets its data from org.switcher.
import { org } from "renox:modules";

export async function load(ctx) {
  return { org_switcher: await org.switcher(ctx.url.pathname) };
}
