export const ERROR_CODES = ["AUTH_REQUIRED", "AUTH_FORBIDDEN", "INVALID_INPUT", "ACCOUNT_NOT_FOUND", "ACCOUNT_DISABLED", "REFERENCE_INVALID", "REFERENCE_STALE", "MESSAGE_NOT_FOUND", "ATTACHMENT_FORBIDDEN", "ATTACHMENT_CHANGED", "IDEMPOTENCY_CONFLICT", "STATE_CONFLICT", "EXECUTION_IN_PROGRESS", "PROVIDER_UNAVAILABLE", "PROVIDER_REJECTED", "OUTCOME_UNKNOWN", "SENT_UNVERIFIED", "UNSUPPORTED_OPERATION", "CONFIGURATION_MISSING", "CONFIGURATION_INVALID", "DATABASE_UNAVAILABLE", "MIGRATION_REQUIRED", "INTERNAL_SAFE_FAILURE"] as const;
export type ErrorCode = typeof ERROR_CODES[number];
export class SafeError extends Error { constructor(public readonly code: ErrorCode, message: string, public readonly correlationId?: string) { super(message); this.name = "SafeError"; } }
export interface SafeErrorResult { ok: false; error: { code: ErrorCode; message: string; correlationId: string } }
export type SafeResult<T> = { ok: true; value: T } | SafeErrorResult;
