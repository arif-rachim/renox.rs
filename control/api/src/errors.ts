// The control API's error responses (docs/contracts/deploy-api.md sections 1
// and 12). Messages are the fixed texts of docs/contracts/errors.md; a test
// checks that both agree.

export const MESSAGES = {
  RENOX_VALIDATION: "The request is not valid.",
  RENOX_UNAUTHENTICATED: "Authentication is required.",
  RENOX_TOKEN_SCOPE: "The token does not allow this action.",
  RENOX_NOT_FOUND: "Not found.",
  RENOX_CONFLICT: "The request conflicts with the current state.",
  RENOX_BODY_TOO_LARGE: "The request body is too large.",
  RENOX_DEPLOY_REJECTED: "The artifact failed validation.",
  RENOX_ACTIVATION_FAILED: "The deployment could not be activated.",
  RENOX_RATE_LIMITED: "Too many requests. Try again later.",
  RENOX_INTERNAL: "Internal error. Quote the request id when reporting it.",
  RENOX_UNAVAILABLE: "The service is temporarily unavailable.",
  // deploy-api.md 0.3 (#251).
  RENOX_BACKUP_UNAVAILABLE: "No backup is available for this database right now.",
  RENOX_RESTORE_POINT_UNKNOWN: "No backup covers the requested time.",
  RENOX_IMPORT_REJECTED: "The database file cannot be imported.",
  RENOX_TENANT_MOVING: "The service is being moved. Try again shortly.",
} as const;

export type ErrorCode = keyof typeof MESSAGES;

export const STATUS: Record<ErrorCode, number> = {
  RENOX_VALIDATION: 400,
  RENOX_UNAUTHENTICATED: 401,
  RENOX_TOKEN_SCOPE: 403,
  RENOX_NOT_FOUND: 404,
  RENOX_CONFLICT: 409,
  RENOX_BODY_TOO_LARGE: 413,
  RENOX_DEPLOY_REJECTED: 422,
  RENOX_ACTIVATION_FAILED: 422,
  RENOX_RATE_LIMITED: 429,
  RENOX_INTERNAL: 500,
  RENOX_UNAVAILABLE: 503,
  RENOX_BACKUP_UNAVAILABLE: 503,
  RENOX_RESTORE_POINT_UNKNOWN: 422,
  RENOX_IMPORT_REJECTED: 422,
  RENOX_TENANT_MOVING: 503,
};

export type Detail = Record<string, string | number>;

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    readonly details?: Detail[],
    readonly extra: { deployment?: string; status?: number; retryAfter?: number } = {},
  ) {
    super(code);
    this.status = extra.status ?? STATUS[code];
  }
}

export const notFound = (): ApiError => new ApiError("RENOX_NOT_FOUND");
export const conflict = (field: string, reason: string): ApiError => new ApiError("RENOX_CONFLICT", [{ field, reason }]);
export const invalid = (field: string, reason: string): ApiError => new ApiError("RENOX_VALIDATION", [{ field, reason }]);

/** The JSON body of an error response. */
export function errorBody(code: ErrorCode, requestId: string, details?: Detail[], deployment?: string): unknown {
  return {
    error: {
      code,
      message: MESSAGES[code],
      request_id: requestId,
      ...(deployment === undefined ? {} : { deployment }),
      ...(details === undefined || details.length === 0 ? {} : { details: details.slice(0, 50) }),
    },
  };
}
