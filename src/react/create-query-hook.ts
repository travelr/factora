/**
 * @fileoverview React adapter for the framework-independent keyed store engine.
 */
import type { FactoraLogger } from '@/types/dependencies';
import type { ApiError } from '@/types/error';
import type { KeyedApiState, RequestDescriptor } from '@core/store-engine';
import { getQueryKey } from '@utils/get-query-key';
import { noop } from '@utils/noop-logger';
import type { SubscriptionManager } from '@utils/subscription-registry';
import React from 'react';
import { type StoreApi, useStore } from 'zustand';
import { useShallow } from 'zustand/shallow';

export interface UseApiQueryHook<TData> {
  (params?: Record<string, any>): {
    data: TData | null;
    loading: boolean;
    error: ApiError | null;
    refetch: () => void;
    clear: () => void;
  };
  clearAll: () => void;
  getGlobalError: () => ApiError | null;
}

interface ReactQueryAdapterOptions<T> {
  store: StoreApi<KeyedApiState<T>>;
  subscriptions: SubscriptionManager;
  endpoint: string;
  description: string;
  logger: FactoraLogger;
}

/**
 * Adapts the framework-independent store engine to React.
 *
 * Every hook is called for both valid and invalid parameters. Invalid keys use
 * an inert selector/effect path, preserving React hook order across rerenders.
 * The effect subscribes before starting the request so GC cannot observe a
 * newly mounted query as unused between subscription and slot claiming.
 */
export const createQueryHook = <T>({
  store,
  subscriptions,
  endpoint,
  description,
  logger,
}: ReactQueryAdapterOptions<T>): UseApiQueryHook<T> => {
  const useApiQuery: UseApiQueryHook<T> = (
    runtimeParams: Record<string, any> = {},
  ) => {
    const keyResult = React.useMemo(() => {
      try {
        return { key: getQueryKey(endpoint, runtimeParams), error: null };
      } catch (error) {
        logger.error(`[${description}] Failed to generate query identity.`, {
          endpoint,
          message: error instanceof Error ? error.message : String(error),
        });
        return { key: null, error };
      }
    }, [runtimeParams]);
    const key = keyResult.key;

    // Keep the exact request object that first claims a new key. Cache identity
    // is never decoded back into transport values.
    const requestRef = React.useRef<{
      key: string | null;
      request: RequestDescriptor;
    }>({ key, request: { endpoint, params: runtimeParams } });
    if (requestRef.current.key !== key) {
      requestRef.current = {
        key,
        request: { endpoint, params: runtimeParams },
      };
    }

    const triggerFetch = useStore(store, (state) => state.triggerFetch);
    const clearQueryState = useStore(store, (state) => state.clearQueryState);
    const queryState = useStore(
      store,
      useShallow((state: KeyedApiState<T>) => ({
        data: key ? (state.queries[key]?.data ?? null) : null,
        error: key ? (state.queries[key]?.error ?? null) : null,
        loading: key ? !!state.queries[key]?.inFlightPromise : false,
      })),
    );

    React.useEffect(() => {
      if (!key) return undefined;
      const subscriberId = subscriptions.subscribe(key);

      void triggerFetch(key, false, requestRef.current.request).catch(noop);

      return () => {
        subscriptions.unsubscribe(key, subscriberId);
      };
    }, [key, triggerFetch]);

    const refetch = React.useCallback(() => {
      if (!key) return;

      // Clearing a query removes its stored request descriptor. The mounted
      // hook still owns the original transport values, so pass them back when
      // recreating the request instead of attempting to decode the cache key.
      void triggerFetch(key, true, requestRef.current.request).catch(noop);
    }, [key, triggerFetch]);

    const clear = React.useCallback(() => {
      if (key) clearQueryState(key);
    }, [key, clearQueryState]);

    if (keyResult.error || !key) {
      return {
        data: null,
        loading: false,
        error: {
          message:
            keyResult.error instanceof Error
              ? keyResult.error.message
              : 'Failed to generate query key',
          retryable: false,
        },
        refetch: noop,
        clear: noop,
      };
    }

    return { ...queryState, refetch, clear };
  };

  useApiQuery.clearAll = store.getState().clearAllQueryStates;
  useApiQuery.getGlobalError = () => store.getState().globalError;
  return useApiQuery;
};
