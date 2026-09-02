/**
 * The envelope every HTTP response carries, success or failure — named by
 * `backend/README.md`'s M-01 feature list ("shared/errors/ — error classes
 * and the global exception filter") and wired up by `response.interceptor.ts`
 * (success) and `http-exception.filter.ts` (failure). A client can switch on
 * `success` alone to know which shape it got.
 */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

/**
 * `[key: string]: unknown` deliberately keeps this open — some errors carry
 * extra fields a client needs beyond code/message, e.g.
 * `IDENTITY_ERROR_CODES.OTP_RATE_LIMITED`'s `retryAfterSeconds`, or
 * `VALIDATION_FAILED`'s `details` (see `http-exception.filter.ts`).
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorBody;
}
