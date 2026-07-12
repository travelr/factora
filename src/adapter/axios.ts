/**
 * @fileoverview Optional adapter for integrating the Axios library.
 * This module provides a pre-configured fetcher and a detailed error mapper
 * that understands Axios-specific error structures.
 */
import axios, { type AxiosError, isCancel } from 'axios';

import type { ApiError, ErrorMapperContext } from '@/types/error';
import type { ErrorMapper } from '@/types/dependencies';

// --- Local Helpers for Error Classification ---

const isDOMExceptionLike = (err: unknown): err is { name: string } =>
  typeof err === 'object' && err !== null && 'name' in err;

/**
 * Checks if an error indicates a client-side request abortion or cancellation.
 * This is a critical check for preventing state updates on aborted requests.
 */
const isAbortError = (error: unknown): boolean => {
  if (!error) return false;
  // Axios's standard cancellation check.
  if (isCancel(error)) return true;
  // The standard DOMException for AbortController signals.
  if (isDOMExceptionLike(error) && error.name === 'AbortError') return true;
  return false;
};

/**
 * Parses the 'retry-after' header, which can be in seconds or an HTTP-date.
 * @param retryAfterHeader The header value from the Axios response.
 * @returns The delay in milliseconds, or undefined if parsing fails.
 */
const parseRetryAfter = (
  retryAfterHeader: string | number,
  maximumDelayMs: number,
): number | undefined => {
  const asNumber = Number(retryAfterHeader);
  // Handles numeric values (e.g., "5" for 5 seconds).
  if (Number.isFinite(asNumber)) {
    return Math.min(maximumDelayMs, Math.max(0, Math.round(asNumber * 1000)));
  }

  // Handles HTTP-date format (e.g., "Wed, 21 Oct 2015 07:28:00 GMT").
  const parsedDate = Date.parse(String(retryAfterHeader));
  if (!Number.isNaN(parsedDate)) {
    const delta = parsedDate - Date.now();
    return Math.min(maximumDelayMs, Math.max(0, delta));
  }

  return undefined;
};

/**
 * An implementation of the `ErrorMapper` contract that is specifically designed
 * to interpret `AxiosError` objects. It correctly classifies errors as retryable,
 * handles abort signals, and parses `Retry-After` headers for rate limiting.
 *
 * @param error The error thrown by the fetcher (expected to be an AxiosError).
 * @param context Contextual information about the request that failed.
 * @returns A standardized `ApiError` object.
 */
export interface AxiosErrorMapperOptions {
  retryNetworkErrors?: boolean;
  retryableNetworkCodes?: readonly string[];
  maxRetryAfterMs?: number;
}

const DEFAULT_NETWORK_CODES = [
  'ERR_NETWORK',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
] as const;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const createAxiosErrorMapper = (
  options: AxiosErrorMapperOptions = {},
): ErrorMapper => {
  const networkCodes = new Set(
    options.retryableNetworkCodes ?? DEFAULT_NETWORK_CODES,
  );
  const maxRetryAfterMs = Number.isFinite(options.maxRetryAfterMs)
    ? Math.min(
        MAX_TIMER_DELAY_MS,
        Math.max(0, options.maxRetryAfterMs ?? MAX_TIMER_DELAY_MS),
      )
    : MAX_TIMER_DELAY_MS;

  return (error: unknown, context: ErrorMapperContext): ApiError => {
    if (axios.isAxiosError(error)) {
      const { response, code } = error as AxiosError;

      if (isAbortError(error)) {
        return {
          message: `${context.description}: Request aborted`,
          retryable: false,
          isAbort: true,
          errorCode: code || 'ERR_CANCELED',
          originalError: error,
          context,
        };
      }

      const isServerFault = response && response.status >= 500;
      const isRateLimited = response?.status === 429;
      const isTimeout = code === 'ECONNABORTED';
      const isRetryableNetworkError =
        options.retryNetworkErrors === true &&
        !response &&
        networkCodes.has(code ?? '');

      const retryAfterHeader = response?.headers?.['retry-after'];
      const retryAfter =
        retryAfterHeader === undefined || retryAfterHeader === null
          ? undefined
          : parseRetryAfter(retryAfterHeader, maxRetryAfterMs);

      return {
        message: `${context.description}: ${error.message}`,
        status: response?.status,
        retryable:
          Boolean(isServerFault) ||
          isRateLimited ||
          isTimeout ||
          isRetryableNetworkError,
        retryAfter,
        errorCode: code || (response ? `HTTP_${response.status}` : 'UNKNOWN'),
        originalError: error,
        context,
      };
    }

    // Fallback for non-Axios errors.
    const message =
      error instanceof Error ? error.message : 'An unknown error occurred';
    return {
      message: `${context.description}: ${message}`,
      retryable: false,
      originalError: error,
      context,
    };
  };
};

export const axiosErrorMapper: ErrorMapper = createAxiosErrorMapper();
