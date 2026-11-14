// Where a step-up sends the person (#769). twofa's STEP_UP_REQUIRED crosses to
// the app with `cause_details.verify_url` (ops.md 15.2, "Errors"); the app
// follows it only when it is a path on this site, never another origin.

/** The module's `verify_url` when it is a path on this site (one leading `/`), otherwise twofa's verification page. */
export function stepUpUrl(verifyUrl: unknown, next: string): string {
  if (typeof verifyUrl === "string" && /^\/(?![/\\])\S*$/u.test(verifyUrl)) return verifyUrl;
  return `/2fa/verify?next=${encodeURIComponent(next)}`;
}
