// tests/store/revalidation.test.tsx
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { revalidateAgedQueries } from '@core/api-store-registry';
import { RuntimeServices } from '@core/runtime';
import {
  advanceTimersWithFlush,
  flushPromises,
} from '@test-helper/async-helpers';
import { DataConsumer } from '@test-helper/test-components';
import {
  _test_clearGcRegistry,
  createTestableApiStore,
  mockLogger,
} from '@test-helper/test-helpers';

afterEach(() => {
  cleanup();
  _test_clearGcRegistry();
});

describe('aged-query revalidation', () => {
  test.each([undefined, 0, -1])(
    'Verifies revalidation is opt-in when revalidateAfterMs is %p',
    async (revalidateAfterMs) => {
      const fetcher = vi.fn().mockResolvedValue({ ok: true });
      const { revalidateAgedQueries: revalidate, useApiQuery } =
        createTestableApiStore('/api/revalidate-disabled', fetcher, {
          revalidateAfterMs,
        });
      render(<DataConsumer useApiQuery={useApiQuery} />);
      await act(flushPromises);

      await advanceTimersWithFlush(10_000);
      act(() => revalidate());
      await act(flushPromises);

      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  test('Verifies the configured age uses a strict greater-than boundary', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const { revalidateAgedQueries: revalidate, useApiQuery } =
      createTestableApiStore('/api/revalidate-boundary', fetcher, {
        cacheTTL: 10_000,
        revalidateAfterMs: 100,
      });
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    await advanceTimersWithFlush(99);
    act(() => revalidate());
    await act(flushPromises);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advanceTimersWithFlush(1);
    act(() => revalidate());
    await act(flushPromises);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advanceTimersWithFlush(1);
    act(() => revalidate());
    await act(flushPromises);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('Verifies an aged successful query is force-fetched despite a fresh cache TTL', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });
    const { revalidateAgedQueries: revalidate, useApiQuery } =
      createTestableApiStore('/api/revalidate-force-fetch', fetcher, {
        cacheTTL: 60_000,
        revalidateAfterMs: 50,
      });
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    await advanceTimersWithFlush(51);
    act(() => revalidate());
    await act(flushPromises);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('Verifies cache TTL stale refetch behavior remains unchanged', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const { refetchStaleQueries, useApiQuery } = createTestableApiStore(
      '/api/revalidate-legacy-stale',
      fetcher,
      { cacheTTL: 50 },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    await advanceTimersWithFlush(51);
    act(() => refetchStaleQueries());
    await act(flushPromises);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('Verifies an in-flight query is not duplicated or aborted', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockImplementationOnce((_endpoint, _params, requestSignal) => {
        signal = requestSignal;
        return new Promise(() => undefined);
      });
    const { revalidateAgedQueries: revalidate, useApiQuery } =
      createTestableApiStore('/api/revalidate-in-flight', fetcher, {
        revalidateAfterMs: 50,
      });
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    await advanceTimersWithFlush(51);
    act(() => revalidate());
    await act(flushPromises);
    act(() => revalidate());

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(false);
  });

  test('Verifies errored queries are skipped', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockRejectedValueOnce(new Error('terminal'));
    const { revalidateAgedQueries: revalidate, useApiQuery } =
      createTestableApiStore('/api/revalidate-error', fetcher, {
        revalidateAfterMs: 50,
        retryAttempts: 1,
      });
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    await advanceTimersWithFlush(51);
    act(() => revalidate());
    await act(flushPromises);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await advanceTimersWithFlush(51);
    act(() => revalidate());
    await act(flushPromises);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('Verifies global revalidation reaches every aged query across stores', async () => {
    const fetchA = vi.fn().mockResolvedValue({ store: 'a' });
    const fetchB = vi.fn().mockResolvedValue({ store: 'b' });
    const storeA = createTestableApiStore('/api/revalidate-a', fetchA, {
      revalidateAfterMs: 50,
    });
    const storeB = createTestableApiStore('/api/revalidate-b', fetchB, {
      revalidateAfterMs: 50,
    });
    render(
      <div>
        <DataConsumer useApiQuery={storeA.useApiQuery} params={{ page: 1 }} />
        <DataConsumer useApiQuery={storeA.useApiQuery} params={{ page: 2 }} />
        <DataConsumer useApiQuery={storeB.useApiQuery} />
      </div>,
    );
    await act(flushPromises);

    await advanceTimersWithFlush(51);
    act(() => revalidateAgedQueries());
    await act(flushPromises);

    expect(fetchA).toHaveBeenCalledTimes(4);
    expect(fetchB).toHaveBeenCalledTimes(2);
  });

  test('Verifies an emptied store deregisters before global aged revalidation', async () => {
    const runtime = new RuntimeServices();
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const { clearAllQueryStates, useApiQuery } = createTestableApiStore(
      '/api/revalidate-empty',
      fetcher,
      { revalidateAfterMs: 50 },
      { runtime },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    expect(runtime.getStoreCount()).toBe(1);

    act(() => clearAllQueryStates());
    await advanceTimersWithFlush(1_500);
    expect(runtime.getStoreCount()).toBe(0);

    const setTimeoutSpy = vi.spyOn(runtime, 'setTimeout');
    runtime.revalidateAgedQueries();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'Verifies non-finite revalidateAfterMs=%p disables revalidation and warns',
    async (revalidateAfterMs) => {
      const fetcher = vi.fn().mockResolvedValue({ ok: true });
      const { revalidateAgedQueries: revalidate, useApiQuery } =
        createTestableApiStore('/api/revalidate-invalid', fetcher, {
          revalidateAfterMs,
        });
      render(<DataConsumer useApiQuery={useApiQuery} />);
      await act(flushPromises);
      await advanceTimersWithFlush(100);
      act(() => revalidate());

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[API Request] Invalid option.',
        { option: 'revalidateAfterMs', fallback: 0 },
      );
    },
  );
});
