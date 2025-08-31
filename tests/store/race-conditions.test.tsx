import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DataConsumer } from '@test-helper/test-components';
import {
  _test_clearGcRegistry,
  createTestableApiStore,
} from '@test-helper/test-helpers';
import {
  flushPromises,
  advanceTimersWithFlush,
} from '@test-helper/async-helpers';
import { createRetryableError } from '@test-helper/error-generators';

afterEach(() => {
  // 1. Unmount any React components to prevent memory leaks and side effects.
  cleanup();
  // 2. Clear our test-local GC registry to ensure test isolation.
  _test_clearGcRegistry();
});

describe('API store race conditions and concurrency', () => {
  /**
   * Validates that when a new fetch is initiated for a query that already has a
   * request in-flight, the old request is correctly aborted. This is crucial for
   * preventing stale data from overwriting new data.
   */
  test('Verifies a forced refetch aborts the previous request and starts a new one', async () => {
    let abortSignal: AbortSignal | undefined;
    let resolveSecondFetch: ((value: unknown) => void) | null = null;
    const mockFetch = vi.fn().mockImplementation((_, __, signal) => {
      if (mockFetch.mock.calls.length === 1) {
        abortSignal = signal; // Capture the signal to verify it was aborted.
        return new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('Aborted'))),
        );
      }
      return new Promise((resolve) => {
        resolveSecondFetch = resolve;
      });
    });
    const { useApiQuery } = createTestableApiStore('/api/race', mockFetch);
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    act(() => screen.getByTestId('refetch-button').click());

    expect(abortSignal?.aborted).toBe(true);

    await act(async () => {
      resolveSecondFetch?.({ value: 'new data' });
      await flushPromises();
    });

    expect(screen.getByTestId('data').textContent).toBe('{"value":"new data"}');
  });

  /**
   * Verifies the critical race condition where a fetch resolves, but the request
   * is aborted before the data can be processed. The store must discard the data.
   */
  test('Verifies store discards data if fetch is aborted after promise resolution', async () => {
    let resolveFetch: (value: { data: string }) => void;
    const mockFetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { useApiQuery, getInternalStore, getQueryKey } =
      createTestableApiStore('/api/abort-after', mockFetch, undefined, {
        exposeInternal: true,
      });

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises); // Trigger the fetch.

    const internalStore = getInternalStore();
    const key = getQueryKey('/api/abort-after', {});
    const abortController =
      internalStore.getState().queries[key]?.abortController;

    // Simulate the race condition: resolve the promise, then immediately abort.
    await act(async () => {
      resolveFetch({ data: 'stale data' });
      abortController!.abort();
      await flushPromises();
    });

    // The store should have caught the post-fetch abort and set an error state.
    const finalState = internalStore.getState();
    expect(finalState.queries[key]?.data).toBeNull();
    // Correctly assert on the error message, not the `isAbort` flag.
    expect(finalState.queries[key]?.error?.message).toContain(
      'Request aborted after fetch attempt',
    );

    // The UI should reflect the aborted state, not the stale data.
    expect(screen.getByTestId('data')).toHaveTextContent('null');
    expect(screen.getByTestId('error')).not.toHaveTextContent('null');
  });

  /**
   * Ensures that if a fetch resolves *after* its corresponding query state has been
   * cleared, the stale data is safely ignored and does not re-populate the store.
   */
  test('Verifies store safely handles a fetch resolving after its query has been cleared', async () => {
    let resolveFetch: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const mockFetch = vi.fn(() => fetchPromise);

    const { useApiQuery, clearQueryState, getQueryKey, getStoreState } =
      createTestableApiStore('/api/concurrent-clear', mockFetch);

    const key = getQueryKey('/api/concurrent-clear', {});

    // 1. Render and trigger the fetch. Do not wait for it to complete.
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getStoreState().queries[key]?.inFlightPromise).toBeDefined();

    // 2. While the fetch is in-flight, clear the query state.
    act(() => {
      clearQueryState(key);
    });

    // 3. Verify the query was immediately removed from the store.
    expect(getStoreState().queries[key]).toBeUndefined();

    // 4. Now, resolve the original (and now stale) fetch promise.
    await act(async () => {
      resolveFetch({ value: 'stale data' });
      await flushPromises();
    });

    // 5. Assert that the stale data was ignored and did not "resurrect" the query.
    expect(getStoreState().queries[key]).toBeUndefined();
    expect(screen.getByTestId('data').textContent).toBe('null');
    expect(screen.getByTestId('error').textContent).toBe('null');
  });

  /**
   * This test documents and verifies an important behavior: if a refetch is
   * triggered while a retry is already scheduled, the original retry timer
   * is *not* cancelled. Both the new request and the scheduled retry will run.
   */
  test('Verifies a refetch during a retry delay does not cancel the pending retry', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(createRetryableError('Rate limit exceeded'));
    const { useApiQuery } = createTestableApiStore(
      '/api/abort-retry',
      mockFetch,
      { retryAttempts: 2, retryDelay: 1000 },
    );

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises); // Fetch #1 fails. Retry is scheduled.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loading').textContent).toBe('true');

    act(() => screen.getByTestId('refetch-button').click());
    await act(flushPromises); // Fetch #2 (manual) also fails.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('loading').textContent).toBe('true');

    await advanceTimersWithFlush(1000);
    // Fetch #3 (the scheduled retry from fetch #1) fires as expected.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });

  /**
   * This test handles a "stale worker" race condition. A "stale worker" refers to the
   * async `finally` block of an old, superseded promise. This test ensures that if a
   * new fetch succeeds, the `finally` block of a previous, slower request cannot
   * incorrectly alter the final state.
   */
  test('Verifies token mechanism prevents a stale worker from clearing a new fetch state', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(createRetryableError('First error', 500))
      .mockResolvedValueOnce({ value: 'success' });
    const { useApiQuery } = createTestableApiStore(
      '/api/token-test',
      mockFetch,
    );

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises); // First fetch fails, retry scheduled for t=500ms.
    expect(screen.getByTestId('loading').textContent).toBe('true');

    act(() => screen.getByTestId('refetch-button').click());
    await act(flushPromises); // Second fetch succeeds immediately.

    expect(screen.getByTestId('data').textContent).toBe('{"value":"success"}');
    expect(screen.getByTestId('loading').textContent).toBe('false');

    await advanceTimersWithFlush(500);

    // The token mechanism should have prevented the stale worker from altering the state.
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('data').textContent).toBe('{"value":"success"}');
  });

  /**
   * This is the most complex race condition test. It verifies the token mechanism
   * in a scenario where two fetch/retry cycles overlap completely.
   * Sequence: Fetch1 fails -> Retry1 is scheduled -> Fetch2 starts & fails -> Retry2 is scheduled -> Retry2 succeeds.
   */
  test('Verifies token mechanism correctly handles overlapping fetch and retry cycles', async () => {
    // SETUP: The first two calls fail, allowing two retries to be scheduled. The third call succeeds.
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(createRetryableError('Retryable error', 500))
      .mockRejectedValueOnce(createRetryableError('Retryable error', 500))
      .mockResolvedValueOnce({ value: 'success' });
    const { useApiQuery } = createTestableApiStore(
      '/api/token-gap',
      mockFetch,
      {
        retryAttempts: 2, // 1 initial + 1 retry
        retryDelay: 500,
      },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);

    // ACTION 1: Initial fetch fails, and schedules a retry.
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loading').textContent).toBe('true');

    // ACTION 2: During the retry delay, the user triggers a new fetch.
    act(() => screen.getByTestId('refetch-button').click());

    // ACTION 3: The new fetch also fails, scheduling its own retry.
    await act(flushPromises);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('loading').textContent).toBe('true'); // Still loading.

    // ACTION 4: Advance time so the retry for the *second* fetch is triggered, which will succeed.
    await advanceTimersWithFlush(500);

    // VERIFY: The third call (the successful retry) has occurred.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('data').textContent).toBe('{"value":"success"}');
  });

  /**
   * This test ensures that if a request is aborted but its promise resolves *late*,
   * the store correctly ignores the stale data, preventing a race condition where
   * old data could overwrite new data.
   */
  test('Verifies store ignores a slow fetch that resolves after a newer fetch has completed', async () => {
    let resolveFirst: (value: unknown) => void;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const mockFetch = vi
      .fn()
      .mockImplementationOnce(() => firstPromise) // First call returns the slow promise.
      .mockResolvedValue({ value: 'new data' }); // Second call resolves quickly.
    const { useApiQuery } = createTestableApiStore(
      '/api/race-finally',
      mockFetch,
    );

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    act(() => screen.getByTestId('refetch-button').click());
    await act(flushPromises); // Second, faster fetch completes.
    expect(screen.getByTestId('data').textContent).toBe('{"value":"new data"}');

    // Now, resolve the first promise late. Its result should be ignored.
    await act(async () => {
      resolveFirst({ value: 'old data' });
      await flushPromises();
    });

    // The data should remain 'new data'.
    expect(screen.getByTestId('data').textContent).toBe('{"value":"new data"}');
  });

  /**
   * This is a critical race condition test. It verifies that the `inFlightToken`
   * mechanism correctly preserves the `loading` state when a user triggers a
   * new fetch while a previous request's retry is already pending. A failure
   * here indicates a "stale worker" bug in the production store.
   */
  test('Verifies loading state is correctly maintained during a refetch-while-retrying scenario', async () => {
    const mockFetch = vi
      .fn()
      // The first fetch fails, scheduling a retry.
      .mockRejectedValueOnce(createRetryableError('First error', 500))
      // The second fetch (the refetch) must ALSO fail to test the loading state.
      .mockRejectedValueOnce(createRetryableError('Second error', 500))
      // The third fetch (the retry of the second call) will succeed.
      .mockResolvedValueOnce({ value: 'success' });

    const { useApiQuery } = createTestableApiStore(
      '/api/token-validation',
      mockFetch,
      { retryAttempts: 2, retryDelay: 500 }, // Allows initial + 1 retry
    );

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises); // Initial fetch fails.
    expect(screen.getByTestId('loading')).toHaveTextContent('true');

    // Trigger a new fetch during the retry delay.
    act(() => screen.getByTestId('refetch-button').click());
    await act(flushPromises); // Second fetch also fails.

    // CRITICAL ASSERTION: The loading state MUST remain true while waiting
    // for the second fetch's retry. This is the core of the test.
    expect(screen.getByTestId('loading')).toHaveTextContent('true');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Now, advance the timer to trigger the successful retry.
    await advanceTimersWithFlush(500);

    // The final state should be successful.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('data')).toHaveTextContent('{"value":"success"}');
  });

  test('Verifies clearQueryState safely aborts a pending retry', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(createRetryableError('Error', 500));
    const { useApiQuery, clearQueryState, getQueryKey, getStoreState } =
      createTestableApiStore('/api/clear-retry', mockFetch, {
        retryAttempts: 2,
      });
    const key = getQueryKey('/api/clear-retry', {});

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises); // Initial fetch fails, retry is scheduled.
    expect(screen.getByTestId('loading')).toHaveTextContent('true');

    // Clear the query while the retry is pending.
    act(() => clearQueryState(key));

    // The query should be gone immediately.
    expect(getStoreState().queries[key]).toBeUndefined();

    // Advance time past the original retry delay.
    await advanceTimersWithFlush(500);

    // The mock should NOT have been called a second time.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
