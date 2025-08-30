/**
 * @fileoverview Type definitions related to error handling.
 */

/**
 * Context provided to the error mapping function.
 */
export interface ErrorMapperContext {
  endpoint: string;
  params?: Record<string, any>;
  description: string;
  attempt?: number;
}

/**
 * Represents a standardized API error response.
 * Provides classification and context for easier handling and logging.
 */
export interface ApiError {
  message: string;
  retryable?: boolean;
  status?: number;
  retryAfter?: number;
  isAbort?: boolean;
  errorCode?: string;
  originalError?: unknown;
  context?: ErrorMapperContext;
}
