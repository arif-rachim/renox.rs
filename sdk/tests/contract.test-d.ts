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
// The page contexts (#44: "types match the contract (assignability test)").
export type LoaderContextAssignable = Expect<Mutual<S.LoaderContext, C.LoaderContext>>;
export type ActionContextAssignable = Expect<Mutual<S.ActionContext, C.ActionContext>>;
export type ActionResultAssignable = Expect<Mutual<S.ActionResult, C.ActionResult>>;

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
  Expect<Equal<S.ModuleErrorCode, C.ModuleErrorCode>>,
  Expect<Equal<S.EventPayloadReason, C.EventPayloadReason>>,
  Expect<Equal<S.FetchBlockedReason, C.FetchBlockedReason>>,
  Expect<Equal<S.FetchFailedReason, C.FetchFailedReason>>,
  Expect<Equal<S.ErrorResponseBody, C.ErrorResponseBody>>,
  // Pages (ops.md section 14).
  Expect<Equal<S.Session, C.Session>>,
  Expect<Equal<S.LoaderContext, C.LoaderContext>>,
  Expect<Equal<S.ActionContext, C.ActionContext>>,
  Expect<Equal<S.PageData, C.PageData>>,
  Expect<Equal<S.Loader, C.Loader>>,
  Expect<Equal<S.ActionResult, C.ActionResult>>,
  Expect<Equal<S.Action, C.Action>>,
  Expect<Equal<S.PageModule, C.PageModule>>,
  Expect<Equal<S.TextDirection, C.TextDirection>>,
  // Modules (ops.md sections 15 and 16, 1.3.0).
  Expect<Equal<S.ConfigValue, C.ConfigValue>>,
  Expect<Equal<S.ModuleConfig, C.ModuleConfig>>,
  Expect<Equal<S.ServiceFunction, C.ServiceFunction>>,
  Expect<Equal<S.ModuleServices, C.ModuleServices>>,
  Expect<Equal<S.Services, C.Services>>,
  Expect<Equal<S.EmitOptions, C.EmitOptions>>,
  Expect<Equal<S.Events, C.Events>>,
  Expect<Equal<S.HookRunResult, C.HookRunResult>>,
  Expect<Equal<S.Hooks, C.Hooks>>,
  Expect<Equal<S.Password, C.Password>>,
  Expect<Equal<S.ServiceImplementation, C.ServiceImplementation>>,
  Expect<Equal<S.ServicesModule, C.ServicesModule>>,
  Expect<Equal<S.HookFillerResult, C.HookFillerResult>>,
  Expect<Equal<S.HookFiller, C.HookFiller>>,
  Expect<Equal<S.EventInfo, C.EventInfo>>,
  Expect<Equal<S.DeliveredEvent, C.DeliveredEvent>>,
  Expect<Equal<S.EventContext, C.EventContext>>,
  Expect<Equal<S.EventHandler, C.EventHandler>>,
  Expect<Equal<S.HooksModule, C.HooksModule>>,
  // Authorization, realtime, tools, jobs (ops.md sections 17-20, 1.5.0).
  Expect<Equal<S.Principal, C.Principal>>,
  Expect<Equal<S.PrincipalRole, C.PrincipalRole>>,
  Expect<Equal<S.Scope, C.Scope>>,
  Expect<Equal<S.ResourceRef, C.ResourceRef>>,
  Expect<Equal<S.AuthzContext, C.AuthzContext>>,
  Expect<Equal<S.Decision, C.Decision>>,
  Expect<Equal<S.Explanation, C.Explanation>>,
  Expect<Equal<S.RoleScope, C.RoleScope>>,
  Expect<Equal<S.RoleAssignment, C.RoleAssignment>>,
  Expect<Equal<S.AuthzRoles, C.AuthzRoles>>,
  Expect<Equal<S.Authz, C.Authz>>,
  Expect<Equal<S.Guard, C.Guard>>,
  Expect<Equal<S.Conn, C.Conn>>,
  Expect<Equal<S.RealtimePayload, C.RealtimePayload>>,
  Expect<Equal<S.Realtime, C.Realtime>>,
  Expect<Equal<S.RealtimeContext, C.RealtimeContext>>,
  Expect<Equal<S.MessageContext, C.MessageContext>>,
  Expect<Equal<S.CloseContext, C.CloseContext>>,
  Expect<Equal<S.WsModule, C.WsModule>>,
  Expect<Equal<S.SseModule, C.SseModule>>,
  Expect<Equal<S.ToolContext, C.ToolContext>>,
  Expect<Equal<S.ToolInputSchema<{ a: string }>, C.ToolInputSchema<{ a: string }>>>,
  Expect<Equal<S.ToolDefinition<{ a: string }>, C.ToolDefinition<{ a: string }>>>,
  Expect<Equal<S.Tool, C.Tool>>,
  Expect<Equal<S.EnqueueOptions, C.EnqueueOptions>>,
  Expect<Equal<S.Jobs, C.Jobs>>,
  Expect<Equal<S.JobInfo, C.JobInfo>>,
  Expect<Equal<S.JobContext, C.JobContext>>,
  Expect<Equal<S.JobModule, C.JobModule>>,
  Expect<Equal<S.AuthzErrorCode, C.AuthzErrorCode>>,
  Expect<Equal<S.RealtimeErrorCode, C.RealtimeErrorCode>>,
  Expect<Equal<S.ToolErrorCode, C.ToolErrorCode>>,
  Expect<Equal<S.JobErrorCode, C.JobErrorCode>>,
  Expect<Equal<S.JobState, C.JobState>>,
  Expect<Equal<S.JobOp, C.JobOp>>,
  Expect<Mutual<S.JobRow, C.JobRow>>,
  Expect<Mutual<S.JobPage, C.JobPage>>,
  Expect<Mutual<S.Jobs, C.Jobs>>,
  Expect<Equal<S.ForbiddenReason, C.ForbiddenReason>>,
  Expect<Equal<S.DbScopeReason, C.DbScopeReason>>,
  Expect<Equal<S.RealtimeLimitReason, C.RealtimeLimitReason>>,
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
  Expect<Mutual<S.ModuleUndeclaredError, C.ModuleUndeclaredError>>,
  Expect<Mutual<S.ModuleServiceError, C.ModuleServiceError>>,
  Expect<Mutual<S.EventPayloadError, C.EventPayloadError>>,
  Expect<Mutual<S.DbScopeError, C.DbScopeError>>,
  Expect<Mutual<S.ForbiddenError, C.ForbiddenError>>,
  Expect<Mutual<S.JobNotFoundError, C.JobNotFoundError>>,
  Expect<Mutual<S.JobStateError, C.JobStateError>>,
  Expect<Mutual<S.RealtimeLimitError, C.RealtimeLimitError>>,
  Expect<Mutual<S.RealtimeBackpressureError, C.RealtimeBackpressureError>>,
];

// Negative controls: the helpers do reject a difference.
// @ts-expect-error a Ctx without `db` is not the contract Ctx
export type MissingField = Expect<Mutual<Omit<S.Ctx, "db">, C.Ctx>>;
// @ts-expect-error an ActionContext without `form` is not the contract's
export type ActionNoForm = Expect<Mutual<Omit<S.ActionContext, "form">, C.ActionContext>>;
// @ts-expect-error a wider code union is not identical
export type WiderCodes = Expect<Equal<S.RenoxErrorCode | "RENOX_EXTRA", C.RenoxErrorCode>>;
