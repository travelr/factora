import type { FactoraDependencies } from '@/types/dependencies';
import type { ApiStoreOptions } from '@/types/store';
import {
  createQueryHook,
  type UseApiQueryHook,
} from '../react/create-query-hook';
import { defaultRuntime, type RuntimeServices } from './runtime';
import { createStoreEngine, type KeyedApiState } from './store-engine';
import { attachStoreLifecycle } from './store-lifecycle';
import type { StoreApi } from 'zustand/vanilla';

export type { UseApiQueryHook } from '../react/create-query-hook';
export type { KeyedApiState, RequestDescriptor } from './store-engine';

export interface ApiStoreEngine<T> {
  useApiQuery: UseApiQueryHook<T>;
  internalStore: StoreApi<KeyedApiState<T>>;
}

/**
 * Composes the framework-independent store engine with runtime lifecycle and
 * the React hook adapter. This internal form exposes the engine to tests; the
 * public factory below returns only the hook.
 */
export const createApiStoreEngine = <T>(
  dependencies: FactoraDependencies<T>,
  apiPathKey: string,
  options: ApiStoreOptions = {},
  runtime: RuntimeServices = defaultRuntime,
): ApiStoreEngine<T> => {
  const engine = createStoreEngine(dependencies, options, runtime);
  const state = engine.store.getState();
  attachStoreLifecycle(
    engine.store,
    {
      clearAllQueryStates: state.clearAllQueryStates,
      clearStaleQueries: state.clearStaleQueries,
      refetchStaleQueries: state.refetchStaleQueries,
    },
    runtime,
    dependencies.logger,
  );

  return {
    useApiQuery: createQueryHook({
      store: engine.store,
      subscriptions: engine.subscriptions,
      endpoint: apiPathKey,
      description: engine.description,
      logger: dependencies.logger,
    }),
    internalStore: engine.store,
  };
};

export const createApiStoreCore = <T>(
  dependencies: FactoraDependencies<T>,
  apiPathKey: string,
  options: ApiStoreOptions = {},
): UseApiQueryHook<T> =>
  createApiStoreEngine(dependencies, apiPathKey, options).useApiQuery;
