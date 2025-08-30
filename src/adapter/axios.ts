/* eslint-disable no-unused-vars */ // Keep this as 'isCancel' is used internally but might not be exported for external use from here.
// src/utils/api-error-handler.ts
import axios, { AxiosError, isCancel } from 'axios';

import { ApiError, ErrorMapperContext } from '@/types/error';

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
 * @param {ErrorMapperContext} context - Context information for error processing.
 * @returns {ApiError|null} Standardized error object with classification or null if not handled.
 */
type ErrorHandler = (
  error: AxiosError,
  context: ErrorMapperContext,
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

      const asNumber = Number(headerStr);
      if (!Number.isNaN(asNumber)) {
        retryAfter = Math.round(asNumber * 1000);
      } else {
        const parsed = Date.parse(headerStr);
        if (!Number.isNaN(parsed)) {
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
    return null;
  },
];

/**
 * Standardizes API error handling by processing different types of errors
 * and returning a consistent error format (`ApiError`) with classification.
 */
export const handleApiError = (
  error: unknown,
  context: {
    endpoint: string;
    params?: Record<string, any>;
    description?: string;
    attempt?: number;
  },
): ApiError => {
  const {
    endpoint,
    params,
    description = 'API Request', // Default description if not provided
    attempt = 1,
  } = context;

  // Create the full context object used internally and in the final ApiError
  const fullContext: ErrorMapperContext = {
    endpoint,
    params,
    description,
    attempt,
  };

  // Explicitly check if the error is an AxiosError to pass to specific handlers
  if (axios.isAxiosError(error)) {
    for (const handler of errorHandlers) {
      const result = handler(error, fullContext);
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
