/* eslint-disable no-unused-vars */
/**
 * @fileoverview The main, convenient entry point for the Factora library.
 * This file provides a pre-configured factory that uses Axios and Loglevel by default.
 */
import { axiosErrorMapper } from '@adapter/axios';
import { loglevelAdapter } from '@adapter/loglevel';
import type { UseApiQueryHook } from '@core/api-store-factory';
import { createApiFactoryPure } from '@core/index';
import { loggerInstance } from './logger';

import type { ApiStoreOptions } from '@/types/store';

// Re-export all functions and types from the pure entry point for a consistent API.
export * from './pure';
export { setLogger, type Logger } from './logger';

const baseFactory = createApiFactoryPure({
  errorMapper: axiosErrorMapper,
  logger: loggerInstance,
});

/**
 * Creates a ready-to-use API store and hook with a custom fetcher.
 *
 * This is the primary entry point for most users, especially those who need
 * custom response handling (like transforming API responses).
 *
 * @param apiPathKey The base API path for this store (e.g., '/users').
 * @param fetcher The function that will be used to fetch data for this store.
 * @param options Configuration options for caching, retries, etc.
 * @returns A ready-to-use useApiQuery hook.
 *
 * @example
 * // With custom response handling (your futroFetcher case)
 * export const usePostsStore = createApiStore('/posts',
 *   (endpoint, params, signal) => {
 *     const response = await axios.get<ServiceResponse<T>>(url, ... });
 *     if (!response.data.success) throw new Error(response.data.message);
 *     return response.data.responseObject;
 *   },
 *   { cacheTTL: 300000 }
 * );
 */
export const createApiStore = <T>(
  apiPathKey: string,
  fetcher: (
    endpoint: string,
    params: Record<string, any>,
    signal?: AbortSignal,
  ) => Promise<T>,
  options: ApiStoreOptions = {},
): UseApiQueryHook<T> => {
  return baseFactory<T>(apiPathKey, fetcher, options);
};
