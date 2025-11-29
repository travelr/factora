/**
 * @fileoverview This test suite validates the garbage collection (GC) and lifecycle
 * management of the API store.
 */
import '@testing-library/jest-dom';
import { _test_only_apiRegistry } from '@core/api-store-registry';
import { act, cleanup, render } from '@testing-library/react';
import {
  registerStoreForGc,
  startApiStoreGarbageCollector,
  stopApiStoreGarbageCollector,
} from '@core/api-store-gc';
import { subscriptionManager } from '@utils/subscription-registry';
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DataConsumer } from '@test-helper/test-components';
import {
  _test_clearGcRegistry,
  _test_getGcRegistrySize,
  createTestableApiStore,
} from '@test-helper/test-helpers';
import {
  flushPromises,
  advanceTimersWithFlush,
} from '@test-helper/async-helpers';

afterEach(() => {
  // Stop any running global garbage collector to ensure test isolation.
  stopApiStoreGarbageCollector();

  // Unmount components and clear all global registries.
  cleanup();
  _test_clearGcRegistry();
  _test_only_apiRegistry?.clearRegistry();
  (subscriptionManager as any)._clearAll();
});

/**
 * Creates a minimal React component that subscribes to a given store hook.
 * This is a lightweight helper for testing mount and unmount behavior.
 */
function createSubscriptionComponent(
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
  /**
   * This is the primary safeguard test. It ensures an active component subscription
   * will always prevent its data from being garbage collected, even if the data
   * is long past its stale date.
   */
  test('Verifies GC preserves data while a component is mounted', async () => {
    const mockFetch = vi.fn(async () => ({ data: [{ id: 1 }] }));
    const { useApiQuery, clearStaleQueries } = createTestableApiStore(
      '/api/v1/tx',
      mockFetch,
      { gcGracePeriod: 50 },
    );
    const Consumer = createSubscriptionComponent(useApiQuery);

    render(<Consumer />);
    await act(flushPromises);

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

  /**
   * Validates the core GC logic for the grace period after a component unmounts.
   */
  test.each([
    {
      description: 'preserves data within the grace period',
      advanceTime: 500,
      expectedFetches: 1,
      gcGracePeriod: 1000,
    },
    {
      description: 'evicts data after the grace period expires',
      advanceTime: 100,
      expectedFetches: 2,
      gcGracePeriod: 50,
    },
  ])('Verifies GC $description', async ({ expectedFetches, gcGracePeriod }) => {
    const mockFetch = vi.fn(async () => ({ data: 'data' }));
    const { useApiQuery, clearStaleQueries } = createTestableApiStore(
      '/api/v1/test',
      mockFetch,
      { gcGracePeriod },
    );
    const Consumer = createSubscriptionComponent(useApiQuery);

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
    expect(mockFetch).toHaveBeenCalledTimes(expectedFetches);
  });

  /**
   * Verifies that the GC handles corrupted state gracefully by not evicting
   * queries with an invalid timestamp, preventing unexpected crashes.
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
    const Consumer = createSubscriptionComponent(useApiQuery);
    const key = getQueryKey('/api/timestamp', {});
    const internalStore = getInternalStore();

    const { unmount } = render(<Consumer />);
    await act(flushPromises);
    unmount();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Manually corrupt the state's timestamp to simulate a bug.
    act(() => {
      internalStore.setState((s: { queries: { [x: string]: any } }) => ({
        queries: {
          ...s.queries,
          [key]: { ...s.queries[key], lastFetchTimestamp: NaN },
        },
      }));
    });

    await advanceTimersWithFlush(100);
    act(() => clearStaleQueries());

    // ASSERT: The corrupted query state should remain in the store after the GC sweep.
    const stateAfterGC = internalStore.getState();
    expect(stateAfterGC.queries[key]).toBeDefined();
    expect(stateAfterGC.queries[key].lastFetchTimestamp).toBeNaN();
  });

  /**
   * Ensures that queries with an active refetchInterval are treated like background
   * services and are never garbage collected, even with no active subscribers.
   */
  test('Verifies GC preserves data for a query with an active polling timer', async () => {
    const mockFetch = vi.fn(async () => ({ data: 'polling data' }));
    const { useApiQuery, clearStaleQueries } = createTestableApiStore(
      '/api/v1/polling',
      mockFetch,
      { gcGracePeriod: 50, refetchIntervalMinutes: 0.002 }, // 120ms
    );
    const Consumer = createSubscriptionComponent(useApiQuery);

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

  /**
   * This is a critical race condition test. It ensures that if a store becomes
   * eligible for deregistration, but a new component subscribes before that
   * happens, the deregistration is correctly cancelled.
   */
  test('Verifies store deregistration is cancelled when a new subscriber appears', async () => {
    const mockFetch = vi.fn(async (_endpoint, params) => ({ data: params }));
    const { useApiQuery, clearStaleQueries } = createTestableApiStore(
      '/api/v1/deregister-test',
      mockFetch,
      { gcGracePeriod: 50 },
    );
    const Consumer1 = createSubscriptionComponent(useApiQuery, { id: 1 });
    const Consumer2 = createSubscriptionComponent(useApiQuery, { id: 2 });

    /**
     * Phase 1: Evict all queries to make the store empty, starting the
     * deregistration timer.
     */
    const { unmount: unmount1 } = render(<Consumer1 />);
    await act(flushPromises); // Fetch #1
    unmount1();
    await advanceTimersWithFlush(60);
    act(() => clearStaleQueries());

    /**
     * Phase 2: Before the deregistration timer fires, mount a new component,
     * which should cancel the pending deregistration.
     */
    await advanceTimersWithFlush(50);
    const { unmount: unmount2 } = render(<Consumer2 />);
    await act(flushPromises); // Fetch #2

    /**
     * Phase 3: Let the original timer deadline pass, then make the store empty again.
     */
    await advanceTimersWithFlush(1500);
    unmount2();
    await advanceTimersWithFlush(60);
    act(() => clearStaleQueries());

    /**
     * Phase 4: Verify the store remains active by re-subscribing.
     * A new fetch proves the store was never deregistered.
     */
    render(<Consumer1 />);
    await act(flushPromises); // Fetch #3
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  /**
   * Verifies that the per-store `refetchStaleQueries` utility correctly
   * triggers network requests for all stale data within that store.
   */
  test('Verifies refetchStaleQueries triggers network requests for stale data', async () => {
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
   * Verifies that the hook correctly handles React's Strict Mode, where effects
   * are run twice to detect cleanup issues, without causing duplicate fetches
   * or incorrect subscription counts.
   */
  test('Verifies the hook handles React Strict Mode correctly', async () => {
    const mockFetch = vi.fn(async () => ({ value: 'strict data' }));
    const { useApiQuery, getQueryKey } = createTestableApiStore(
      '/api/strict',
      mockFetch,
    );
    const key = getQueryKey('/api/strict', {});

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
   * This stress test Verifies that rapid mount/unmount cycles do not lead to
   * memory leaks (orphaned subscriptions) or redundant network requests.
   */
  test('Verifies rapid mount/unmount cycles do not cause memory leaks', async () => {
    const mockFetch = vi.fn(async () => ({ value: 'rapid data' }));
    const { useApiQuery, getQueryKey } = createTestableApiStore(
      '/api/rapid',
      mockFetch,
    );
    const key = getQueryKey('/api/rapid', {});

    // Simulate extremely rapid mount/unmount cycles.
    for (let i = 0; i < 10; i++) {
      const { unmount } = render(<DataConsumer useApiQuery={useApiQuery} />);
      await act(async () => await Promise.resolve());
      unmount();
    }
    // A final flush to ensure all async effects (including fetches) from the loop settle.
    await act(flushPromises);

    // ASSERT: Only ONE fetch occurred, proving deduplication worked correctly.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // ASSERT: No subscriptions remain, proving no memory leaks.
    const subscriberCount = (subscriptionManager as any)._getSubscriberCount(
      key,
    );
    expect(subscriberCount).toBe(0);
  });

  /**
   * Ensures the global garbage collector correctly invokes the cleanup
   * method on all stores that are registered with it.
   */
  test('Verifies the GC sweep calls clearStaleQueries on all registered stores', async () => {
    const mockStore1 = { clearStaleQueries: vi.fn() };
    const mockStore2 = { clearStaleQueries: vi.fn() };
    registerStoreForGc(mockStore1);
    registerStoreForGc(mockStore2);

    startApiStoreGarbageCollector({ intervalMs: 100 });
    await advanceTimersWithFlush(150);

    expect(mockStore1.clearStaleQueries).toHaveBeenCalledTimes(1);
    expect(mockStore2.clearStaleQueries).toHaveBeenCalledTimes(1);
  });

  /**
   * Ensures that if a store is manually deregistered from the GC, its cleanup
   * method will not be called during the next sweep.
   */
  test('Verifies the GC does not call a store that deregisters before a sweep', async () => {
    const mockStore = { clearStaleQueries: vi.fn() };
    const deregister = registerStoreForGc(mockStore);
    startApiStoreGarbageCollector({ intervalMs: 100 });

    deregister();
    await advanceTimersWithFlush(150);

    expect(mockStore.clearStaleQueries).not.toHaveBeenCalled();
  });

  describe('Global GC Utilities (start/stop)', () => {
    /**
     * Validates that the global GC start/stop utilities are idempotent and clean
     * up timers correctly. This is critical for environments with Hot Module
     * Replacement (HMR) to prevent multiple intervals from running.
     */
    test('Verifies the global start/stop utilities are idempotent and clean up correctly', () => {
      const g = globalThis as any;
      const gcSymbol = Symbol.for('__API_STORE_GC_INTERVAL__');

      // ASSERT: Initial state is clean, thanks to afterEach cleanup.
      expect(vi.getTimerCount()).toBe(0);
      expect(g[gcSymbol]).toBeUndefined();

      // Start once, expect one timer.
      startApiStoreGarbageCollector({ intervalMs: 100 });
      expect(vi.getTimerCount()).toBe(1);
      const firstIntervalId = g[gcSymbol];
      expect(firstIntervalId).toBeDefined();

      // Start again, expect no change.
      startApiStoreGarbageCollector({ intervalMs: 100 });
      expect(vi.getTimerCount()).toBe(1);
      expect(g[gcSymbol]).toBe(firstIntervalId);

      // Stop multiple times, should not throw and should result in a clean state.
      stopApiStoreGarbageCollector();
      stopApiStoreGarbageCollector();
      expect(vi.getTimerCount()).toBe(0);
      expect(g[gcSymbol]).toBeUndefined();
    });
  });

  test('Verifies polling stops and query is GCed when subscribers unmount (Zombie Polling Fix)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ value: 'polled' });
    const { useApiQuery, getInternalStore, getQueryKey, clearStaleQueries } =
      createTestableApiStore(
        '/api/zombie-poll',
        mockFetch,
        {
          refetchIntervalMinutes: 0.001, // ~60ms polling interval
          gcGracePeriod: 100, // 100ms grace period
        },
        { exposeInternal: true },
      );

    const key = getQueryKey('/api/zombie-poll', {});
    const internalStore = getInternalStore();

    // 1. Mount: This initiates the first fetch and starts the polling timer.
    const { unmount } = render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 2. Unmount: The subscriber count drops to 0.
    // Ideally, this should signal the store that polling is no longer needed.
    unmount();

    // 3. Wait: Advance time past both the polling interval and the GC grace period.
    // In the buggy state, the polling timer keeps firing and re-scheduling itself here.
    await advanceTimersWithFlush(200);

    // 4. GC Sweep: Attempt to clean up stale queries.
    act(() => clearStaleQueries());

    // 5. Assert: The query should be completely removed from the store.
    expect(internalStore.getState().queries[key]).toBeUndefined();
  });

  test('Verifies deregistration timer is reset on activity (Deregistration Race Fix)', async () => {
    // 1. Setup a store
    const mockFetch = vi.fn().mockResolvedValue({ value: 'data' });
    const { useApiQuery } = createTestableApiStore(
      '/api/race-deregister',
      mockFetch,
    );
    const Consumer = createSubscriptionComponent(useApiQuery);

    // Initial state: Registered
    const { unmount: unmount1 } = render(<Consumer />);
    await act(flushPromises);
    // Confirm it's tracked by GC
    expect(_test_getGcRegistrySize()).toBe(1);

    // 2. Trigger first idle (Starts 1500ms internal timer)
    unmount1();

    // 3. Wait 500ms (1000ms remaining on first timer)
    await advanceTimersWithFlush(500);

    // 4. Interruption: Become active again, then idle again immediately.
    // IN A BUGGY STORE: This does NOT cancel the old timer.
    // IN A FIXED STORE: This cancels the old timer and starts a new 1500ms timer.
    const { unmount: unmount2 } = render(<Consumer />);
    await act(flushPromises);
    unmount2();

    // 5. Wait 1100ms.
    // Total time since first idle: 1600ms (Old timer would have fired).
    // Time since second idle: 1100ms (New timer should NOT have fired).
    await advanceTimersWithFlush(1100);

    // 6. Assert
    // The store is still waiting for the second timer
    expect(_test_getGcRegistrySize()).toBe(1);
  });
});
