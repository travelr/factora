import { clearAllApiStores } from '@core/api-store-registry';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DataConsumer } from '@test-helper/test-components';
import {
  _test_clearGcRegistry,
  _test_getGcRegistrySize,
  createTestableApiStore,
} from '@test-helper/test-helpers';
import {
  advanceTimersWithFlush,
  flushPromises,
} from '@test-helper/async-helpers';

afterEach(() => _test_clearGcRegistry());

describe('runtime store lifecycle', () => {
  test('Verifies that terminal failures become eligible for garbage collection', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('terminal'));
    const { useApiQuery, clearStaleQueries, getStoreState } =
      createTestableApiStore('/api/failure-gc', fetcher, {
        retryAttempts: 1,
        gcGracePeriod: 50,
      });
    const mounted = render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    mounted.unmount();

    await advanceTimersWithFlush(51);
    act(() => clearStaleQueries());
    expect(getStoreState().queryCount).toBe(0);
  });

  test('Verifies that global clear controls a real factory-created store', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ value: 'cached' })
      .mockResolvedValueOnce({ value: 'restored' });
    const { useApiQuery, getStoreState } = createTestableApiStore(
      '/api/global-clear',
      fetcher,
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    expect(getStoreState().queryCount).toBe(1);

    act(() => clearAllApiStores());
    expect(getStoreState().queryCount).toBe(0);

    act(() => screen.getByTestId('refetch-button').click());
    await act(flushPromises);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('data')).toHaveTextContent(
      '{"value":"restored"}',
    );
  });

  test('Verifies that unused factories do not register runtime entries', () => {
    createTestableApiStore('/api/unused', vi.fn());
    expect(_test_getGcRegistrySize()).toBe(0);
  });

  test('Verifies that an evicted store re-registers when reused', async () => {
    const { useApiQuery, clearStaleQueries } = createTestableApiStore(
      '/api/re-register',
      vi.fn().mockResolvedValue({ ok: true }),
      { gcGracePeriod: 25 },
    );
    const first = render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    first.unmount();
    await advanceTimersWithFlush(26);
    act(() => clearStaleQueries());
    await advanceTimersWithFlush(1_500);
    expect(_test_getGcRegistrySize()).toBe(0);

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    expect(_test_getGcRegistrySize()).toBe(1);
  });

  test('Verifies that same-key stores have independent subscriber lifecycles', async () => {
    const fetchA = vi.fn().mockResolvedValue({ store: 'a' });
    const fetchB = vi.fn().mockResolvedValue({ store: 'b' });
    const storeA = createTestableApiStore('/api/shared', fetchA, {
      refetchIntervalMinutes: 0.001,
    });
    const storeB = createTestableApiStore('/api/shared', fetchB, {
      refetchIntervalMinutes: 0.001,
    });
    render(<DataConsumer useApiQuery={storeA.useApiQuery} />);
    const mountedB = render(<DataConsumer useApiQuery={storeB.useApiQuery} />);
    await act(flushPromises);
    mountedB.unmount();

    await advanceTimersWithFlush(60);
    expect(fetchA).toHaveBeenCalledTimes(2);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });

  test('Verifies that bulk clear still clears a timer when abort cleanup throws', () => {
    const { getInternalStore, clearAllQueryStates } = createTestableApiStore(
      '/api/cleanup-failure',
      vi.fn(),
      {},
      { exposeInternal: true },
    );
    const store = getInternalStore();
    const abortController = new AbortController();
    vi.spyOn(abortController, 'abort').mockImplementation(() => {
      throw new Error('abort failed');
    });
    const refetchTimerId = setTimeout(() => undefined, 5_000);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    store.setState({
      queries: {
        cleanup: {
          data: null,
          error: null,
          abortController,
          refetchTimerId,
        },
      },
      queryCount: 1,
    });

    act(() => clearAllQueryStates());
    expect(store.getState().queryCount).toBe(0);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(refetchTimerId);
  });
});
