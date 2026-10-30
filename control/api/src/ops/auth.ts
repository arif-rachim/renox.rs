// The `ops:write` credential of the operator actions (deploy-api.md 0.3
// section 17, #259) and the `ops:read` of the read (0.3.1, #296): the
// bootstrap operator token (its SHA-256 in the
// environment), or a live `renox_op_` token of an account that is still
// flagged `operator`. A tenant token, a session, or a node token is 403
// `RENOX_TOKEN_SCOPE`; anything else is 401.

import type { MiddlewareHandler } from "hono";
import { parseBearer, sameDigest, sha256hex } from "../auth/tokens.ts";
import { ApiError } from "../errors.ts";
import { num } from "../db/db.ts";
import type { Deps, Env } from "../context.ts";

/** Who acted, for the audit row's target and the node's move request: `operator` or the account id. */
const operators = new WeakMap<object, string>();

export function operatorOf(c: { req: { raw: Request } }): string {
  return operators.get(c.req.raw) ?? "operator";
}

/** The move_request `operator` field (control-messages.schema.json): `operator` or `acct_<ulid>`. */
export const accountRef = (operator: string): string => (operator.startsWith("usr_") ? `acct_${operator.slice(4)}` : operator);

/**
 * `ops:write` for the actions; `ops:read` (0.3.1) for the read, which
 * `ops:write` grants. The bootstrap token holds both.
 */
export function opsAuth(deps: Deps, scope: "ops:write" | "ops:read" = "ops:write"): MiddlewareHandler<Env> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const bearer = parseBearer(header);
    if (bearer === null) {
      // A session cookie is a valid credential without the scope.
      if (header === undefined && c.req.header("cookie") !== undefined) throw new ApiError("RENOX_TOKEN_SCOPE", [{ field: "scope", reason: `${scope} needs an operator token` }]);
      throw new ApiError("RENOX_UNAUTHENTICATED");
    }
    if (bearer.kind !== "op") throw new ApiError("RENOX_TOKEN_SCOPE", [{ field: "scope", reason: `${scope} needs an operator token` }]);
    const digest = sha256hex(bearer.value);
    const expected = deps.config.operatorTokenSha256;
    if (expected !== null && sameDigest(digest, expected)) {
      operators.set(c.req.raw, "operator");
    } else {
      const rows = await deps.db.query<{ id: string; user_id: string; scopes: string[]; expires_at: unknown; revoked_at: unknown; operator: boolean }>(
        "select t.id, t.user_id, t.scopes, t.expires_at, t.revoked_at, u.operator from operator_tokens t join users u on u.id = t.user_id where t.token_sha256 = $1",
        [digest],
      );
      const t = rows[0];
      if (t === undefined || t.revoked_at !== null || num(t.expires_at) <= deps.now()) throw new ApiError("RENOX_UNAUTHENTICATED");
      // The flag is checked on every request: an account that lost it loses its tokens.
      if (!t.operator) throw new ApiError("RENOX_TOKEN_SCOPE", [{ field: "operator", reason: "the account is not an operator" }]);
      if (!t.scopes.includes("ops:write") && !(scope === "ops:read" && t.scopes.includes("ops:read"))) throw new ApiError("RENOX_TOKEN_SCOPE", [{ field: "scope", reason: `${scope} is not among the token's scopes` }]);
      await deps.db.query("update operator_tokens set last_used_at = $1 where id = $2", [deps.now(), t.id]);
      operators.set(c.req.raw, t.user_id);
    }
    c.set("principal", { kind: "operator" });
    await next();
  };
}
