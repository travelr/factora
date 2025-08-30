/* eslint-disable no-unused-vars */ // Keep this as 'isCancel' is used internally but might not be exported for external use from here.
// src/utils/api-error-handler.ts
import axios, { AxiosError, isCancel } from 'axios';

/**
 * Represents a standardized API error response.
 * Provides classification and context for easier handling and logging.
 * @typedef {Object} ApiError
 * @property {string} message - Human-readable error message.
 * @property {boolean} [retryable] - Indicates if the operation is potentially transient and can be retried.
 * @property {number} [status] - HTTP status code (if available).
 * @property {number} [retryAfter] - Time in milliseconds to wait before retrying (typically for rate limits).
 * @property {boolean} [isAbort] - Indicates if the error was due to the request being aborted/cancelled by the client.
 * @property {string} [errorCode] - A machine-readable code for the error type (e.g., 'ECONNABORTED', 'ERR_NETWORK', 'HTTP_404').
 * @property {unknown} [originalError] - The original underlying error object (e.g., AxiosError, DOMException).
 * @property {Object} [context] - Context information about the failed operation.
 * @property {string} context.endpoint - The API endpoint that was called.
 * @property {Record<string, any>} [context.params] - The request parameters (caution: may contain sensitive data).
 * @property {string} context.description - A human-readable description of the operation (e.g., 'Fetch user data').
 * @property {number} [context.attempt] - The attempt number for the operation (useful for retries).
 */
export interface ApiError {
  message: string;
  retryable?: boolean;
  status?: number;
  retryAfter?: number;
  isAbort?: boolean;
  errorCode?: string;
  originalError?: unknown;
  context?: {
    // Context object itself is optional
    endpoint: string;
    params?: Record<string, any>;
    description: string; // Make description required within context as it's always provided or defaulted
    attempt?: number;
  };
}

// Define shapes for errors we might check against without being full types
interface DOMExceptionLike {
  name: string;
}
interface CustomAbortErrorLike {
  isAbortError: boolean;
}
interface MessageErrorLike {
  message: string;
}

// Type guards for safer property access on unknown error types
const isDOMExceptionLike = (err: unknown): err is DOMExceptionLike =>
  typeof err === 'object' &&
  err !== null &&
  'name' in err &&
  typeof (err as any).name === 'string';

const isCustomAbortErrorLike = (err: unknown): err is CustomAbortErrorLike =>
  typeof err === 'object' &&
  err !== null &&
  'isAbortError' in err &&
  (err as any).isAbortError === true; // Use any for flag check as it's custom

const isMessageErrorLike = (err: unknown): err is MessageErrorLike =>
  typeof err === 'object' &&
  err !== null &&
  'message' in err &&
  typeof (err as any).message === 'string'; // Use any for message check on unknown

/**
 * Checks if an error indicates a client-side request abortion or cancellation.
 * Handles Axios cancellation, DOMException AbortError (from Fetch API/AbortController),
 * custom flags, and common message patterns.
 * @param {unknown} error - The error object to check.
 * @returns {boolean} True if the error appears to be an abort/cancel error.
 */
const isAbortError = (error: unknown): boolean => {
  if (!error) return false;

  // Axios cancellation helper
  if (isCancel(error)) {
    return true;
  }
  // DOMException AbortError (Fetch API, AbortController)
  if (isDOMExceptionLike(error) && error.name === 'AbortError') {
    return true;
  }
  // Custom flag we might set in custom fetch wrappers
  if (isCustomAbortErrorLike(error)) {
    return true;
  }
  // Fallback check message for common patterns (less reliable, but for edge cases)
  if (
    isMessageErrorLike(error) &&
    (error.message === 'Request aborted' ||
      error.message === 'Request cancelled')
  ) {
    return true;
  }
  return false;
};

/**
 * Type definition for error handler functions.
 * Handlers receive an AxiosError and context, and return a standardized ApiError
 * or null if they cannot handle the specific error type.
 * @callback ErrorHandler
 * @param {AxiosError} error - The Axios error to handle.
 * @param {object} context - Context information for error processing.
 * @param {string} context.endpoint - API endpoint that failed.
 * @param {Record<string, any>} [context.params] - Request parameters.
 * @param {number} [context.attempt] - Current attempt number.
 * @param {string} context.description - Description of the API operation (guaranteed to be a string by handleApiError).
 * @returns {ApiError|null} Standardized error object with classification or null if not handled.
 */
type ErrorHandler = (
  error: AxiosError,
  context: {
    endpoint: string;
    params?: Record<string, any>;
    attempt?: number;
    description: string; // Explicitly required here as handleApiError guarantees it
  },
) => ApiError | null;

/**
 * Array of error handlers that process different types of Axios errors in order.
 * The first handler that returns a non-null ApiError is used.
 * @type {ErrorHandler[]}
 */
const errorHandlers: ErrorHandler[] = [
  // Handle Aborted/Cancelled requests using the helper
  (error, context) => {
    if (!isAbortError(error)) return null;

    return {
      message: `${context.description}: Request aborted`,
      retryable: false,
      isAbort: true,
      errorCode: error.code || 'ABORTED', // AxiosError has 'code' property
      originalError: error,
      context: context,
    };
  },
  // Handles request timeout errors (ECONNABORTED, ETIMEDOUT)
  (error, context) => {
    if (error.code !== 'ECONNABORTED' && error.code !== 'ETIMEDOUT')
      return null;
    return {
      message: `${context.description}: Request timed out`,
      retryable: true,
      errorCode: error.code,
      originalError: error,
      context: context,
    };
  },
  // Handles rate limiting errors (HTTP 429)
  (error, context) => {
    if (error.response?.status !== 429) return null;
    const retryAfterHeader = error.response.headers?.['retry-after'];
    let retryAfter: number | undefined = undefined;

    if (retryAfterHeader != null) {
      const headerStr = String(retryAfterHeader).trim();

      // 1) Numeric value in seconds (may be fractional like "0.5").
      //    Use Number() so "0.5" becomes 0.5 and we multiply by 1000 -> 500ms.
      const asNumber = Number(headerStr);
      if (!Number.isNaN(asNumber)) {
        retryAfter = Math.round(asNumber * 1000);
      } else {
        // 2) HTTP-date value. Parse it and compute milliseconds until that date.
        const parsed = Date.parse(headerStr);
        if (!Number.isNaN(parsed)) {
          // parsed is epoch ms; compute delta (never return negative).
          const delta = parsed - Date.now();
          retryAfter = delta > 0 ? delta : 0;
        }
      }
    }

    return {
      message: `${context.description}: Rate limit exceeded`,
      retryable: true,
      retryAfter,
      status: 429,
      errorCode: 'HTTP_429',
      originalError: error,
      context: context,
    };
  },
  // Handles HTTP error responses (4xx and 5xx status codes)
  (error, context) => {
    if (!error.response) return null; // This handler is specifically for errors *with* a response
    const status = error.response.status;
    return {
      message: `${context.description}: HTTP ${status} - ${error.response.statusText || error.message}`,
      retryable: status >= 500 && status < 600, // Retry server errors (5xx range)
      status,
      errorCode: `HTTP_${status}`,
      originalError: error,
      context: context,
    };
  },
  // Handles request setup/configuration errors or other Axios errors not matched above
  (error, context) => {
    // This is a fallback handler for any remaining AxiosErrors
    if (axios.isAxiosError(error)) {
      return {
        message: `${context.description}: Request failed (${error.message})`,
        retryable: false, // Default to non-retryable for uncategorized Axios errors
        status: error.response?.status,
        errorCode: error.code || 'AXIOS_ERROR',
        originalError: error,
        context: context,
      };
    }
    return null; // Should not happen if called within the axios.isAxiosError block in handleApiError, but defensive.
  },
];

/**
 * Standardizes API error handling by processing different types of errors
 * and returning a consistent error format (`ApiError`) with classification.
 * This function does NOT perform logging itself. It provides the structured
 * ApiError object which the caller can use for logging, display, and retries.
 * @param {unknown} error - The error to handle (can be AxiosError, Error, or other).
 * @param {object} context - Context information for error handling.
 * @param {string} context.endpoint - API endpoint that failed.
 * @param {Record<string, any>} [context.params] - Request parameters (caution: sensitive data).
 * @param {string} [context.description] - Description of the API operation (e.g., 'Fetch users'). Defaults to 'API Request'.
 * @param {number} [context.attempt] - Current attempt number. Defaults to 1.
 * @returns {ApiError} A standardized error object.
 * @example
 * try {
 *   await apiCall();
 * } catch (error) {
 *   const apiError = handleApiError(error, {
 *     endpoint: '/users',
 *     description: 'Fetch users'
 *   });
 *   // Now use apiError for logging or conditional logic in the caller
 *   if (apiError.isAbort) { log.info('Request aborted', apiError.context); }
 *   else if (apiError.retryable) { log.warn('Transient error', apiError); }
 *   else { log.error('Fatal error', apiError); }
 * }
 */
export const handleApiError = (
  error: unknown,
  context: {
    endpoint: string;
    params?: Record<string, any>;
    description?: string; // Input description is optional, will be defaulted
    attempt?: number;
  },
): ApiError => {
  const {
    endpoint,
    params,
    description = 'API Request', // Default description if not provided
    attempt = 1, // Default attempt to 1
  } = context;

  // Create the full context object used internally and in the final ApiError
  const fullContext = { endpoint, params, description, attempt };

  // Explicitly check if the error is an AxiosError to pass to specific handlers
  if (axios.isAxiosError(error)) {
    for (const handler of errorHandlers) {
      const result = handler(error, fullContext); // Pass the full context to handlers
      if (result) {
        // If a handler matched, return its result, ensuring context and original error are present
        return {
          ...result,
          // Ensure originalError and context are always included even if handler didn't explicitly add them (though they should)
          originalError: result.originalError ?? error,
          context: result.context ?? fullContext,
        };
      }
    }

    // Fallback for Axios errors not specifically handled by any of the defined handlers
    return {
      message: `${description}: An unclassified Axios error occurred (${error.message})`,
      retryable: false, // Default to non-retryable for uncategorized
      errorCode: error.code || 'UNCLASSIFIED_AXIOS',
      status: error.response?.status,
      originalError: error,
      context: fullContext,
    };
  }

  // Handle generic errors that are not AxiosErrors (e.g., plain Errors, or other exceptions)
  const message = error instanceof Error ? error.message : String(error);
  let retryable: boolean | undefined = undefined;
  let retryAfter: number | undefined = undefined;

  if (error && typeof error === 'object') {
    // Explicitly check and convert retryable
    if ('retryable' in error) {
      const rawRetryable = (error as any).retryable;
      retryable =
        rawRetryable === true || rawRetryable === 'true' || rawRetryable === 1;
    }

    // Explicitly check and convert retryAfter
    if ('retryAfter' in error) {
      const rawRetryAfter = (error as any).retryAfter;
      if (typeof rawRetryAfter === 'number') {
        retryAfter = rawRetryAfter;
      } else if (typeof rawRetryAfter === 'string') {
        const parsed = parseInt(rawRetryAfter, 10);
        if (!isNaN(parsed)) {
          retryAfter = parsed;
        }
      }
    }
  }

  return {
    message: `${description}: An unexpected non-Axios error occurred: ${message}`,
    retryable,
    retryAfter,
    errorCode: 'UNEXPECTED_ERROR',
    originalError: error,
    context: fullContext,
  };
};
