/**
 * @fileoverview Framework-independent keyed request/cache state machine.
 *
 * The engine owns request deduplication, caching, retries, polling, cancellation,
 * and resource cleanup. React subscription behavior and runtime registration are
 * composed in separate adapters.
 *
 * Important invariants:
 *  - Capture resources before removal and release each one exactly once.
 *  - A superseded cycle may mutate state only when its token still owns the slot.
 *  - Keep `queryCount` consistent whenever queries are added or removed.
 */
import { defaultRuntime, type RuntimeServices } from '@core/runtime';
import defer from '@utils/defer';
import { noop } from '@utils/noop-logger';
import {
  createSubscriptionManager,
  type SubscriptionManager,
} from '@utils/subscription-registry';
import { shallow } from 'zustand/shallow';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { FactoraDependencies, FactoraLogger } from '@/types/dependencies';
import type { ApiError, ErrorMapperContext } from '@/types/error';
import type { ApiStoreOptions } from '@/types/store';
// --- Internal Types and Interfaces ---

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Timer cleanup is best-effort and must never replace a request outcome. */
const clearRuntimeTimeout = (
  runtime: RuntimeServices,
  timerId: ReturnType<typeof setTimeout>,
  logger: FactoraLogger,
  operation: string,
): void => {
  try {
    runtime.clearTimeout(timerId);
  } catch (error) {
    runtime.reportInternalError(operation, error, logger);
  }
};

/** Cancellation is best-effort; request tokens still prevent stale writes. */
const abortRuntimeRequest = (
  runtime: RuntimeServices,
  controller: AbortController,
  logger: FactoraLogger,
  operation: string,
): void => {
  try {
    controller.abort();
  } catch (error) {
    runtime.reportInternalError(operation, error, logger);
  }
};

export interface RequestDescriptor {
  endpoint: string;
  params: Record<string, any>;
}

interface QueryState<T> {
  data: T | null;
  error: ApiError | null;
  /** Timestamp (ms) of the last successful fetch. Used for TTL/GC. */
  lastFetchTimestamp?: number;
  /** Timestamp of the latest success or terminal failure. Used for GC. */
  lastSettledTimestamp?: number;
  /** Original request values. Cache keys are identity only and are never decoded. */
  request?: RequestDescriptor;
  /** If present, represents a shared in-flight promise for deduping concurrent fetches. */
  inFlightPromise?: Promise<void>;
  /** Controller used to abort the in-flight fetch. */
  abortController?: AbortController;
  /** Timer id for optional polling/refetch. */
  refetchTimerId?: ReturnType<typeof setTimeout>;
  /** Unique token to identify the current in-flight fetch cycle */
  inFlightToken?: symbol;
}

type QueryResources = Pick<
  QueryState<unknown>,
  'abortController' | 'refetchTimerId'
>;

export interface KeyedApiState<T> {
  queries: Record<string, QueryState<T>>;
  /** A count of active queries, used for efficient deregistration watching. */
  queryCount: number;
  globalError: ApiError | null;
  triggerFetch: (
    key: string,
    forceFetch?: boolean,
    request?: RequestDescriptor,
  ) => Promise<void>;
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
  controller: AbortController,
  attempt: number,
  description: string,
  requestTimeoutMs: number,
  runtime: RuntimeServices,
): Promise<T> => {
  const signal = controller.signal;
  logger.info(`[${description}] Starting request.`, {
    endpoint: apiPathKey,
    attempt,
  });
  if (signal.aborted) {
    // Fast-fail if the caller already aborted
    throw new Error('Request aborted before fetch attempt');
  }
  try {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const request = fetchFn(apiPathKey, params, signal);
    const data =
      requestTimeoutMs > 0
        ? await Promise.race([
            request,
            // eslint-disable-next-line promise/avoid-new
            new Promise<never>((_resolve, reject) => {
              timeoutId = runtime.setTimeout(() => {
                reject(
                  new Error(`Request timed out after ${requestTimeoutMs}ms`),
                );
                // Queue the timeout rejection before aborting the transport so
                // an abort-aware fetcher cannot win the Promise.race.
                abortRuntimeRequest(
                  runtime,
                  controller,
                  logger,
                  'abort timed-out request',
                );
              }, requestTimeoutMs);
            }),
          ]).finally(() => {
            if (timeoutId === undefined) return;
            clearRuntimeTimeout(
              runtime,
              timeoutId,
              logger,
              'clear request timeout',
            );
          })
        : await request;
    if (signal.aborted) {
      // Extra guard: if aborted immediately after fetch resolves
      throw new Error('Request aborted after fetch attempt');
    }
    logger.info(`[${description}] Request succeeded.`, {
      endpoint: apiPathKey,
      attempt,
    });
    return data;
  } catch (error: unknown) {
    const context = {
      endpoint: apiPathKey,
      params,
      description,
      attempt,
    };
    let mappedError: ApiError;
    try {
      mappedError = errorMapper(error, context);
    } catch (mapperError) {
      runtime.reportInternalError('map request error', mapperError, logger);
      throw {
        message: 'Request failed because error mapping failed.',
        retryable: false,
        originalError: error,
        context,
      } satisfies ApiError;
    }
    if (
      !mappedError ||
      typeof mappedError !== 'object' ||
      typeof mappedError.message !== 'string'
    ) {
      runtime.reportInternalError(
        'map request error',
        new TypeError('Error mapper returned an invalid ApiError.'),
        logger,
      );
      throw {
        message: 'Request failed because error mapping failed.',
        retryable: false,
        originalError: error,
        context,
      } satisfies ApiError;
    }
    throw mappedError;
  }
};

export interface StoreEngine<T> {
  store: StoreApi<KeyedApiState<T>>;
  subscriptions: SubscriptionManager;
  description: string;
}

/** Creates the framework-independent store and its private subscription tracker. */
export const createStoreEngine = <T>(
  dependencies: FactoraDependencies<T>,
  options: ApiStoreOptions = {},
  runtime: RuntimeServices = defaultRuntime,
): StoreEngine<T> => {
  const { logger, errorMapper, fetcher: fetchFn } = dependencies;
  const normalizeNonNegative = (
    name: string,
    value: number | undefined,
    fallback: number,
  ): number => {
    if (value === undefined) return fallback;
    if (Number.isFinite(value) && value >= 0) return value;
    logger.warn(`[${options.description ?? 'API Request'}] Invalid option.`, {
      option: name,
      fallback,
    });
    return fallback;
  };

  const cacheTTL =
    options.cacheTTL === undefined
      ? 5 * 60 * 1000
      : Number.isFinite(options.cacheTTL)
        ? Math.max(0, options.cacheTTL)
        : 5 * 60 * 1000;
  const retryDelay = normalizeNonNegative(
    'retryDelay',
    options.retryDelay,
    1000,
  );
  const description = options.description ?? 'API Request';
  const refetchIntervalMinutes = normalizeNonNegative(
    'refetchIntervalMinutes',
    options.refetchIntervalMinutes,
    0,
  );
  const gcGracePeriod = normalizeNonNegative(
    'gcGracePeriod',
    options.gcGracePeriod,
    Math.max(cacheTTL * 2, 5 * 60 * 1000),
  );
  const requestTimeoutMs = Math.min(
    MAX_TIMER_DELAY_MS,
    normalizeNonNegative('requestTimeoutMs', options.requestTimeoutMs, 0),
  );
  const rawRetryAttempts = options.retryAttempts ?? 3;
  const retryAttempts =
    Number.isFinite(rawRetryAttempts) && rawRetryAttempts >= 0
      ? Math.max(1, Math.floor(rawRetryAttempts))
      : 3;
  if (!Number.isFinite(rawRetryAttempts) || rawRetryAttempts < 0) {
    logger.warn(`[${description}] Invalid option.`, {
      option: 'retryAttempts',
      fallback: 3,
    });
  }
  const shouldRetry =
    options.shouldRetry ??
    ((error: ApiError): boolean => error.retryable === true);
  const refetchIntervalMs = Math.min(
    MAX_TIMER_DELAY_MS,
    refetchIntervalMinutes * 60 * 1000,
  );
  const subscriptionManager = createSubscriptionManager();

  /**
   * The internal Zustand store. All concurrency-sensitive work happens here.
   * Important invariants:
   *  - setQueryState must increment `queryCount` when a new key is created.
   *  - Deletions must decrement `queryCount`.
   *  - All resource cleanup (abort, timers) happens before deleting slices from state.
   */
  const store = createStore<KeyedApiState<T>>()((set, get) => {
    /**
     * Releases both resources independently. An AbortController supplied by a
     * custom environment can throw; that must never prevent timer cleanup.
     */
    const cleanupResources = (resources?: QueryResources): void => {
      if (resources?.abortController) {
        abortRuntimeRequest(
          runtime,
          resources.abortController,
          logger,
          'abort query request',
        );
      }
      if (resources?.refetchTimerId !== undefined) {
        clearRuntimeTimeout(
          runtime,
          resources.refetchTimerId,
          logger,
          'clear query resource timer',
        );
      }
    };

    /**
     * Schedules one poll for the currently active query cycle.
     *
     * The callback clears its own timer identity before checking subscribers.
     * This matters because GC treats a stored timer as active work, and because
     * an unmounted query must not issue one final "zombie" request.
     */
    const scheduleNextPoll = (
      key: string,
    ): ReturnType<typeof setTimeout> | undefined => {
      if (refetchIntervalMs <= 0 || !subscriptionManager.hasSubscribers(key)) {
        return undefined;
      }
      try {
        let timerId: ReturnType<typeof setTimeout>;
        timerId = runtime.setTimeout(() => {
          try {
            const current = get().queries[key];
            if (!current || current.refetchTimerId !== timerId) return;
            get().setQueryState(key, (state) => ({
              ...state,
              refetchTimerId: undefined,
            }));
            if (subscriptionManager.hasSubscribers(key)) {
              void get().triggerFetch(key, true).catch(noop);
            }
          } catch (error) {
            runtime.reportInternalError('run scheduled poll', error, logger);
          }
        }, refetchIntervalMs);
        return timerId;
      } catch (error) {
        runtime.reportInternalError('schedule poll', error, logger);
        return undefined;
      }
    };

    /**
     * Executes the attempts belonging to one atomically claimed request cycle.
     *
     * Invariants:
     *  - Request parameters come from the descriptor stored during slot claiming;
     *    cache keys are never decoded into transport values.
     *  - Every state write checks `inFlightToken`, so a superseded cycle cannot
     *    overwrite a forced refetch.
     *  - This function owns attempts, retry waits, and token-guarded finalization.
     *    `triggerFetch` owns only synchronous slot claiming and the shared deferred.
     *  - Cancellation rejects the cycle promise. Callers that launch work without
     *    awaiting it must consume that rejection.
     */
    const executeFetchCycle = async (
      key: string,
      controller: AbortController,
      inFlightToken: symbol,
    ): Promise<void> => {
      const { setQueryState } = get();
      const request = get().queries[key]?.request;
      if (!request) return;
      const { endpoint: currentApiPathKey, params: runtimeParams } = request;

      try {
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
          if (controller.signal.aborted) {
            logger.warn(
              `[${description}] Fetch aborted before request attempt.`,
              {
                endpoint: currentApiPathKey,
                attempt,
              },
            );
            throw new Error('Request cycle aborted');
          }

          try {
            const data = await runFetchAttempt(
              fetchFn,
              errorMapper,
              logger,
              currentApiPathKey,
              runtimeParams,
              controller,
              attempt,
              description,
              requestTimeoutMs,
              runtime,
            );

            const settledAt = runtime.now();
            setQueryState(key, (s) => {
              if (s.inFlightToken !== inFlightToken) {
                return s;
              }
              if (s.refetchTimerId !== undefined) {
                clearRuntimeTimeout(
                  runtime,
                  s.refetchTimerId,
                  logger,
                  'clear previous poll after request success',
                );
              }
              return {
                ...s,
                data,
                error: null,
                lastFetchTimestamp: settledAt,
                lastSettledTimestamp: settledAt,
                refetchTimerId: undefined,
              };
            });
            return;
          } catch (error) {
            const apiError = error as ApiError;
            let retryAllowed = false;
            if (
              !apiError.isAbort &&
              !controller.signal.aborted &&
              attempt < retryAttempts
            ) {
              try {
                retryAllowed = shouldRetry(apiError, attempt);
              } catch (policyError) {
                runtime.reportInternalError(
                  'evaluate retry policy',
                  policyError,
                  logger,
                );
              }
            }

            // Abort errors describe deliberate cancellation and must not replace
            // the visible error/data belonging to the newer request cycle.
            if (!apiError.isAbort) {
              if (!retryAllowed) {
                // Log only when this cycle will not continue, avoiding noise
                // for failures that are followed by a retry delay.
                logger.error(`[${description}] Request failed.`, {
                  endpoint: currentApiPathKey,
                  status: apiError.status,
                  errorCode: apiError.errorCode,
                });
              }
              const settledAt = runtime.now();
              setQueryState(key, (s) => {
                if (s.inFlightToken !== inFlightToken) return s; // Discard stale error
                return {
                  ...s,
                  error: apiError,
                  lastSettledTimestamp: settledAt,
                };
              });
            }

            if (!retryAllowed) {
              // This throws to the deferred promise, which is eventually caught
              // by the hook's safety net: triggerFetch(...).catch(noop)
              throw apiError;
            }

            try {
              const baseDelay = retryDelay * Math.pow(2, attempt - 1);
              // Prioritize server-provided retry-after header over exponential backoff.
              // Custom error mappers are runtime inputs, so validate their delay
              // even though ApiError's TypeScript shape declares a number.
              const requestedDelay = Number.isFinite(apiError.retryAfter)
                ? (apiError.retryAfter as number)
                : baseDelay;
              const delay = Math.min(
                MAX_TIMER_DELAY_MS,
                Math.max(0, requestedDelay),
              );

              // This promise-based delay is abort-aware. If the controller is aborted
              // during the timeout, the promise rejects, breaking the delay.
              // eslint-disable-next-line promise/avoid-new
              await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                  clearRuntimeTimeout(
                    runtime,
                    timerId,
                    logger,
                    'clear retry delay',
                  );
                  controller.signal.removeEventListener('abort', onAbort);
                  reject(new Error('Retry delay aborted'));
                };
                const timerId = runtime.setTimeout(() => {
                  controller.signal.removeEventListener('abort', onAbort);
                  resolve();
                }, delay);
                controller.signal.addEventListener('abort', onAbort, {
                  once: true,
                });
                if (controller.signal.aborted) onAbort();
              });
            } catch (delayError) {
              if (controller.signal.aborted) {
                logger.info(`[${description}] Retry delay was aborted.`, {
                  endpoint: currentApiPathKey,
                });
              } else {
                runtime.reportInternalError(
                  'schedule retry delay',
                  delayError,
                  logger,
                );
              }
              throw delayError;
            }
          }
        }
      } finally {
        const currentQueryState = get().queries[key];
        if (currentQueryState?.inFlightToken === inFlightToken) {
          const refetchTimerId = scheduleNextPoll(key);
          setQueryState(key, (state) => ({
            ...state,
            inFlightPromise: undefined,
            inFlightToken: undefined,
            abortController: undefined,
            refetchTimerId,
          }));
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
       *  The deferred settles only after token-guarded cleanup, so callers that
       *  await success or failure always observe a non-loading final state.
       */
      triggerFetch: (
        key: string,
        forceFetch = false,
        request,
      ): Promise<void> => {
        const { setQueryState } = get();
        let queryState = get().queries[key];

        // On a forced refetch, abort any existing request for the same key.
        if (forceFetch && queryState?.abortController) {
          abortRuntimeRequest(
            runtime,
            queryState.abortController,
            logger,
            'abort superseded request',
          );
        } else if (queryState?.inFlightPromise) {
          // Deduplicate: if a request is already in progress, return its promise.
          return queryState.inFlightPromise;
        }

        // Re-read after potential abort to get current state.
        queryState = get().queries[key];
        const now = runtime.now();

        // Cache hit: data is fresh, avoid network request.
        if (
          !forceFetch &&
          queryState?.lastFetchTimestamp !== undefined &&
          !queryState.error &&
          cacheTTL > 0 &&
          now - queryState.lastFetchTimestamp < cacheTTL
        ) {
          if (refetchIntervalMs > 0) {
            setQueryState(key, (s) => {
              if (s.refetchTimerId !== undefined) {
                clearRuntimeTimeout(
                  runtime,
                  s.refetchTimerId,
                  logger,
                  'clear scheduled poll',
                );
              }
              return {
                ...s,
                refetchTimerId: scheduleNextPoll(key),
              };
            });
          }
          return Promise.resolve();
        }

        const requestDescriptor = request ?? queryState?.request;
        if (!requestDescriptor) {
          return Promise.reject(
            new Error('Cannot start a request without a request descriptor.'),
          );
        }

        // A manual/global refetch supersedes an already scheduled poll. Clear
        // the actual timer before the slot claim drops its id from state.
        if (queryState?.refetchTimerId !== undefined) {
          clearRuntimeTimeout(
            runtime,
            queryState.refetchTimerId,
            logger,
            'clear scheduled poll',
          );
        }

        // Create one controller and token for the entire retry cycle. A forced
        // refetch aborts this controller before atomically claiming a new slot.
        const controller = new AbortController();
        const {
          promise: fetchPromise,
          resolve: deferredResolve,
          reject: deferredReject,
        } = defer<void>();

        // A unique ownership token prevents a stale, superseded cycle from
        // clearing or overwriting the state of a newer active request.
        const inFlightToken = Symbol('inFlightToken');

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
          request: requestDescriptor,
        }));

        void executeFetchCycle(key, controller, inFlightToken)
          .then(deferredResolve, deferredReject)
          .catch((unexpectedError) => {
            runtime.reportInternalError(
              'launch fetch cycle',
              unexpectedError,
              logger,
            );
            deferredReject(unexpectedError);
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
        const now = runtime.now();
        Object.entries(queries).forEach(([key, queryState]) => {
          if (
            queryState.inFlightPromise ||
            queryState.lastFetchTimestamp === undefined ||
            queryState.error
          )
            return;
          if (now - queryState.lastFetchTimestamp > cacheTTL) {
            void triggerFetch(key, true).catch(noop);
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
        cleanupResources(queryToClear);

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
        const queries = Object.values(get().queries);
        try {
          queries.forEach(cleanupResources);
        } finally {
          set({ queries: {}, queryCount: 0, globalError: null });
        }
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
        const sweptAt = runtime.now();
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
            const hasSubscribers = subscriptionManager.hasSubscribers(key);
            const isInFlight = !!candidate.inFlightPromise; // active network work
            const hasTimer = candidate.refetchTimerId !== undefined; // actively polling
            const ageBase =
              candidate.lastSettledTimestamp ?? candidate.lastFetchTimestamp;
            const isStale =
              ageBase !== undefined && sweptAt - ageBase > gcGracePeriod;

            // Skip eviction if entry is active, polling, or not stale yet.
            if (hasSubscribers || isInFlight || hasTimer || !isStale) {
              if (logger.getLevel() <= logger.levels.DEBUG) {
                logger.debug('[GC] Skipped query eviction.', {
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
          cleanupResources(job);
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

  return { store, subscriptions: subscriptionManager, description };
};
