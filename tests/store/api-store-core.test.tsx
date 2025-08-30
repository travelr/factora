import { KeyedApiState } from '@core/api-store-factory';
import { act, cleanup, render, screen } from '@testing-library/react';
import log from 'loglevel';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DataConsumer } from '@test-helper/api-store.test-components';
import {
  _test_clearGcRegistry,
  advanceTimersWithFlush,
  createRetryableError,
  createTestableApiStore,
  flushPromises,
  setupApiTest,
} from '@test-helper/api-store.test-helpers';

// The global setup in `vitest.setup.ts` handles generic timer and mock management.

afterEach(() => {
  // 1. Unmount any React components to prevent memory leaks and side effects.
  cleanup();
  // 2. Clear our test-local GC registry to ensure test isolation.
  _test_clearGcRegistry();
});

describe('API store core functionality', () => {
  /**
   * Validates that data is served from the cache on a subsequent mount
   * if the cache's Time-To-Live (TTL) has not expired.
   */
  test('Verifies cache is preserved when component remounts within TTL', async () => {
    const { mockFetch, useApiQuery } = await setupApiTest('/api/test', {
      cacheTTL: 200,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Unmount and remount the component.
    cleanup();
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    // Since we are within the 200ms cacheTTL, the fetch should not be called again.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('data').textContent).toBe(
      '{"value":"test data"}',
    );
  });

  /**
   * Ensures that if multiple components subscribe to the same query simultaneously,
   * only one underlying API request is made to prevent redundant network calls.
   */
  test('Verifies only one fetch occurs for concurrent subscribers', async () => {
    const mockFetch = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ value: 'shared' }), 50),
        ),
    );
    const { useApiQuery } = createTestableApiStore('/api/dedup', mockFetch);

    // Render two consumers for the same query at the same time.
    render(
      <div>
        <DataConsumer useApiQuery={useApiQuery} />
        <DataConsumer useApiQuery={useApiQuery} />
      </div>,
    );
    await advanceTimersWithFlush(100);

    // The store should recognize the concurrent requests and only fire the fetch once.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('data')[0].textContent).toBe(
      '{"value":"shared"}',
    );
  });

  /**
   * Verifies that the `refetchInterval` option correctly triggers a background
   * data refetch after the specified time has elapsed.
   */
  test('Verifies polling interval correctly triggers background refetch', async () => {
    const refetchIntervalSeconds = 6;
    const { mockFetch } = await setupApiTest('/api/polling', {
      refetchIntervalMinutes: refetchIntervalSeconds / 60,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance time to just before the next poll; no new fetch should occur.
    await advanceTimersWithFlush(refetchIntervalSeconds * 1000 - 1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance time past the interval to trigger the polling fetch.
    await advanceTimersWithFlush(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  /**
   * Checks that a manual refetch on a stale query (data older than its TTL)
   * correctly triggers a new network request.
   */
  test('Verifies manual refetch triggers new request for stale data', async () => {
    const { mockFetch, screen: localScreen } = await setupApiTest(
      '/api/stale',
      {
        cacheTTL: 50,
      },
    );

    // Make the data stale by advancing time past its TTL.
    await advanceTimersWithFlush(100);

    act(() => localScreen.getByTestId('refetch-button').click());
    await act(flushPromises);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(localScreen.getByTestId('data').textContent).toBe(
      '{"value":"test data"}',
    );
  });

  /**
   * Verifies the cache boundary condition: a new fetch occurs exactly at TTL expiration.
   * The cache check is `now - lastFetchTimestamp < cacheTTL`, so when the difference
   * is exactly `cacheTTL`, the condition is false and the data is considered stale.
   */
  test('Verifies cache TTL boundary condition: fetch occurs at TTL expiration', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ value: 'boundary data' });
    const cacheTTL = 100;
    const { useApiQuery } = createTestableApiStore('/api/boundary', mockFetch, {
      cacheTTL,
    });

    // 1. Initial render and fetch.
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 2. Unmount and advance time to EXACTLY the cache TTL boundary.
    cleanup();
    await advanceTimersWithFlush(cacheTTL);

    // 3. Remount. A new fetch should occur because the data is now stale.
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  /**
   * This black-box test verifies that queries are isolated. Unmounting a component
   * for one query should not impact the state or behavior of another, active query.
   */
  test('Verifies unmounting one query component does not affect a separate, active query', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ value: 'count data' });
    const { useApiQuery } = createTestableApiStore('/api/count', mockFetch);

    const { unmount: unmount1 } = render(
      <DataConsumer useApiQuery={useApiQuery} params={{ id: 1 }} />,
    );
    await act(flushPromises);
    render(<DataConsumer useApiQuery={useApiQuery} params={{ id: 2 }} />);
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(2); // Two different queries, two fetches.

    // Unmounting the first consumer should make it eligible for garbage collection,
    // but it should not trigger any fetches or state changes in the second query.
    unmount1();
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(2); // No new fetch should be triggered.
  });

  /**
   * Confirms that calling the `clear` function from the hook correctly cleans up
   * resources, such as cancelling any pending polling timers.
   */
  test('Verifies clearQueryState properly cleans up resources', async () => {
    const { mockFetch, screen: localScreen } = await setupApiTest(
      '/api/cleanup',
      {
        refetchIntervalMinutes: 0.1, // 6 seconds
      },
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);

    act(() => localScreen.getByTestId('clear-button').click());
    await advanceTimersWithFlush(7000);

    // Because the query was cleared, the polling timer should have been destroyed.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * Ensures that multiple independent stores created from the factory can coexist
   * and that their actions (like `refetch`) do not interfere with one another.
   */
  test('Verifies multiple stores operate without interference', async () => {
    const mockFetch1 = vi.fn().mockResolvedValue({ value: 'store1' });
    const mockFetch2 = vi.fn().mockResolvedValue({ value: 'store2' });
    const { useApiQuery: useApiQuery1 } = createTestableApiStore(
      '/api/store1',
      mockFetch1,
    );
    const { useApiQuery: useApiQuery2 } = createTestableApiStore(
      '/api/store2',
      mockFetch2,
    );

    render(
      <div>
        <DataConsumer useApiQuery={useApiQuery1} />
        <DataConsumer useApiQuery={useApiQuery2} />
      </div>,
    );
    await act(flushPromises);
    expect(mockFetch1).toHaveBeenCalledTimes(1);
    expect(mockFetch2).toHaveBeenCalledTimes(1);

    act(() => {
      screen.getAllByTestId('refetch-button')[0].click();
      screen.getAllByTestId('refetch-button')[1].click();
    });
    await act(flushPromises);

    expect(mockFetch1).toHaveBeenCalledTimes(2);
    expect(mockFetch2).toHaveBeenCalledTimes(2);
  });

  /**
   * Validates that the static `clearAll` method on the hook successfully
   * removes all query data from its specific store instance, forcing new
   * fetches on subsequent mounts.
   */
  test('Verifies clearAll() completely resets store state', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ value: 'data' });
    const { useApiQuery, clearAllQueryStates } = createTestableApiStore(
      '/api/multi-clear',
      mockFetch,
      { cacheTTL: 1000 },
    );

    // Create two distinct queries in the store's state.
    render(<DataConsumer useApiQuery={useApiQuery} params={{ id: 1 }} />);
    await act(flushPromises);
    render(<DataConsumer useApiQuery={useApiQuery} params={{ id: 2 }} />);
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Clear all queries from this specific store.
    act(() => {
      clearAllQueryStates();
    });

    // To verify the clear was successful, we remount both consumers.
    // If the cache was cleared, they must trigger new fetches.
    cleanup();
    render(<DataConsumer useApiQuery={useApiQuery} params={{ id: 1 }} />);
    await act(flushPromises);
    render(<DataConsumer useApiQuery={useApiQuery} params={{ id: 2 }} />);
    await act(flushPromises);

    // The fetch count increasing proves the cache was successfully cleared for all queries.
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  /**
   * Verifies that the store's global error state can be set and read
   * via the public API, and that this error can be rendered by a consumer.
   */
  test('Verifies getGlobalError() correctly retrieves the global error state', () => {
    const { setGlobalErrorState, getGlobalError } = createTestableApiStore(
      '/api/global-error',
      async () => ({}),
    );

    // Set a global error directly via the test helper.
    act(() => setGlobalErrorState('A critical global error occurred'));
    const globalError = getGlobalError();

    // Verify the structure of the returned error object is correct.
    expect(globalError).toEqual({
      message: 'A critical global error occurred',
      retryable: false,
    });

    // Verify that a component can correctly render this global error state.
    render(
      <DataConsumer
        useApiQuery={() => ({
          data: null,
          loading: false,
          error: globalError,
          refetch: () => {},
          clear: () => {},
        })}
      />,
    );
    expect(screen.getByTestId('error')).toHaveTextContent(
      'A critical global error occurred',
    );
  });

  /**
   * Validates the edge case where caching is explicitly disabled via `cacheTTL: 0`.
   * Ensures that every mount and every refetch triggers a new network request.
   */
  test('Verifies cacheTTL: 0 disables caching as expected', async () => {
    const {
      mockFetch,
      useApiQuery,
      screen: localScreen,
    } = await setupApiTest('/api/no-cache', {
      cacheTTL: 0,
    });

    // First mount should trigger a fetch.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Unmount and remount should trigger a second fetch.
    cleanup();
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // A manual refetch should trigger a third fetch.
    act(() => localScreen.getByTestId('refetch-button').click());
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  /**
   * Verifies that the `clearQueryState` function is robust and will still remove a
   * query from the store even if an error occurs during resource cleanup (e.g.,
   * if `abortController.abort()` throws an error).
   */
  test('Verifies clearQueryState handles errors during resource cleanup gracefully', async () => {
    // Suppress expected console errors from this test for cleaner output.
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});

    const { useApiQuery, getInternalStore, clearQueryState, getQueryKey } =
      createTestableApiStore(
        '/api/cleanup-error',
        vi.fn(() => new Promise(() => {})), // A fetch that never resolves
        {},
        { exposeInternal: true },
      );

    const key = getQueryKey('/api/cleanup-error', {});
    const internalStore = getInternalStore();

    // 1. Render the component to initiate a fetch and create an abortController.
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    expect(internalStore.getState().queries[key]).toBeDefined();

    // 2. Manually inject a faulty abortController that will throw an error.
    act(() => {
      // Add explicit type for state `s` to remove implicit any.
      internalStore.setState((s: KeyedApiState<unknown>) => ({
        queries: {
          ...s.queries,
          [key]: {
            ...s.queries[key],
            // This mock will throw an error when `clearQueryState` calls it.
            // Cast to `unknown` first to satisfy strict type checking for incomplete mocks.
            abortController: {
              abort: () => {
                throw new Error('Simulated cleanup failure');
              },
            } as unknown as AbortController,
          },
        },
      }));
    });

    // 3. Call `clearQueryState`. Wrap in `act` because it causes a state update.
    // We still check that it doesn't throw, proving the error was handled.
    act(() => {
      expect(() => clearQueryState(key)).not.toThrow();
    });

    // 4. Most importantly, verify that the query was still removed from the store
    // despite the internal error.
    expect(internalStore.getState().queries[key]).toBeUndefined();

    // Restore the spy
    errorSpy.mockRestore();
  });

  /**
   * Verifies that `clearAll()` not only removes data but also cleans up all
   * active resources, such as polling timers and pending retry timers, from
   * multiple queries to prevent memory leaks.
   */
  test('Verifies clearAll() performs full resource cleanup for all query types', async () => {
    const mockFetchPolling = vi.fn().mockResolvedValue({ v: 'polling' });
    const mockFetchRetry = vi
      .fn()
      .mockRejectedValueOnce(createRetryableError('Error', 500));
    const mockFetchCached = vi.fn().mockResolvedValue({ v: 'cached' });

    // This mock correctly switches based on the `params` object, not the base endpoint.
    const combinedMock = vi.fn(async (_endpoint, params) => {
      switch (params.endpoint) {
        case '/api/polling':
          return mockFetchPolling();
        case '/api/retry':
          return mockFetchRetry();
        case '/api/cached':
          return mockFetchCached();
        default:
          throw new Error(`Unexpected endpoint in params: ${params.endpoint}`);
      }
    });

    const { useApiQuery, clearAllQueryStates, getStoreState } =
      createTestableApiStore(
        '/api', // A base path key for the store
        combinedMock,
        {
          retryAttempts: 2,
          refetchIntervalMinutes: 0.1, // 6 seconds for polling
        },
      );

    // 1. Set up three distinct queries in different states.
    render(
      <DataConsumer
        useApiQuery={useApiQuery}
        params={{ endpoint: '/api/polling' }}
      />,
    );
    render(
      <DataConsumer
        useApiQuery={useApiQuery}
        params={{ endpoint: '/api/retry' }}
      />,
    );
    render(
      <DataConsumer
        useApiQuery={useApiQuery}
        params={{ endpoint: '/api/cached' }}
      />,
    );
    await act(flushPromises);

    // Verify initial setup: all fetches fired once.
    expect(mockFetchPolling).toHaveBeenCalledTimes(1);
    expect(mockFetchRetry).toHaveBeenCalledTimes(1);
    expect(mockFetchCached).toHaveBeenCalledTimes(1);
    expect(getStoreState().queryCount).toBe(3);

    // 2. ACT: Clear the entire store.
    act(() => {
      clearAllQueryStates();
    });

    // 3. ASSERT:
    // First, verify the state was wiped immediately.
    expect(getStoreState().queryCount).toBe(0);
    expect(Object.keys(getStoreState().queries).length).toBe(0);

    // Second, advance time well past the polling and retry intervals.
    await advanceTimersWithFlush(7000);

    // Finally, verify that no new fetches were triggered, proving the timers were destroyed.
    expect(mockFetchPolling).toHaveBeenCalledTimes(1);
    expect(mockFetchRetry).toHaveBeenCalledTimes(1);
  });

  /**
   * This parameterized test validates the specific branch where caching is disabled.
   * It ensures that when cacheTTL is zero or negative, the store *always* fetches
   * fresh data and that stale-checking logic is correctly bypassed.
   */
  test.each([{ cacheTTL: 0 }, { cacheTTL: -1 }])(
    'Verifies with cacheTTL=$cacheTTL that caching is disabled and refetchStale is a no-op',
    async ({ cacheTTL }) => {
      const { mockFetch, useApiQuery, refetchStaleQueries } =
        await setupApiTest('/api/no-cache-branch', {
          cacheTTL,
        });

      // 1. Assert that the first mount triggers a fetch.
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // 2. Unmount and remount. A new fetch should occur because the cache is disabled.
      cleanup();
      render(<DataConsumer useApiQuery={useApiQuery} />);
      await act(flushPromises);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // 3. Call `refetchStaleQueries`. It should be a no-op and not trigger a fetch.
      act(() => refetchStaleQueries());
      await act(flushPromises);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    },
  );
});
