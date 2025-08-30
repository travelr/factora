/* eslint-disable no-unused-vars */
/**
 * @fileoverview A factory for creating a robust, keyed API data store and React hook.
 *
 * This module provides a createApiStoreCore function that generates a Zustand-based store
 * and a useApiQuery hook. This pattern enforces a clear separation of concerns:
 *
 * 1. **The Store (The Engine):** A global, keyed cache responsible for all core logic,
 *    including request deduplication, caching, polling, retries, and abort handling.
 *    It is designed to be robust against race conditions.
 *
 * 2. **The Hook (The Consumer):** A lightweight React hook that connects components to the
 *    store. It subscribes to a specific query's state and provides stable action
 *    dispatchers (refetch, clear). It deliberately contains no complex lifecycle
 *    logic, ensuring the core behavior is centralized and predictable.
 *
 * NOTE: Important invariants to preserve when modifying this file:
 *  - Always clean up timers and AbortControllers *before* removing a query from state.
 *  - Never mutate a query state slice in a finally block without first verifying the slice still exists.
 *  - Keep `queryCount` consistent whenever queries are added/removed (used for efficient deregistration).
 */
import { registerStoreForGc } from '@core/api-store-gc';
import defer from '@utils/defer';
import { getQueryKey, parseQueryKey } from '@utils/get-query-key';
import { noop } from '@utils/noop-logger';
import { subscriptionManager } from '@utils/subscription-registry';
import { subscribeToQueryCount } from '@utils/zustand-utils';
import React from 'react';
import type { UseBoundStore } from 'zustand';
import { create, StoreApi } from 'zustand';
import { shallow, useShallow } from 'zustand/shallow';

import type { FactoraDependencies, FactoraLogger } from '@/types/dependencies';
import type { ApiError, ErrorMapperContext } from '@/types/error';
import type { ApiStoreOptions } from '@/types/store';

// --- Internal Types and Interfaces ---

interface QueryState<T> {
  data: T | null;
  error: ApiError | null;
  /** Timestamp (ms) of the last successful fetch. Used for TTL/GC. */
  lastFetchTimestamp?: number;
  /** If present, represents a shared in-flight promise for deduping concurrent fetches. */
  inFlightPromise?: Promise<void>;
  /** Controller used to abort the in-flight fetch. */
  abortController?: AbortController;
  /** Timer id for optional polling/refetch. */
  refetchTimerId?: ReturnType<typeof setTimeout>;
  /** Unique token to identify the current in-flight fetch cycle */
  inFlightToken?: symbol;
}

export interface KeyedApiState<T> {
  queries: Record<string, QueryState<T>>;
  /** A count of active queries, used for efficient deregistration watching. */
  queryCount: number;
  globalError: ApiError | null;
  triggerFetch: (key: string, forceFetch?: boolean) => Promise<void>;
  refetchStaleQueries: () => void;
  clearQueryState: (key: string) => void;
  clearAllQueryStates: () => void;
  clearStaleQueries: () => void;
  setGlobalErrorState: (message: string) => void;
  setQueryState: (
    key: string,
    updater: (state: QueryState<T>) => QueryState<T>,
  ) => void;
}

/**
 * A single, isolated fetch attempt with its own error handling wrapper.
 * This helper turns unknown throws into ApiError via the injected errorMapper so upstream logic
 * can make retry/abort decisions.
 */
const runFetchAttempt = async <T>(
  fetchFn: (
    endpoint: string,
    params: Record<string, any>,
    signal?: AbortSignal,
  ) => Promise<T>,
  errorMapper: (error: unknown, context: ErrorMapperContext) => ApiError,
  logger: FactoraLogger,
  apiPathKey: string,
  params: Record<string, any>,
  signal: AbortSignal,
  attempt: number,
  description: string,
): Promise<T> => {
  logger.info(
    `[${description}] Starting attempt ${attempt} for ${apiPathKey}`,
    params,
  );
  if (signal.aborted) {
    // Fast-fail if the caller already aborted
    throw new Error('Request aborted before fetch attempt');
  }
  try {
    const data = await fetchFn(apiPathKey, params, signal);
    if (signal.aborted) {
      // Extra guard: if aborted immediately after fetch resolves
      throw new Error('Request aborted after fetch attempt');
    }
    logger.info(
      `[${description} Success] Attempt ${attempt} succeeded for ${apiPathKey}`,
      params,
    );
    return data;
  } catch (error: unknown) {
    // Normalize error into ApiError with context via the injected mapper
    throw errorMapper(error, {
      endpoint: apiPathKey,
      params,
      description,
      attempt,
    });
  }
};

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

/**
 * A test-only export that allows test suites to get a direct reference
 * to the internal Zustand store instances. This variable and its usage will be
 * completely removed (tree-shaken) from your production build.
 */
// eslint-disable-next-line no-underscore-dangle
export const __test_only_apiStores = new Map<string, any>();

/**
 * Core factory that creates a keyed API store plus a hook that reads from it.
 * This function is pure and requires all external dependencies to be injected.
 *
 * Design notes:
 *  - The store is deliberately authoritative for data, retries, polling, and deduping.
 *  - The hook is intentionally thin: it subscribes, exposes stable actions, and does not hold complex lifecycle.
 *  - Garbage collection and subscription tracking are implemented outside the state to avoid rerenders.
 */
export const createApiStoreCore = <T>(
  dependencies: FactoraDependencies<T>,
  apiPathKey: string,
  options: ApiStoreOptions = {},
): UseApiQueryHook<T> => {
  const { logger, errorMapper, fetcher: fetchFn } = dependencies;

  const {
    cacheTTL = 5 * 60 * 1000,

    retryDelay = 1000,
    description = 'API Request',
    refetchIntervalMinutes = 0,
    gcGracePeriod = Math.max(cacheTTL * 2, 5 * 60 * 1000), // A safe, configurable default
  } = options;

  // Coerce retryAttempts to be at least 1.
  // This makes the API more predictable and prevents `retryAttempts: 0` from
  // silently doing nothing, aligning the code with the test's expectation.
  const rawRetryAttempts = options.retryAttempts ?? 3;
  const retryAttempts = Math.max(1, Math.floor(Number(rawRetryAttempts)));

  const refetchIntervalMs = refetchIntervalMinutes * 60 * 1000;

  /**
   * The internal Zustand store. All concurrency-sensitive work happens here.
   * Important invariants:
   *  - setQueryState must increment `queryCount` when a new key is created.
   *  - Deletions must decrement `queryCount`.
   *  - All resource cleanup (abort, timers) happens before deleting slices from state.
   */
  const useInternalStore: UseBoundStore<StoreApi<KeyedApiState<T>>> = create<
    KeyedApiState<T>
  >()((set, get) => {
    /**
     * @private
     * Executes the full fetch/retry cycle for a given query.
     *
     * Notes:
     *  - Retries honor exponential backoff and server-provided `retryAfter` (if present).
     *  - Delay between retries is abort-aware: if the controller is aborted during the timeout,
     *    the delay promise rejects and we stop retrying.
     *  - On success we set a refetch timer only after the data is stored so the store remains the source of truth.
     */
    const executeFetchCycle = async (
      key: string,
      controller: AbortController,
      inFlightToken: symbol,
    ): Promise<void> => {
      const { setQueryState, triggerFetch } = get();
      const { endpoint: currentApiPathKey, params: runtimeParams } =
        parseQueryKey(key);

      for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        if (controller.signal.aborted) {
          logger.warn(
            `[${description}] Fetch for ${key} aborted before attempt ${attempt}.`,
          );
          return;
        }

        try {
          const data = await runFetchAttempt(
            fetchFn,
            errorMapper,
            logger,
            currentApiPathKey,
            runtimeParams,
            controller.signal,
            attempt,
            description,
          );

          // If polling is enabled, schedule the next run AFTER a successful fetch.
          let newRefetchTimerId: ReturnType<typeof setTimeout> | undefined;
          if (refetchIntervalMs > 0) {
            newRefetchTimerId = setTimeout(
              () => triggerFetch(key, true),
              refetchIntervalMs,
            );
          }

          // Update query state atomically. Clear any previous poll timer first.
          setQueryState(key, (s) => {
            if (s.inFlightToken !== inFlightToken) {
              if (newRefetchTimerId) clearTimeout(newRefetchTimerId);
              return s;
            }
            if (s.refetchTimerId) clearTimeout(s.refetchTimerId);
            return {
              ...s,
              data,
              error: null,
              lastFetchTimestamp: Date.now(),
              refetchTimerId: newRefetchTimerId,
            };
          });
          // Successful fetch -> exit retry loop
          return;
        } catch (error) {
          const apiError = error as ApiError;

          // Always check the token before writing an error state.
          if (!apiError.isAbort) {
            setQueryState(key, (s) => {
              if (s.inFlightToken !== inFlightToken) return s; // Discard stale error
              return { ...s, error: apiError };
            });
          }

          // If the error is terminal, stop retrying.
          if (
            apiError.isAbort ||
            attempt >= retryAttempts ||
            !apiError.retryable
          ) {
            return;
          }

          // Otherwise compute delay and perform abort-aware sleep
          try {
            const baseDelay = retryDelay * Math.pow(2, attempt - 1);
            // Prioritize server-provided retry-after header over exponential backoff.
            const delay = apiError.retryAfter ?? baseDelay;

            // This promise-based delay is abort-aware. If the controller is aborted
            // during the timeout, the promise rejects, breaking the delay.
            // eslint-disable-next-line promise/avoid-new
            await new Promise<void>((resolve, reject) => {
              const timerId = setTimeout(resolve, delay);
              controller.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timerId);
                  reject(new Error('Retry delay aborted'));
                },
                { once: true },
              );
            });
          } catch {
            logger.info(
              `[${description}] Retry delay for ${key} was aborted. Stopping retries.`,
            );
            return; // Exit the retry loop if the delay is aborted.
          }
        }
      }
    };

    return {
      // Initial state
      queries: {},
      queryCount: 0,
      globalError: null,

      /**
       * Functional updater for query state.
       *
       * Important: this function is responsible for maintaining queryCount correctly.
       * It increments queryCount when a previously-missing key is added.
       */
      setQueryState: (key, updater) => {
        set((s) => {
          const current = s.queries[key];
          const defaultState = { data: null, error: null };
          const updated = updater(current || defaultState);

          // If the key didn't exist and the updater did nothing, prevent resurrection.
          if (!current && updated === defaultState) {
            return s;
          }

          // Use shallow comparison to prevent unnecessary re-renders if the state object is semantically the same.
          if (shallow(current, updated)) return s;
          const newQueries = { ...s.queries, [key]: updated };
          // Increment count only if it's a new entry being created.
          const queryCountDiff = current ? 0 : 1;
          return {
            queries: newQueries,
            queryCount: s.queryCount + queryCountDiff,
          };
        });
      },

      /**
       * triggerFetch: The single entrypoint for initiating a fetch for a key.
       *
       * Key points:
       *  - Deduplication: If an inFlightPromise exists and it's not a forced refetch, return it.
       *  - Forced refetch will abort the in-progress request for this key and start a new one.
       *  - Cache check: honors cacheTTL unless forceFetch is true.
       *  - **Deferred promise pattern**: we create a deferred promise (fetchPromise) and set it
       *    into state *before* starting the actual async work. This atomically claims the slot
       *    so concurrent callers receive the same promise and we avoid duplicate requests.
       *
       *  Why deferredResolve? Consumers await the `inFlightPromise` returned via state. When
       *  the fetch cycle completes (success/error/abort) we resolve the deferred so all waiters continue.
       */
      triggerFetch: (key: string, forceFetch = false): Promise<void> => {
        const { setQueryState } = get();
        let queryState = get().queries[key];

        // On a forced refetch, abort any existing request for the same key.
        if (forceFetch && queryState?.abortController) {
          queryState.abortController.abort();
        } else if (queryState?.inFlightPromise) {
          // Deduplicate: if a request is already in progress, return its promise.
          return queryState.inFlightPromise;
        }

        // Re-read after potential abort to get current state.
        queryState = get().queries[key];
        const now = Date.now();

        // Cache hit: data is fresh, avoid network request.
        if (
          !forceFetch &&
          queryState?.data &&
          !queryState.error &&
          queryState.lastFetchTimestamp &&
          cacheTTL > 0 &&
          now - queryState.lastFetchTimestamp < cacheTTL
        ) {
          // If polling is enabled, refresh the refetch timer so we keep scheduling polls.
          if (refetchIntervalMs > 0) {
            setQueryState(key, (s) => {
              if (s.refetchTimerId) clearTimeout(s.refetchTimerId);
              return {
                ...s,
                refetchTimerId: setTimeout(
                  () => get().triggerFetch(key, true),
                  refetchIntervalMs,
                ),
              };
            });
          }
          return Promise.resolve();
        }

        // Create new AbortController for this specific fetch attempt.
        const controller = new AbortController();
        // Deferred promise pattern to atomically claim the inFlight slot.
        const { promise: fetchPromise, resolve: deferredResolve } =
          defer<void>();

        // Fix Race condition guard: unique token for this fetch cycle
        // The root cause is triggerFetch attaching cleanup to the wrong promise
        // (a promise that resolves too early) because executeFetchCycle either (A)
        // returns/settles an outer promise before its internal retry delay work
        // completes, or (B) uses a non-awaited setTimeout/then chain, so that
        // the lifecycle appears “done” to triggerFetch even though the worker
        // is still waiting to retry — this clears inFlightPromise while
        // real work continues.
        const inFlightToken = Symbol(`inFlightToken-${key}`);

        // 1. ATOMIC SLOT CLAIM: Synchronously set the inFlightPromise in the store.
        //    Any other call to triggerFetch will now see this promise and return it,
        //    preventing duplicate requests.
        setQueryState(key, (s) => ({
          ...s,
          error: null,
          inFlightPromise: fetchPromise,
          inFlightToken,
          abortController: controller,
          refetchTimerId: undefined,
        }));

        // 2. DEFERRED EXECUTION: Start the actual async work *after* the slot is claimed.
        //    The `.catch()` here is a safeguard for unexpected errors within the cycle itself.

        executeFetchCycle(key, controller, inFlightToken)
          .finally(() => {
            // The `inFlightToken` check.
            // This prevents a "stale worker" from an old, superseded request
            // from incorrectly clearing the state of a newer, active request.
            const currentQueryState = get().queries[key];
            if (
              currentQueryState &&
              currentQueryState.inFlightToken === inFlightToken
            ) {
              // Only clean up if this is still the active request.
              setQueryState(key, (s) => ({
                ...s,
                inFlightPromise: undefined,
                inFlightToken: undefined,
                abortController: undefined,
              }));
            }
            // If tokens do NOT match, this block does nothing, preventing the bug.

            // Settle the original promise that all consumers are awaiting.
            deferredResolve();
          })
          .catch((unexpectedError) => {
            // This catch is for unexpected errors in the fetch flow itself.
            logger.error(
              `[${description}] An unexpected error occurred in the fetch cycle for key ${key}.`,
              unexpectedError,
            );
          });
        return fetchPromise;
      },

      /**
       * Finds and refetches entries whose cached data has gone stale (by cacheTTL).
       * Note: this is separate from GC. GC evicts entirely unused data; refetchStaleQueries
       * proactively refreshes stale entries.
       */
      refetchStaleQueries: () => {
        if (cacheTTL <= 0) return;
        const { queries, triggerFetch } = get();
        const now = Date.now();
        Object.entries(queries).forEach(([key, queryState]) => {
          if (
            queryState.inFlightPromise ||
            !queryState.lastFetchTimestamp ||
            queryState.error
          )
            return;
          if (now - queryState.lastFetchTimestamp > cacheTTL) {
            triggerFetch(key, true);
          }
        });
      },

      /**
       * clearQueryState: Explicit clearance of a single query key.
       * Important: we capture and clean up resources (abort controller, timer) *before*
       * mutating/deleting the state slice to avoid orphaned resources.
       */
      clearQueryState: (key: string) => {
        const queryToClear = get().queries[key];
        // Clean up abort controller if it exists. Optional chaining handles missing resources
        // (normal case), while try/catch catches only genuine .abort() errors (rare edge case).
        try {
          queryToClear?.abortController?.abort();
        } catch (e) {
          logger.error(
            `[ApiStore: ${description}] Error aborting request for key: ${key}`,
            e,
          );
        }

        // Clear refresh timer if it exists. clearTimeout() safely handles undefined,
        // but we check first to avoid unnecessary calls. The try/catch is defense-in-depth
        // for environments with non-standard timer implementations.
        try {
          if (queryToClear?.refetchTimerId) {
            clearTimeout(queryToClear.refetchTimerId);
          }
        } catch (e) {
          logger.error(
            `[ApiStore: ${description}] Error clearing timer for key: ${key}`,
            e,
          );
        }

        // STATE REMOVAL (ATOMIC)
        // Remove query from state regardless of cleanup errors. Resource issues should
        // never prevent state removal - this is the key guarantee our test verifies.
        set((s) => {
          if (!s.queries[key]) return s; // already cleared
          const newQueries = { ...s.queries };
          delete newQueries[key];
          return { queries: newQueries, queryCount: s.queryCount - 1 };
        });
      },

      /**
       * clearAllQueryStates: Global clear (logout/workspace switch).
       * Always cleans all resources first, then wipes the store in one atomic set.
       */
      clearAllQueryStates: () => {
        // Ensure all resources are cleared first.
        Object.values(get().queries).forEach((query) => {
          if (query.abortController) query.abortController.abort();
          if (query.refetchTimerId) clearTimeout(query.refetchTimerId);
        });
        // Then reset state.
        set({ queries: {}, queryCount: 0, globalError: null });
      },

      /**
       * clearStaleQueries: Conservative garbage collection sweep for this store.
       *
       * Pattern used:
       *  1. Inside a single atomic `set` callback, identify stale & unused candidates,
       *     capture their cleanup resources (controllers, timers) into `cleanupJobs`,
       *     and delete the entries from the new state snapshot.
       *  2. After `set` returns, iterate `cleanupJobs` and unconditionally abort/clear them.
       *
       * Rationale:
       *  - Performing the *state mutation* inside the atomic `set` avoids TOCTOU races:
       *    we observe and remove entries consistently.
       *  - Performing the actual resource abort/clear *after* the atomic update prevents
       *    reentrancy hazards that can occur if `abort()` triggers other store mutations while
       *    inside Zustand's `set` callback.
       *
       * Safety note:
       *  - It's safe to abort the captured abortController *after* deletion because a new fetch
       *    for the same key will create a brand-new AbortController instance. Aborting the old one
       *    cannot accidentally cancel a new request.
       */
      clearStaleQueries: () => {
        const sweptAt = Date.now();
        const cleanupJobs: Array<{
          abortController?: AbortController;
          refetchTimerId?: ReturnType<typeof setTimeout>;
        }> = [];

        set((s) => {
          const newQueries = { ...s.queries };
          let changed = false;
          let queriesDeleted = 0;

          Object.keys(newQueries).forEach((key) => {
            const candidate = newQueries[key];

            // Compute conditions for skipping eviction — any of these means the entry is "active".
            const hasSubscribers = subscriptionManager.hasSubscribers(key); // external registry check
            const isInFlight = !!candidate.inFlightPromise; // active network work
            const hasTimer = !!candidate.refetchTimerId; // actively polling
            const isStale =
              candidate.lastFetchTimestamp &&
              sweptAt - candidate.lastFetchTimestamp > gcGracePeriod;

            // Skip eviction if entry is active, polling, or not stale yet.
            if (hasSubscribers || isInFlight || hasTimer || !isStale) {
              if (logger.getLevel() <= logger.levels.DEBUG) {
                logger.debug(`[GC] Skipped eviction for "${key}":`, {
                  hasSubscribers,
                  isInFlight,
                  hasTimer,
                  isStale,
                });
              }
              return;
            }

            // Candidate is safe to remove from state: capture its external resources for cleanup.
            cleanupJobs.push({
              abortController: candidate.abortController,
              refetchTimerId: candidate.refetchTimerId,
            });

            // Delete from the draft state (we'll perform cleanup after set returns).
            delete newQueries[key];
            changed = true;
            queriesDeleted++;
          });

          if (!changed) return s;
          return {
            queries: newQueries,
            queryCount: s.queryCount - queriesDeleted,
          };
        });

        // Perform cleanup OUTSIDE the atomic state update to avoid reentrancy.
        for (const job of cleanupJobs) {
          try {
            if (job.refetchTimerId) clearTimeout(job.refetchTimerId);
            job.abortController?.abort();
          } catch (e) {
            logger.error('[GC] Error during resource cleanup job.', e);
          }
        }
      },

      setGlobalErrorState: (message: string) => {
        set({
          globalError: {
            message: message || 'An unknown store error occurred.',
            retryable: false,
          },
        });
      },
    };
  });

  if (process.env.NODE_ENV === 'test') {
    __test_only_apiStores.set(apiPathKey, useInternalStore);
  }

  const deregister = registerStoreForGc({
    clearStaleQueries: useInternalStore.getState().clearStaleQueries,
  });

  /**
   * Store-level deregistration watcher.
   *
   * Rationale:
   *  - We avoid per-hook deregistration (which would run many times) and instead watch
   *    the store's `queryCount`. When it becomes zero and remains zero for a short debounce,
   *    we deregister the store to keep the global registry small.
   *
   * Timing:
   *  - The small delay (1500ms) tolerates rapid mount/unmount cycles (React Strict Mode or fast routing)
   *    while still removing genuinely idle stores reasonably quickly.
   */
  let deregisterScheduled = false;
  const unsubWatcher = subscribeToQueryCount(useInternalStore, (count) => {
    if (count === 0 && !deregisterScheduled) {
      deregisterScheduled = true;
      setTimeout(() => {
        if (useInternalStore.getState().queryCount === 0) {
          logger.info(`[GC] Deregistering empty store: ${description}`);
          deregister();
          unsubWatcher();
        } else {
          deregisterScheduled = false;
        }
      }, 1500);
    }
  });

  /**
   * The consumer-facing hook produced by the factory.
   *
   * Design goals:
   *  - Minimal lifecycle responsibilities: it only subscribes to the registry and triggers fetches.
   *  - Stable action callbacks (refetch/clear) for consumers.
   *
   * Important: the useEffect subscribes to the subscriptionManager *before* triggering the fetch.
   * This ordering narrows the race window where the GC might see a key with zero subscribers
   * and evict it between mount and effect execution.
   */
  const useApiQuery: UseApiQueryHook<T> = (
    runtimeParams: Record<string, any> = {},
  ) => {
    let key: string;
    try {
      // 1. Call the pure utility.
      key = getQueryKey(apiPathKey, runtimeParams);
    } catch (error) {
      // 2. If it throws, the impure core CATCHES the error.
      // 3. The core then uses its INJECTED logger to report the problem.
      logger.error(
        `[${description}] Failed to generate a valid query key. This often indicates a programming error where an invalid apiPathKey or params were passed to the hook.`,
        {
          apiPathKey,
          runtimeParams,
          error, // Include the original error for context
        },
      );

      // 4. The hook must still return a valid, stable state to the component to prevent a crash.
      return {
        data: null,
        loading: false,
        error: {
          message:
            error instanceof Error
              ? error.message
              : 'Failed to generate query key',
          retryable: false,
        },
        // Provide no-op functions so the component's event handlers don't crash.
        refetch: noop,
        clear: noop,
      };
    }

    // If we get here, the key is valid, and the rest of the hook can proceed as normal.
    const { triggerFetch, clearQueryState } = useInternalStore();

    // Create a stable selector for the minimal state we need
    const querySelector = React.useCallback(
      (s: KeyedApiState<T>) => ({
        data: s.queries[key]?.data ?? null,
        error: s.queries[key]?.error ?? null,
        loading: !!s.queries[key]?.inFlightPromise,
      }),
      [key],
    );

    // Apply Zustand's shallow comparison to our selector
    const queryState = useInternalStore(useShallow(querySelector));

    React.useEffect(() => {
      // Subscribe to the registry first (client-only) so GC sees us as an active consumer
      // as early as possible, then trigger fetch. The fetch call uses the store's atomic slot
      // claim to deduplicate simultaneous fetch attempts.
      const subscriberId = subscriptionManager.subscribe(key);
      triggerFetch(key, false);

      return () => {
        subscriptionManager.unsubscribe(key, subscriberId);
      };
      // Note: triggerFetch is intentionally included in deps to ensure correct behavior.
    }, [key, triggerFetch]);

    const refetch = React.useCallback(() => {
      triggerFetch(key, true);
    }, [key, triggerFetch]);

    const clear = React.useCallback(() => {
      clearQueryState(key);
    }, [key, clearQueryState]);

    return { ...queryState, refetch, clear };
  };

  // Expose utility functions on the hook for convenience.
  useApiQuery.clearAll = useInternalStore.getState().clearAllQueryStates;
  useApiQuery.getGlobalError = (): ApiError | null =>
    useInternalStore.getState().globalError;

  return useApiQuery;
};
