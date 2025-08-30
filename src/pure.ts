/**
 * @fileoverview The PURE public entry point for the Factora library.
 * Use this if you want to provide your own dependencies instead of the defaults.
 */
export {
  startApiStoreGarbageCollector,
  stopApiStoreGarbageCollector,
} from '@core/api-store-gc';
export {
  clearAllApiStores,
  initializeApiRegistry,
  refetchAllStaleQueries,
} from '@core/api-store-registry';
export { createApiFactoryPure } from '@core/index';

// Export all public types
export type {
  ErrorMapper,
  FactoraDependencies,
  FactoraLogger,
} from '@/types/dependencies';
export type { ApiError, ErrorMapperContext } from '@/types/error';
export type { ApiStoreOptions } from '@/types/store';
export type { UseApiQueryHook } from '@core/api-store-factory';
export type { GcOptions } from '@core/api-store-gc';
export type { StoreActions } from '@core/api-store-registry';
