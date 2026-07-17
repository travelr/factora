// tests/store/engine-boundaries.test.tsx
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
import type { ApiStoreOptions } from '@/types/store';

afterEach(() => {
  cleanup();
  _test_clearGcRegistry();
  vi.clearAllMocks();
});

describe('store engine request boundaries', () => {
  test('Verifies a timed-out attempt retries with a fresh request', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ value: 'retried' });
    const { useApiQuery } = createTestableApiStore(
      '/api/timeout-then-retry',
      fetcher,
      {
        requestTimeoutMs: 50,
        retryAttempts: 2,
        retryDelay: 25,
        shouldRetry: () => true,
      },
    );

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await advanceTimersWithFlush(50);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('error')).toHaveTextContent('timed out');

    await advanceTimersWithFlush(25);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('data')).toHaveTextContent('{"value":"retried"}');
    expect(screen.getByTestId('error')).toHaveTextContent('null');
  });
});

describe('store engine option normalization', () => {
  type InvalidOptionCase = {
    option: keyof ApiStoreOptions;
    value: number;
    fallback: number;
    options: ApiStoreOptions;
    verify: () => Promise<void>;
  };

  const cases: InvalidOptionCase[] = [
    {
      option: 'retryDelay',
      value: -1,
      fallback: 1_000,
      options: { retryDelay: -1, retryAttempts: 2 },
      verify: async () => {
        const fetcher = vi
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error('retryable'), { retryable: true }),
          )
          .mockResolvedValueOnce({ ok: true });
        const { useApiQuery } = createTestableApiStore(
          '/api/invalid-retry-delay',
          fetcher,
          cases[0].options,
        );
        render(<DataConsumer useApiQuery={useApiQuery} />);
        await act(flushPromises);
        await advanceTimersWithFlush(999);
        expect(fetcher).toHaveBeenCalledTimes(1);
        await advanceTimersWithFlush(1);
        expect(fetcher).toHaveBeenCalledTimes(2);
      },
    },
    {
      option: 'refetchIntervalMinutes',
      value: -1,
      fallback: 0,
      options: { refetchIntervalMinutes: -1 },
      verify: async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true });
        const { useApiQuery } = createTestableApiStore(
          '/api/invalid-refetch-interval',
          fetcher,
          cases[1].options,
        );
        render(<DataConsumer useApiQuery={useApiQuery} />);
        await act(flushPromises);
        await advanceTimersWithFlush(61_000);
        expect(fetcher).toHaveBeenCalledTimes(1);
      },
    },
    {
      option: 'gcGracePeriod',
      value: -1,
      fallback: 600_000,
      options: { gcGracePeriod: -1 },
      verify: async () => {
        const runtime = new RuntimeServices();
        const fetcher = vi.fn().mockResolvedValue({ ok: true });
        const { clearStaleQueries, getStoreState, useApiQuery } =
          createTestableApiStore(
            '/api/invalid-gc-grace',
            fetcher,
            cases[2].options,
            { runtime },
          );
        render(<DataConsumer useApiQuery={useApiQuery} />);
        await act(flushPromises);
        cleanup();
        await advanceTimersWithFlush(600_000);
        act(() => clearStaleQueries());
        expect(runtime.getStoreCount()).toBe(1);
        await advanceTimersWithFlush(1);
        act(() => clearStaleQueries());
        expect(getStoreState().queryCount).toBe(0);
        await advanceTimersWithFlush(1_500);
        expect(runtime.getStoreCount()).toBe(0);
      },
    },
    {
      option: 'requestTimeoutMs',
      value: -1,
      fallback: 0,
      options: { requestTimeoutMs: -1 },
      verify: async () => {
        const fetcher = vi.fn(() => new Promise(() => undefined));
        const { useApiQuery } = createTestableApiStore(
          '/api/invalid-request-timeout',
          fetcher,
          cases[3].options,
        );
        render(<DataConsumer useApiQuery={useApiQuery} />);
        await advanceTimersWithFlush(100);
        expect(screen.getByTestId('loading')).toHaveTextContent('true');
        expect(screen.getByTestId('error')).toHaveTextContent('null');
      },
    },
    {
      option: 'cacheTTL',
      value: Number.NaN,
      fallback: 300_000,
      options: { cacheTTL: Number.NaN },
      verify: async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true });
        const { useApiQuery } = createTestableApiStore(
          '/api/invalid-cache-ttl',
          fetcher,
          cases[4].options,
        );
        render(<DataConsumer useApiQuery={useApiQuery} />);
        await act(flushPromises);
        cleanup();
        await advanceTimersWithFlush(1);
        render(<DataConsumer useApiQuery={useApiQuery} />);
        await act(flushPromises);
        expect(fetcher).toHaveBeenCalledTimes(1);
      },
    },
  ];

  test.each(cases)(
    'Verifies invalid $option=$value falls back and warns',
    async ({ option, fallback, verify }) => {
      await verify();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[API Request] Invalid option.',
        { option, fallback },
      );
    },
  );
});
