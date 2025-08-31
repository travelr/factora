/**
 * @fileoverview Integration tests for the global API store registry.
 * Verifies the complete workflow: initialization, registration, deregistration,
 * global actions (refetch/clear), and error handling.
 */
import {
  initializeApiRegistry,
  registerStoreActions,
  refetchAllStaleQueries,
  clearAllApiStores,
  StoreActions,
  _test_only_apiRegistry,
} from '@core/api-store-registry';

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mockLogger } from '@test-helper/test-helpers';

describe('API Registry Integration', () => {
  const createMockStore = (): StoreActions => ({
    refetchStaleQueries: vi.fn(),
    clearAllQueryStates: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    _test_only_apiRegistry?.clearRegistry();
    initializeApiRegistry({ logger: mockLogger });
  });

  /**
   * Verifies that a global action (`refetchAllStaleQueries`) correctly
   * propagates to every registered store and produces the expected log message.
   */
  test('Verifies global refetch correctly calls all registered stores', () => {
    const stores = [createMockStore(), createMockStore()];
    stores.forEach(registerStoreActions);

    refetchAllStaleQueries();

    stores.forEach((store) =>
      expect(store.refetchStaleQueries).toHaveBeenCalledTimes(1),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[API Registry] Window focus detected. Checking 2 store(s) for stale queries.',
    );
  });

  /**
   * Verifies that a global action (`clearAllApiStores`) correctly
   * propagates to every registered store and produces the expected log message.
   */
  test('Verifies global clear correctly calls all registered stores', () => {
    const stores = [createMockStore(), createMockStore()];
    stores.forEach(registerStoreActions);

    clearAllApiStores();

    stores.forEach((store) =>
      expect(store.clearAllQueryStates).toHaveBeenCalledTimes(1),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[API Registry] Clearing all data from 2 store(s).',
    );
  });

  /**
   * Verifies the complete lifecycle of a store. It ensures that the `unregister`
   * function effectively removes a store from the registry, preventing it from
   * being acted upon by subsequent global actions.
   */
  test('Verifies store deregistration correctly removes a store from global actions', () => {
    const storeToKeep = createMockStore();
    const storeToRemove = createMockStore();

    registerStoreActions(storeToKeep);
    const unregister = registerStoreActions(storeToRemove);

    // Initial state: both stores are called.
    clearAllApiStores();
    expect(storeToKeep.clearAllQueryStates).toHaveBeenCalledTimes(1);
    expect(storeToRemove.clearAllQueryStates).toHaveBeenCalledTimes(1);

    // Deregister the second store.
    unregister();

    // After deregistration: only the first store is called.
    clearAllApiStores();
    expect(storeToKeep.clearAllQueryStates).toHaveBeenCalledTimes(2);
    expect(storeToRemove.clearAllQueryStates).toHaveBeenCalledTimes(1); // No new call.
  });

  /**
   * This is a robustness test. It verifies that calling global actions when
   * no stores are registered does not cause crashes or produce unnecessary
   * log noise.
   */
  test('Verifies empty registry operations are handled gracefully without errors or logs', () => {
    refetchAllStaleQueries();
    clearAllApiStores();

    // The functions should simply return without logging or throwing.
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  /**
   * This is a critical resilience test. It proves that the registry is
   * fault-tolerant. If one store throws an error during a global action,
   * it should not prevent other stores from being processed, and the
   * error must be logged.
   */
  test('Verifies an error in one store operation does not stop the loop and is logged', () => {
    const erroringStore = createMockStore();
    const workingStore = createMockStore();
    const testError = new Error('Simulated store failure');

    (erroringStore.clearAllQueryStates as Mock).mockImplementation(() => {
      throw testError;
    });

    registerStoreActions(erroringStore);
    registerStoreActions(workingStore);

    clearAllApiStores();

    // Assert that the specific error was logged.
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[API Registry] An error occurred while a store was attempting to clear its state.',
      testError,
    );
    // Crucially, assert that the loop continued and the next store was still processed.
    expect(workingStore.clearAllQueryStates).toHaveBeenCalledTimes(1);
  });
});
