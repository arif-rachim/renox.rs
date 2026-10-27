// Compile-time test: the SDK's public types are identical to the contract
// docs/contracts/ctx.d.ts. Checked by `tsc --noEmit -p sdk` (the `check`
// script); a mismatch is a type error on the line naming the type.

import type * as C from "../../docs/contracts/ctx.d.ts";
import type * as S from "../src/index.ts";

/** Strict identity of two types (not only mutual assignability). */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
/** Assignable in both directions. */
type Mutual<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

// The request context, required by the issue in both directions.
export type CtxAssignable = Expect<Mutual<S.Ctx, C.Ctx>>;
export type CtxIdentical = Expect<Equal<S.Ctx, C.Ctx>>;

export type Checks = [
  Expect<Equal<S.Handler, C.Handler>>,
  Expect<Equal<S.FunctionModule, C.FunctionModule>>,
  Expect<Equal<S.HttpMethod, C.HttpMethod>>,
  Expect<Equal<S.Params, C.Params>>,
  Expect<Equal<S.Db, C.Db>>,
  Expect<Equal<S.DbStatements, C.DbStatements>>,
  Expect<Equal<S.ExecuteResult, C.ExecuteResult>>,
  Expect<Equal<S.Param, C.Param>>,
  Expect<Equal<S.Value, C.Value>>,
  Expect<Equal<S.Row, C.Row>>,
  Expect<Equal<S.Fetch, C.Fetch>>,
  Expect<Equal<S.Secrets, C.Secrets>>,
  Expect<Equal<S.JsonValue, C.JsonValue>>,
  Expect<Equal<S.LogLevel, C.LogLevel>>,
  Expect<Equal<S.LogFields, C.LogFields>>,
  Expect<Equal<S.Log, C.Log>>,
  Expect<Equal<S.Deadline, C.Deadline>>,
  Expect<Equal<S.RenoxErrorCode, C.RenoxErrorCode>>,
  Expect<Equal<S.ResponseErrorCode, C.ResponseErrorCode>>,
  Expect<Equal<S.DbErrorCode, C.DbErrorCode>>,
  Expect<Equal<S.FetchErrorCode, C.FetchErrorCode>>,
  Expect<Equal<S.FetchBlockedReason, C.FetchBlockedReason>>,
  Expect<Equal<S.FetchFailedReason, C.FetchFailedReason>>,
  Expect<Equal<S.ErrorResponseBody, C.ErrorResponseBody>>,
  // Error classes: instance types (the contract declares no constructors).
  Expect<Mutual<S.RenoxError, C.RenoxError>>,
  Expect<Mutual<S.DbPermissionError, C.DbPermissionError>>,
  Expect<Mutual<S.DbBusyError, C.DbBusyError>>,
  Expect<Mutual<S.DbTimeoutError, C.DbTimeoutError>>,
  Expect<Mutual<S.DbQuotaError, C.DbQuotaError>>,
  Expect<Mutual<S.DbConstraintError, C.DbConstraintError>>,
  Expect<Mutual<S.DbSqlError, C.DbSqlError>>,
  Expect<Mutual<S.DbUsageError, C.DbUsageError>>,
  Expect<Mutual<S.FetchBlockedError, C.FetchBlockedError>>,
  Expect<Mutual<S.FetchError, C.FetchError>>,
  Expect<Mutual<S.FetchEgressLimitError, C.FetchEgressLimitError>>,
  Expect<Mutual<S.DeadlineError, C.DeadlineError>>,
];

// Negative controls: the helpers do reject a difference.
// @ts-expect-error a Ctx without `db` is not the contract Ctx
export type MissingField = Expect<Mutual<Omit<S.Ctx, "db">, C.Ctx>>;
// @ts-expect-error a wider code union is not identical
export type WiderCodes = Expect<Equal<S.RenoxErrorCode | "RENOX_EXTRA", C.RenoxErrorCode>>;
