// The offline reading of the technician pages (#807): what the two cached pages
// (`/me`, `/me/visits/:id`) show about their own copy. The time a page was
// rendered is the time its saved copy is "saved at" (public/sw.js stores the
// answer as it came; public/me.js writes it into the banner when the phone is
// offline). Dubai time, as every other time of the app.
import { clock } from "./booking-sync";
import { day } from "./quotes";

/** "2026-11-14 10:42" for `now` (unix ms; the clock when omitted). */
export function savedAt(now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  return `${day(seconds)} ${clock(seconds)}`;
}
