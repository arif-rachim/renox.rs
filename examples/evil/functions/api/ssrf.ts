// GET /api/ssrf?target=<key>[&uncaught=1]: outbound requests that the fetch
// policy must reject (ops.md section 2; docs/24-threat-model.md SSRF rows).
//
// By default the handler catches the error and reports it: 200, meter status
// ok with fetch_blocked = 1. With uncaught=1 the error propagates:
// 500 RENOX_INTERNAL, meter status blocked_fetch.
// If a request is NOT blocked the handler answers 500 with blocked: false, so
// a policy hole can never look like a pass.
import { type Handler, isRenoxError } from "renox";

const TARGETS = {
  metadata: "http://169.254.169.254/latest/meta-data/",
  localhost: "http://localhost/",
  private: "http://10.0.0.1/",
  redirect: "https://evil.redirect.test/api/redirect",
  notlisted: "https://example.org/",
} as const;

type TargetKey = keyof typeof TARGETS;

function isTarget(key: string): key is TargetKey {
  return Object.hasOwn(TARGETS, key);
}

export const GET: Handler = async ({ url, fetch }) => {
  const key = url.searchParams.get("target") ?? "";
  if (!isTarget(key)) {
    return Response.json({ error: `target must be one of ${Object.keys(TARGETS).join(", ")}` }, { status: 400 });
  }
  const uncaught = url.searchParams.get("uncaught") === "1";
  try {
    const res = await fetch(TARGETS[key]);
    await res.body?.cancel();
    return Response.json({ target: key, blocked: false, status: res.status }, { status: 500 });
  } catch (e) {
    if (uncaught) throw e;
    if (isRenoxError(e)) {
      const details = e.details ?? {};
      return Response.json({
        target: key,
        blocked: e.code === "RENOX_FETCH_BLOCKED",
        code: e.code,
        reason: details["reason"] ?? null,
      });
    }
    return Response.json({ target: key, blocked: false, error: String(e) }, { status: 500 });
  }
};
