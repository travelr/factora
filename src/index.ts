/**
 * @fileoverview The main, convenient entry point for the Factora library.
 * This file provides a pre-configured factory that uses Axios and Loglevel by default.
 */
import { axiosErrorMapper, createAxiosFetcher } from '@adapter/axios';
import { loglevelAdapter } from '@adapter/loglevel';
import type { UseApiQueryHook } from '@core/api-store-factory';
import { createApiFactoryPure } from '@core/index';
import type { AxiosInstance } from 'axios';

import type { ApiStoreOptions } from '@/types/store';

// Re-export all types from the pure entry point for a consistent and complete API.
export type {
  ApiError,
  ApiStoreOptions,
  ErrorMapper,
  ErrorMapperContext,
  FactoraDependencies,
  FactoraLogger,
  UseApiQueryHook,
} from './pure';

const baseFactory = createApiFactoryPure({
  errorMapper: axiosErrorMapper,
  logger: loglevelAdapter,
});

/**
 * Creates a ready-to-use API store and hook, pre-configured with Axios and Loglevel.
 * @param apiPathKey The base API path for this store (e.g., '/users').
 * @param options Configuration options for caching, retries, etc.
 * @param axiosInstance An optional custom Axios instance to use for requests.
 * @returns A ready-to-use useApiQuery hook.
 */
export const createApiStore = <T>(
  apiPathKey: string,
  options: ApiStoreOptions = {},
  axiosInstance?: AxiosInstance,
): UseApiQueryHook<T> => {
  const fetcher = createAxiosFetcher<T>(axiosInstance);
  return baseFactory<T>(fetcher, apiPathKey, options);
};
