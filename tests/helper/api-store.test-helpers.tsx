// tests/stores/api-store.test-helpers.tsx
import {
  __test_only_apiStores,
  type ApiStoreOptions,
  createApiStore,
  type KeyedApiState,
} from '@core/api-store-factory';
import { act, cleanup, render, screen } from '@testing-library/react';
import { getQueryKey } from '@utils/get-query-key';
import * as GcRegistry from '@utils/api-store-gc';
import { type Mock, vi } from 'vitest';
import type { StoreApi, UseBoundStore } from 'zustand';

import { DataConsumer } from '@test-helper/api-store.test-components';

// Define a proper interface for Vitest with optional async method
interface Vitest {
  advanceTimersByTime(ms: number): void;
  advanceTimersByTimeAsync?(ms: number): Promise<void>;
}

// --- A. Test-local GC Registry & Spy ---

const testGcRegistry = new Set<any>();
let lastCapturedStoreRef: any = null;
const originalRegisterStoreForGc = GcRegistry.registerStoreForGc;

// First, we capture the original function before we spy on it.
vi.spyOn(GcRegistry, 'registerStoreForGc').mockImplementation(
  (storeInstance: any) => {
    lastCapturedStoreRef = storeInstance;
    testGcRegistry.add(storeInstance);
    const realDeregister = originalRegisterStoreForGc(storeInstance);

    return () => {
      realDeregister();
      testGcRegistry.delete(storeInstance);
      if (lastCapturedStoreRef === storeInstance) {
        lastCapturedStoreRef = null;
      }
    };
  },
);

// --- B. Hardened Async Helpers ---

/**
 * Robustly flush the microtask queue.
 * IMPORTANT: Do NOT use `setTimeout(0)` or `setImmediate` here, as that can
 * deadlock the test runner when fake timers are enabled. This microtask-only
 * flush is the correct way to ensure promise jobs and React updates settle.
 */
export const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve(); // A second flush handles promises queued by other promises.
};

/**
 * Canonical helper for advancing time in tests.
 * It combines the async-friendly timer advance with a promise flush.
 */
export const advanceTimersWithFlush = async (ms: number): Promise<void> => {
  await act(async () => {
    // Cast once to our proper interface
    const vitest = vi as unknown as Vitest;

    if (vitest.advanceTimersByTimeAsync) {
      await vitest.advanceTimersByTimeAsync(ms);
    } else {
      vitest.advanceTimersByTime(ms);
    }
  });
  await act(flushPromises);
};

/**
 * Waits for an async condition to be met with precise timing control.
 * @param callback - Function that returns true when condition is met
 * @param options - Configuration for timeout and polling
 * @returns Promise that resolves when condition is met
 */
const waitFor = async (
  callback: () => boolean,
  {
    timeout,
    interval,
    onTimeout,
  }: { timeout: number; interval: number; onTimeout: () => string },
) => {
  const startTime = Date.now();
  while (!callback()) {
    if (Date.now() - startTime > timeout) {
      throw new Error(onTimeout());
    }
    // Correctly use the robust, canonical helper for advancing time.
    await flushPromises();
    await advanceTimersWithFlush(interval);
  }
};

// --- C. Testable Store Factory & Setup ---

/**
 * Creates a testable instance of the API store and its hook, providing a rich
 * set of helpers for robust testing.
 */
export function createTestableApiStore<T>(
  apiPathKey: string,
  fetchFn: (
    endpoint: string,
    params: Record<string, any>,
    signal?: AbortSignal,
  ) => Promise<T>,
  options: ApiStoreOptions = {},
  opts?: { exposeInternal?: boolean },
) {
  const useApiQuery = createApiStore<T>(apiPathKey, fetchFn, options);
  // Add explicit type assertion for better type safety
  const internalStore = __test_only_apiStores.get(apiPathKey) as UseBoundStore<
    StoreApi<KeyedApiState<T>>
  >;

  if (!internalStore) {
    throw new Error(
      `Test setup error: store with key "${apiPathKey}" was not found in the test registry.`,
    );
  }

  return {
    useApiQuery,
    // Direct store access for test assertions
    getStoreState: () => internalStore.getState(),

    // Direct method access bound to the store for safe, late execution
    clearAllQueryStates: () => internalStore.getState().clearAllQueryStates(),
    clearStaleQueries: () => internalStore.getState().clearStaleQueries(),
    clearQueryState: (key: string) =>
      internalStore.getState().clearQueryState(key),
    refetchStaleQueries: () => internalStore.getState().refetchStaleQueries(),
    setGlobalErrorState: (message: string) =>
      internalStore.getState().setGlobalErrorState(message),
    getGlobalError: () => internalStore.getState().globalError,

    // For advanced test scenarios
    getInternalStore: opts?.exposeInternal
      ? () => internalStore
      : (undefined as any),
    getQueryKey,

    /**
     * Waits for this specific store's state to reach a desired condition.
     */
    waitForStoreState: async (
      predicate: (state: KeyedApiState<T>) => boolean,
      timeout = 500, // A more generous default for complex state transitions
    ) => {
      await waitFor(() => predicate(internalStore.getState()), {
        timeout,
        interval: 10,
        onTimeout: () =>
          `waitForStoreState timed out. Current state: ${JSON.stringify(
            internalStore.getState(),
          )}`,
      });
    },
  };
}

// --- Define the explicit return type for setupApiTest to prevent inference errors ---
type SetupApiTestResult<T> = ReturnType<typeof createTestableApiStore<T>> & {
  mockFetch: Mock<(...args: any[]) => Promise<any>>;
  key: string;
  rerender: (newParams?: Record<string, any>) => void;
  screen: typeof screen;
};

/**
 * Centralized test setup function that eliminates boilerplate.
 * Handles fetch mocking, component rendering, and common setup patterns.
 */
export const setupApiTest = async <T,>(
  endpoint: string,
  options: ApiStoreOptions = {},
  {
    response = { value: 'test data' },
    status = 'success',
    retryAfter,
    params = {},
  }: {
    response?: any;
    status?: 'success' | 'retryable-error' | 'non-retryable-error';
    retryAfter?: number;
    params?: Record<string, any>;
  } = {},
): Promise<SetupApiTestResult<T>> => {
  const mockFetch = vi.fn();

  if (status === 'success') {
    mockFetch.mockResolvedValue(response);
  } else if (status === 'retryable-error') {
    mockFetch.mockRejectedValue(createRetryableError('Error', retryAfter));
  } else {
    mockFetch.mockRejectedValue(createNonRetryableError('Error'));
  }

  const testStore = createTestableApiStore<T>(endpoint, mockFetch, options, {
    exposeInternal: true,
  });

  render(<DataConsumer useApiQuery={testStore.useApiQuery} params={params} />);
  await act(flushPromises);

  return {
    ...testStore,
    mockFetch,
    key: testStore.getQueryKey(endpoint, params),
    rerender: (newParams: Record<string, any> = params) => {
      cleanup();
      render(
        <DataConsumer useApiQuery={testStore.useApiQuery} params={newParams} />,
      );
    },
    screen,
  };
};

// --- D. Error Generation Helpers ---

export const createRetryableError = (
  message: string,
  retryAfterMs?: number,
) => {
  const error: any = new Error(message);
  error.isAxiosError = true;
  error.code = 'ERR_NETWORK';
  error.response = {
    status: 429,
    headers: retryAfterMs ? { 'retry-after': String(retryAfterMs / 1000) } : {},
  };
  return error;
};

export const createNonRetryableError = (message: string) => {
  const error: any = new Error(message);
  error.retryable = false;
  error.isAbort = false;
  return error;
};

// --- E. Test-only Utilities for Registry Inspection ---

export const _test_getGcRegistrySize = (): number => testGcRegistry.size;

export const _test_clearGcRegistry = (): void => {
  testGcRegistry.clear();
  lastCapturedStoreRef = null;
};

/**
 * Simulates a global GC sweep by iterating over all stores captured by our
 * test spy and calling their `clearStaleQueries` method.
 */
export const _test_runGlobalGc = (): void => {
  testGcRegistry.forEach((storeInstance) => {
    // Each store instance registered for GC has this method.
    storeInstance.clearStaleQueries();
  });
};
