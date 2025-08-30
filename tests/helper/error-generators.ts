/**
 * @fileoverview A factory for creating specific, shaped mock error objects for tests.
 */

/**
 * Creates a mock error that is self-describing as "retryable".
 * This is used by the test helper's internal mock error mapper.
 */
export const createRetryableError = (
  message: string,
  retryAfterMs?: number,
) => {
  const error: any = new Error(message);
  error.retryable = true;
  error.retryAfter = retryAfterMs;
  return error;
};

/**
 * Creates a mock error that is self-describing as "not retryable".
 */
export const createNonRetryableError = (message: string) => {
  const error: any = new Error(message);
  error.retryable = false;
  error.isAbort = false;
  return error;
};
