/**
 * @fileoverview The PURE public entry point for the Factora library.
 * Use this if you want to provide your own dependencies instead of the defaults.
 */
export type {
  ErrorMapper,
  FactoraDependencies,
  FactoraLogger,
} from '@/types/dependencies';
export type { ApiError, ErrorMapperContext } from '@/types/error';
export type { ApiStoreOptions } from '@/types/store';
export type { UseApiQueryHook } from '@core/api-store-factory';
export { createApiFactoryPure } from '@core/index';
