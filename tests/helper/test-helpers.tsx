/**
 * @fileoverview The primary, high-level helper for setting up API store tests.
 * It orchestrates lower-level utilities for async operations and mock data generation.
 */
import {
  __test_only_apiStores,
  createApiStoreCore,
  type KeyedApiState,
} from '@core/api-store-factory';
import * as GcRegistry from '@core/api-store-gc';
import type { FactoraDependencies, FactoraLogger } from '@/types/dependencies';
import type { ApiError, ErrorMapperContext } from '@/types/error';
import type { ApiStoreOptions } from '@/types/store';
import { getQueryKey } from '@utils/get-query-key';
import { act, cleanup, render, screen } from '@testing-library/react';
import { type Mock, vi } from 'vitest';
import type { StoreApi, UseBoundStore } from 'zustand';

import { DataConsumer } from '@test-helper/test-components';
import { flushPromises, waitFor } from './async-helpers';
import {
  createNonRetryableError,
  createRetryableError,
} from './error-generators';

// --- A. Test-local GC Registry & Spy ---

const testGcRegistry = new Set<any>();
let lastCapturedStoreRef: any = null;
const originalRegisterStoreForGc = GcRegistry.registerStoreForGc;

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

// --- B. Testable Store Factory & Setup ---

const mockErrorMapper = (
  error: unknown,
  context: ErrorMapperContext,
): ApiError => {
  const message = error instanceof Error ? error.message : String(error);
  const anyError = error as any;

  return {
    message,
    retryable: anyError.retryable,
    retryAfter: anyError.retryAfter,
    originalError: error,
    context,
  };
};

export const mockLogger: FactoraLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  getLevel: () => 0,
  levels: { DEBUG: 1 },
};

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
  testOpts: {
    exposeInternal?: boolean;
    dependencyOverrides?: Partial<FactoraDependencies<T>>;
  } = {},
) {
  const baseDependencies: FactoraDependencies<T> = {
    fetcher: fetchFn,
    errorMapper: mockErrorMapper,
    logger: mockLogger,
  };

  const dependencies = {
    ...baseDependencies,
    ...testOpts.dependencyOverrides,
  };

  const useApiQuery = createApiStoreCore<T>(dependencies, apiPathKey, options);

  // Add explicit type assertion for better type safety
  const internalStore = __test_only_apiStores.get(apiPathKey) as UseBoundStore<
    StoreApi<KeyedApiState<T>>
  >;

  if (!internalStore && apiPathKey) {
    throw new Error(
      `Test setup error: store with key "${apiPathKey}" was not found in the test registry.`,
    );
  }

  return {
    useApiQuery,
    logger: dependencies.logger,
    // Direct store access for test assertions
    getStoreState: () => internalStore?.getState(),

    // Direct method access bound to the store for safe, late execution
    clearAllQueryStates: () => internalStore?.getState().clearAllQueryStates(),
    clearStaleQueries: () => internalStore?.getState().clearStaleQueries(),
    clearQueryState: (key: string) =>
      internalStore?.getState().clearQueryState(key),
    refetchStaleQueries: () => internalStore?.getState().refetchStaleQueries(),
    setGlobalErrorState: (message: string) =>
      internalStore?.getState().setGlobalErrorState(message),
    getGlobalError: () => internalStore?.getState().globalError,

    // For advanced test scenarios
    getInternalStore: testOpts?.exposeInternal
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

type SetupApiTestResult<T> = ReturnType<typeof createTestableApiStore<T>> & {
  mockFetch: Mock<(...args: any[]) => Promise<any>>;
  key: string;
  rerender: (newParams?: Record<string, any>) => void;
  screen: typeof screen;
};

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
    key: getQueryKey(endpoint, params),
    rerender: (newParams: Record<string, any> = params) => {
      cleanup();
      render(
        <DataConsumer useApiQuery={testStore.useApiQuery} params={newParams} />,
      );
    },
    screen,
  };
};

// --- C. Test-only Utilities for Registry Inspection ---
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
