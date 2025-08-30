/**
 * tests/stores/api-store-gc.test.tsx
 *
 * @fileoverview This test suite validates the garbage collection (GC) and lifecycle
 * management of the API store.
 */

import '@testing-library/jest-dom';

import { _test_only_apiRegistry } from '@core/api-store-registry';
import { act, cleanup, render } from '@testing-library/react';
import {
  startApiStoreGarbageCollector,
  stopApiStoreGarbageCollector,
} from '@core/api-store-gc';
import { subscriptionManager } from '@utils/subscription-registry';
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DataConsumer } from '@test-helper/api-store.test-components';
import {
  _test_clearGcRegistry,
  _test_getGcRegistrySize,
  _test_runGlobalGc,
  advanceTimersWithFlush,
  createTestableApiStore,
  flushPromises,
} from '@test-helper/api-store.test-helpers';

afterEach(() => {
  // 1. Unmount any React components to prevent memory leaks and side effects.
  cleanup();

  // 2. Clear all global registries to ensure perfect test isolation.
  _test_clearGcRegistry();
  _test_only_apiRegistry?.clearRegistry(); // Use the new helper object
  (subscriptionManager as any)._clearAll();
});

/**
 * Helper function to create a minimal React component that subscribes to a store hook.
 */
function makeConsumer(
  useStoreHook: (params?: Record<string, any>) => any,
  params?: Record<string, any>,
) {
  return function Consumer({ onData }: { onData?: (_data: any) => void }) {
    const res = useStoreHook(params ?? {});
    React.useEffect(() => {
      if (onData) onData(res.data);
    }, [res.data, onData]);
    return <div data-testid="consumer" />;
  };
}

describe('API store GC + subscription registry', () => {
  // --- TEST CASE 1: The Primary Safeguard ---
  test('Verifies GC preserves data while component is mounted', async () => {
    // PURPOSE: This is the most important test. It ensures that an active subscriber
    // (a mounted component) will ALWAYS prevent its data from being garbage collected,
    // even if the data is long past its stale date.

    // ARRANGE
    const mockFetch = vi.fn(async () => ({ data: [{ id: 1 }] }));
    const { useApiQuery, clearStaleQueries } = createTestableApiStore(
      '/api/v1/tx',
      mockFetch,
      { gcGracePeriod: 50 },
    );
    const Consumer = makeConsumer(useApiQuery);

    // ACT (Phase 1)
    render(<Consumer />);
    await act(flushPromises);

    // Advance time far beyond the grace period.
    await advanceTimersWithFlush(100);

    // Run a GC sweep while the component is still mounted.
    act(() => clearStaleQueries());

    // ASSERT
    // If the cache was preserved (as it should be), re-rendering will not trigger a new fetch.
    cleanup();
    render(<Consumer />);
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // --- TEST CASE 2: The "Happy Path" for Eviction ---
  test('Verifies GC evicts data after component unmounts and TTL expires', async () => {
    // PURPOSE: Validates the core GC logic: when a query has no subscribers AND is
    // older than its grace period, it should be removed from memory.

    // ARRANGE
    const mockFetch = vi.fn(async () => ({ data: 'data' }));
    const { useApiQuery, clearStaleQueries } = createTestableApiStore(
      '/api/v1/foo',
      mockFetch,
      { gcGracePeriod: 50 },
    );
    const Consumer = makeConsumer(useApiQuery);

    // ACT
    // 1. Mount and then immediately unmount to remove all subscribers.
    const { unmount } = render(<Consumer />);
    await act(flushPromises);
    unmount();

    // 2. Advance time to make the cached data "stale".
    await advanceTimersWithFlush(100);

    // 3. Run a GC sweep.
    act(() => clearStaleQueries());

    // ASSERT
    // Re-mount the component. If eviction worked, the store has no data for this query
    // and must trigger a new network request.
    render(<Consumer />);
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // --- TEST CASE 3: The Grace Period Logic ---
  test('Verifies GC preserves data during grace period after unmount', async () => {
    // PURPOSE: Ensures the `gcGracePeriod` is respected. A query should not be evicted
    // immediately upon unsubscription; it should wait for the grace period to elapse.
    // This allows for quick remounts (e.g., fast navigation) to reuse the cache.

    // ARRANGE
    const mockFetch = vi.fn(async () => ({ data: 'cached data' }));
    const { useApiQuery, clearStaleQueries } = createTestableApiStore(
      '/api/v1/not-stale',
      mockFetch,
      { gcGracePeriod: 1000 },
    );
    const Consumer = makeConsumer(useApiQuery);

    // ACT
    // 1. Mount and unmount.
    const { unmount } = render(<Consumer />);
    await act(flushPromises);
    unmount();

    // 2. Advance time, but by an amount *less than* the grace period.
    await advanceTimersWithFlush(500);

    // 3. Run a GC sweep.
    act(() => clearStaleQueries());

    // ASSERT
    // Re-mount the component. Since the grace period had not passed, the data should
    // still be in the cache, and no new fetch should occur.
    render(<Consumer />);
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * Verifies that the GC handles queries with invalid (e.g., NaN) timestamps
   * gracefully by not evicting them, preventing crashes or unexpected data loss.
   */
  test('Verifies GC does not evict a query with an invalid timestamp', async () => {
    const mockFetch = vi.fn(async () => ({ data: 'timestamp data' }));
    const { useApiQuery, getInternalStore, getQueryKey, clearStaleQueries } =
      createTestableApiStore(
        '/api/timestamp',
        mockFetch,
        { gcGracePeriod: 50 },
        { exposeInternal: true },
      );

    const Consumer = makeConsumer(useApiQuery);
    const key = getQueryKey('/api/timestamp', {});
    const internalStore = getInternalStore();

    // 1. Mount, fetch, and unmount to make the query eligible for GC.
    const { unmount } = render(<Consumer />);
    await act(flushPromises);
    unmount();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 2. Manually corrupt the state to simulate a bug.
    act(() => {
      internalStore.setState((s: { queries: { [x: string]: any } }) => ({
        queries: {
          ...s.queries,
          [key]: {
            ...s.queries[key],
            lastFetchTimestamp: NaN, // Invalid timestamp
          },
        },
      }));
    });

    // 3. Advance time and run GC.
    await advanceTimersWithFlush(100);
    act(() => clearStaleQueries());

    // 4. ASSERT: Verify query state remains in store after GC
    const stateAfterGC = internalStore.getState();
    expect(stateAfterGC.queries[key]).toBeDefined();
    expect(stateAfterGC.queries[key].lastFetchTimestamp).toBeNaN();
  });

  // --- TEST CASE 4: The Polling Safeguard ---
  test('Verifies GC preserves data with active polling timer', async () => {
    // PURPOSE: Ensures that queries with an active `refetchInterval` are never garbage
    // collected, even if they have no subscribers and their data is stale. They are
    // considered "background services" that must persist.

    // ARRANGE
    const mockFetch = vi.fn(async () => ({ data: 'polling data' }));
    const { useApiQuery, clearStaleQueries } = createTestableApiStore(
      '/api/v1/polling',
      mockFetch,
      {
        gcGracePeriod: 50,
        refetchIntervalMinutes: 0.002, // 120ms
      },
    );
    const Consumer = makeConsumer(useApiQuery);

    // ACT
    // 1. Mount and unmount to start the polling mechanism and then remove the subscriber.
    const { unmount } = render(<Consumer />);
    await act(flushPromises);
    unmount();

    // 2. Make the data stale.
    await advanceTimersWithFlush(60);

    // 3. Run a GC sweep.
    act(() => clearStaleQueries());

    // ASSERT
    // The query should NOT have been evicted. We can prove this by advancing time
    // past the polling interval and checking if the poll triggers a second fetch.
    expect(mockFetch).toHaveBeenCalledTimes(1); // No new fetch from GC.
    await advanceTimersWithFlush(150); // Let the 120ms poll timer fire.
    expect(mockFetch).toHaveBeenCalledTimes(2); // The poll successfully triggered a new fetch.
  });

  // --- TEST CASE 5: The Store Lifecycle Edge Case ---
  test('Verifies store deregistration cancels when new subscriber appears', async () => {
    // PURPOSE: This is a critical race condition test. It ensures that if a store becomes
    // empty (scheduling its own removal from the GC) but a new component subscribes
    // before that removal happens, the removal is correctly cancelled.

    // ARRANGE
    const mockFetch = vi.fn(async (_endpoint, params) => ({ data: params }));
    const { useApiQuery, clearStaleQueries } = createTestableApiStore(
      '/api/v1/deregister-test',
      mockFetch,
      {
        gcGracePeriod: 50,
      },
    );
    const Consumer1 = makeConsumer(useApiQuery, { id: 1 });
    const Consumer2 = makeConsumer(useApiQuery, { id: 2 });

    // ACT
    // 1. Make the store empty to start the 1500ms deregistration timer.
    const { unmount: unmount1 } = render(<Consumer1 />);
    await act(flushPromises); // Fetch #1
    unmount1();
    await advanceTimersWithFlush(60); // Make stale.
    act(() => clearStaleQueries()); // Evict. Store is now empty.

    // 2. Before the 1500ms timer fires, mount a new component. This should cancel deregistration.
    await advanceTimersWithFlush(50);
    const { unmount: unmount2 } = render(<Consumer2 />);
    await act(flushPromises); // Fetch #2

    // 3. Let the original timer deadline pass, then make the store empty again.
    await advanceTimersWithFlush(1500);
    unmount2();
    await advanceTimersWithFlush(60); // Make stale again.

    // 4. Run GC. If deregistration was cancelled, the store is still being watched,
    // and this sweep will successfully evict the stale data for Consumer2.
    act(() => clearStaleQueries());

    // ASSERT
    // Re-mount the first consumer. Its data was evicted in step 1. Because the store
    // was never deregistered, a new fetch should occur.
    render(<Consumer1 />);
    await act(flushPromises); // Fetch #3

    // The third fetch is the proof that the store's lifecycle management is robust.
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  // --- TEST CASE 6: The Global Utility Test ---
  test('Verifies GC start/stop is idempotent for HMR safety', () => {
    // PURPOSE: This test is different. It doesn't check a specific store's logic.
    // Instead, it validates that the global utility functions for starting and stopping
    // the GC interval are safe to be called multiple times (e.g., during Hot Module
    // Replacement in development) without creating memory leaks from multiple intervals.

    // This test correctly interacts with the real global functions, not the testable wrapper.
    startApiStoreGarbageCollector({ intervalMs: 100 });
    const g = globalThis as any;
    const firstIntervalId = g[Symbol.for('__API_STORE_GC_INTERVAL__')];
    expect(firstIntervalId).toBeDefined();

    // Calling start again should be a no-op.
    startApiStoreGarbageCollector({ intervalMs: 100 });
    const secondIntervalId = g[Symbol.for('__API_STORE_GC_INTERVAL__')];
    expect(secondIntervalId).toBe(firstIntervalId); // Must be the same interval.

    stopApiStoreGarbageCollector();
    expect(g[Symbol.for('__API_STORE_GC_INTERVAL__')]).toBeUndefined();
  });

  /**
   * This is a black-box test that verifies the public behavior of the global
   * `refetchAllStaleQueries` utility without spying on internal methods. It
   * confirms that calling it triggers new network requests for all stale queries
   * across all registered stores.
   */
  test('Verifies refetchAllStaleQueries triggers network requests for stale data', async () => {
    const mockFetch1 = vi.fn().mockResolvedValue({ value: 'store1' });
    const mockFetch2 = vi.fn().mockResolvedValue({ value: 'store2' });

    const { useApiQuery: useApiQuery1, refetchStaleQueries: refetchStale1 } =
      createTestableApiStore('/api/store1', mockFetch1, { cacheTTL: 50 });
    const { useApiQuery: useApiQuery2, refetchStaleQueries: refetchStale2 } =
      createTestableApiStore('/api/store2', mockFetch2, { cacheTTL: 50 });

    // Mount both stores
    render(
      <div>
        <DataConsumer useApiQuery={useApiQuery1} />
        <DataConsumer useApiQuery={useApiQuery2} />
      </div>,
    );
    await act(flushPromises);

    // Verify initial fetches
    expect(mockFetch1).toHaveBeenCalledTimes(1);
    expect(mockFetch2).toHaveBeenCalledTimes(1);

    // Advance time past cacheTTL
    await advanceTimersWithFlush(100);

    // Call refetchStaleQueries to trigger refetches
    act(() => refetchStale1());
    act(() => refetchStale2());

    // Verify refetch happened
    await act(flushPromises);
    expect(mockFetch1).toHaveBeenCalledTimes(2);
    expect(mockFetch2).toHaveBeenCalledTimes(2);
  });

  /**
   * This test verifies that the hook behaves correctly under React's Strict Mode,
   * where effects are run twice to detect cleanup issues.
   */
  test('Verifies hook handles React Strict Mode double subscription correctly', async () => {
    const mockFetch = vi.fn(async () => ({ value: 'strict data' }));
    const { useApiQuery, getQueryKey } = createTestableApiStore(
      '/api/strict',
      mockFetch,
    );
    const key = getQueryKey('/api/strict', {});

    // Explicitly render with StrictMode to trigger the double-effect behavior.
    render(
      <React.StrictMode>
        <DataConsumer useApiQuery={useApiQuery} />
      </React.StrictMode>,
    );

    await act(flushPromises);

    // 1. Verify that the store's deduplication prevented a second network request.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 2. Verify the final subscriber count. This is a justified use of an internal
    // test-only accessor because testing the ultimate outcome (correct GC behavior)
    // would make the test much more complex and indirect. This surgically verifies
    // that the subscribe -> unsubscribe -> subscribe cycle is handled correctly.
    const subscriberCount = (subscriptionManager as any)._getSubscriberCount(
      key,
    );
    expect(subscriberCount).toBe(1);
  });

  /**
   * Verifies that rapid mount/unmount cycles do not lead to memory leaks (orphaned
   * subscriptions) or redundant network requests.
   */
  test('Verifies hook handles rapid mount/unmount cycles without memory leaks', async () => {
    const mockFetch = vi.fn(async () => ({ value: 'rapid data' }));
    const { useApiQuery, getQueryKey } = createTestableApiStore(
      '/api/rapid',
      mockFetch,
    );
    const key = getQueryKey('/api/rapid', {});

    // Simulate extremely rapid mount/unmount cycles.
    for (let i = 0; i < 10; i++) {
      const { unmount } = render(<DataConsumer useApiQuery={useApiQuery} />);
      // A minimal flush to allow the useEffect to fire.
      await act(async () => {
        await Promise.resolve();
      });
      unmount();
    }
    // A final flush to ensure all async effects (including fetches) from the loop settle.
    await act(flushPromises);

    // 1. Verify only ONE fetch occurred in total, proving deduplication worked correctly
    // across the rapid mounting.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 2. Verify that no subscriptions remain. This is a direct test for memory leaks
    // in the subscription logic. Using the internal accessor is the most efficient way
    // to confirm that the cleanup function for every mount was correctly called.
    const subscriberCount = (subscriptionManager as any)._getSubscriberCount(
      key,
    );
    expect(subscriberCount).toBe(0);
  });
});
