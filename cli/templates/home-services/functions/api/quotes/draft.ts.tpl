// POST /api/quotes/draft {"request": "two AC services and a deep clean"}
//   -> 200 {"lines": [{"code", "service_id", "qty"}], "ai": "on"}
// The lines name catalogue services only (the model's answer is parsed and
// checked against the catalogue). Without an AI provider: {"lines": [], "ai": "off"}.
// `quote.write`; the catalogue is the active branch's.
import { ValidationError, validate, type Handler } from "@renoxium/sdk";

import { draftLines } from "../../../lib/draft";
import { draftRequestSchema } from "../../../lib/forms";
import { catalogueOf } from "../../../lib/quotes";
import { branchOf } from "../../../lib/scope";

export const guard = { action: "quote.write" };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export const POST: Handler = async (ctx) => {
  const branch = await branchOf(ctx);
  if (branch === null) return json({ error: { code: "no_branch", message: "No branch is active for this account." } }, 403);
  let body: unknown;
  try {
    body = await ctx.req.json();
  } catch {
    return json({ error: { code: "bad_request", message: "The body must be JSON." } }, 400);
  }
  let request: string;
  try {
    request = (await validate(body, draftRequestSchema)).request;
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    return json({ error: { code: "bad_request", message: "request: 1 to 2000 characters of text." } }, 400);
  }
  return json(await draftLines(ctx.ai, await catalogueOf(ctx.db, branch.id), request));
};
