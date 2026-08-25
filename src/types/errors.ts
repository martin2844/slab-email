export const ERROR_CODES = {
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  SEND_DISABLED: 'SEND_DISABLED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  SEND_OUTCOME_UNKNOWN: 'SEND_OUTCOME_UNKNOWN',
  SENDER_IDENTITY_MISMATCH: 'SENDER_IDENTITY_MISMATCH',
  REPLY_PLAN_MISMATCH: 'REPLY_PLAN_MISMATCH',
  ACCOUNT_IN_USE: 'ACCOUNT_IN_USE',
  INVALID_CONFIGURATION: 'INVALID_CONFIGURATION',
  INVALID_INPUT: 'INVALID_INPUT',
  STATE_EXPIRED: 'STATE_EXPIRED',
  STATE_INVALID: 'STATE_INVALID',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMITED: 'RATE_LIMITED'
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.name = 'ApiError';
  }
}

export const ApiErrorPayload = (err: ApiError): ErrorPayload => ({
  code: err.code,
  message: err.message,
  details: err.details
});
