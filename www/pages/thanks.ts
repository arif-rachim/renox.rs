// GET /thanks: where the waitlist comes back to (#691). Three states, read from
// the query the API sets: `confirmed=1` after the mail's link worked,
// `confirmed=0` when the link was unknown, used or expired, and otherwise the
// plain "check your mail" after the form's POST (`?list=connector`). No script.
import type { LoaderContext } from "@renoxium/sdk";

import { LINKS } from "../lib/contact.ts";

export type ThanksState = "confirmed" | "invalid" | "check_email";

export function stateOf(params: URLSearchParams): ThanksState {
  const c = params.get("confirmed");
  if (c === "1") return "confirmed";
  if (c === "0") return "invalid";
  return "check_email";
}

export function load({ url }: LoaderContext) {
  return { state: stateOf(url.searchParams), links: LINKS };
}
