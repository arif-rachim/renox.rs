// POST /api/setup: the company's first data, once, from the platform (#711;
// deploy-api.md section 21). The body is the `setup` of
// `createAppFromTemplate` plus `owner: { email }`; a header carries the
// one-time token, the route's only gate (no guard: the app's own sign-in
// cannot know the caller).
//
// The header is `renox-setup` (section 21, 0.11.1): the gateway and the cell
// remove every `x-renox-*` header a client sends (ops.md section 2).
//
//   200 { invited: [{ email, role }], skipped: [{ email, reason }] }
//   401 a missing, forged or expired token, or one for another app
//   409 the app already holds its setup or a user: the call changes nothing
//   422 { errors: { "<field path>": reason } }: the body breaks the limits of section 21
//   405 any other method (the runtime: only POST is exported)
//
// The demo seed is never loaded. Neither the token nor the key is logged.
import type { Handler } from "@renoxium/sdk";

import { parseSetup, writeSetup } from "../../lib/setup";
import { appNameOf, verifySetupToken } from "../../lib/setup-token";

const MAX_BODY = 65_536;

const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const error = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);

export const POST: Handler = async (ctx) => {
  const header = ctx.headers.get("renox-setup") ?? "";
  const token = await verifySetupToken(ctx.secrets.SETUP_KEY ?? "", header, appNameOf(ctx.url), Date.now());
  if (!token.ok) return error(401, "setup_token", "The setup token is missing, invalid or expired.");
  const raw = await ctx.req.text();
  if (raw.length > MAX_BODY) return json({ errors: { body: `at most ${MAX_BODY} bytes` } }, 422);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ errors: { body: "must be a JSON object" } }, 422);
  }
  const parsed = parseSetup(body);
  if ("errors" in parsed) return json({ errors: parsed.errors }, 422);
  const answer = await writeSetup(ctx, parsed.value, token.hash);
  if (answer === "taken") return error(409, "already_set_up", "This app is already set up.");
  ctx.log.info("setup written", { branches: parsed.value.branches.length, services: parsed.value.services.length, invited: answer.invited.length });
  return json(answer, 200);
};
