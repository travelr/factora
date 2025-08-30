/**
 * @fileoverview This is the internal entry point for the pure, dependency-injected core factory.
 * It exports the core factory function to be used by the public-facing entry points.
 */
import type { FactoraDependencies } from '@/types/dependencies';
import type { ApiStoreOptions } from '@/types/store';

import { createApiStoreCore, type UseApiQueryHook } from './api-store-factory';

type BaseDependencies = Omit<FactoraDependencies<any>, 'fetcher'>;

/**
 * Creates a reusable factory for generating API stores.
 *
 * This higher-order function allows you to configure application-wide dependencies
 * (like a logger and a standard error mapper) once, and then use the returned
 * factory to create individual API stores, each with its own specific data fetcher.
 *
 * @param baseDependencies An object containing the logger and errorMapper implementations.
 * @returns A function that you can use to create specific API store hooks.
 */
export const createApiFactoryPure = (baseDependencies: BaseDependencies) => {
  /**
   * Creates a specific API store instance and its associated React hook.
   * @param fetcher The function that will be used to fetch data for this specific store.
   * @param apiPathKey The base API path for this store instance (e.g., '/users').
   * @param options Configuration options for caching, retries, etc. for this store.
   */
  return <T>(
    apiPathKey: string,
    fetcher: FactoraDependencies<T>['fetcher'],
    options: ApiStoreOptions = {},
  ): UseApiQueryHook<T> => {
    const dependencies: FactoraDependencies<T> = {
      ...baseDependencies,
      fetcher,
    };
    return createApiStoreCore<T>(dependencies, apiPathKey, options);
  };
};
