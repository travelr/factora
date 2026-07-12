import { act, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { DataConsumer } from '@test-helper/test-components';
import { createTestableApiStore } from '@test-helper/test-helpers';
import { RuntimeServices } from '@core/runtime';
import {
  advanceTimersWithFlush,
  flushPromises,
} from '@test-helper/async-helpers';

describe('asynchronous request execution', () => {
  test('Verifies that a configured timeout settles a fetcher that never resolves', async () => {
    const fetcher = vi.fn(() => new Promise(() => undefined));
    const { useApiQuery } = createTestableApiStore('/api/timeout', fetcher, {
      requestTimeoutMs: 100,
      retryAttempts: 1,
    });
    render(<DataConsumer useApiQuery={useApiQuery} />);

    await advanceTimersWithFlush(100);

    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('error')).toHaveTextContent('timed out');
  });

  test('Verifies that timeout wins when the fetcher rejects in response to abort', async () => {
    const fetcher = vi.fn(
      (_endpoint, _params, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('transport aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const { useApiQuery } = createTestableApiStore(
      '/api/abort-aware-timeout',
      fetcher,
      { requestTimeoutMs: 100, retryAttempts: 1 },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);

    await advanceTimersWithFlush(100);

    expect(screen.getByTestId('error')).toHaveTextContent('timed out');
  });

  test('Verifies that timeout cleanup failure cannot turn a successful request into an error', async () => {
    const runtime = new RuntimeServices();
    vi.spyOn(runtime, 'clearTimeout').mockImplementation(() => {
      throw new Error('timer cleanup failed');
    });
    const reportError = vi.spyOn(runtime, 'reportInternalError');
    const { useApiQuery } = createTestableApiStore(
      '/api/timeout-cleanup',
      vi.fn().mockResolvedValue({ ok: true }),
      { requestTimeoutMs: 100, retryAttempts: 1 },
      { runtime },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    expect(screen.getByTestId('data')).toHaveTextContent('{"ok":true}');
    expect(screen.getByTestId('error')).toHaveTextContent('null');
    expect(reportError).toHaveBeenCalledWith(
      'clear request timeout',
      expect.any(Error),
      expect.any(Object),
    );
  });

  test('Verifies that polling continues after a terminal poll failure', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ value: 1 })
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ value: 2 });
    const { useApiQuery, getStoreState } = createTestableApiStore(
      '/api/poll-recover',
      fetcher,
      {
        retryAttempts: 1,
        refetchIntervalMinutes: 0.001,
      },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    expect(
      Object.values(getStoreState().queries)[0].inFlightPromise,
    ).toBeUndefined();
    expect(
      Object.values(getStoreState().queries)[0].refetchTimerId,
    ).toBeDefined();

    await advanceTimersWithFlush(60);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await advanceTimersWithFlush(60);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test('Verifies that manual refetch clears the previously scheduled poll', async () => {
    let refetchSignal: AbortSignal | undefined;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ value: 1 })
      .mockImplementationOnce((_endpoint, _params, signal) => {
        refetchSignal = signal;
        return new Promise(() => undefined);
      });
    const { useApiQuery } = createTestableApiStore(
      '/api/manual-before-poll',
      fetcher,
      { refetchIntervalMinutes: 0.002 },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    await advanceTimersWithFlush(60);
    act(() => screen.getByTestId('refetch-button').click());
    await act(flushPromises);
    await advanceTimersWithFlush(60);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refetchSignal?.aborted).toBe(false);
  });

  test('Verifies that poll-timer cleanup failure cannot prevent a manual refetch', async () => {
    const runtime = new RuntimeServices();
    const reportError = vi.spyOn(runtime, 'reportInternalError');
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const { useApiQuery } = createTestableApiStore(
      '/api/refetch-cleanup',
      fetcher,
      { refetchIntervalMinutes: 1 },
      { runtime },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    vi.spyOn(runtime, 'clearTimeout').mockImplementation(() => {
      throw new Error('timer cleanup failed');
    });

    act(() => screen.getByTestId('refetch-button').click());
    await act(flushPromises);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      'clear scheduled poll',
      expect.any(Error),
      expect.any(Object),
    );
  });

  test('Verifies that abort cleanup failure cannot prevent a forced refetch', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ version: 2 });
    const { useApiQuery, getStoreState, logger } = createTestableApiStore(
      '/api/refetch-abort-cleanup',
      fetcher,
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    const controller = Object.values(getStoreState().queries)[0]
      .abortController;
    vi.spyOn(controller!, 'abort').mockImplementation(() => {
      throw new Error('abort cleanup failed');
    });

    act(() => screen.getByTestId('refetch-button').click());
    await act(flushPromises);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('data')).toHaveTextContent('{"version":2}');
    expect(logger.error).toHaveBeenCalledWith(
      '[Factora runtime] Failed to abort superseded request.',
      { message: 'abort cleanup failed' },
    );
  });

  test.each([
    { retryAttempts: Number.NaN },
    { retryAttempts: Number.POSITIVE_INFINITY },
    { retryAttempts: -1 },
  ])(
    'Verifies that invalid retry configuration %o is normalized',
    async (options) => {
      const fetcher = vi.fn().mockResolvedValue({ ok: true });
      const { useApiQuery } = createTestableApiStore(
        '/api/options',
        fetcher,
        options,
      );
      render(<DataConsumer useApiQuery={useApiQuery} />);
      await act(flushPromises);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  test('Verifies that shouldRetry is evaluated once for each failed attempt', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ok: true });
    const shouldRetry = vi.fn(() => true);
    const { useApiQuery } = createTestableApiStore(
      '/api/retry-policy',
      fetcher,
      { retryAttempts: 2, retryDelay: 0, shouldRetry },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await advanceTimersWithFlush(0);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  test('Verifies that malformed retry-after falls back to exponential backoff', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('retry'), {
          retryable: true,
          retryAfter: Number.NaN,
        }),
      )
      .mockResolvedValueOnce({ ok: true });
    const { useApiQuery } = createTestableApiStore(
      '/api/retry-after-fallback',
      fetcher,
      { retryAttempts: 2, retryDelay: 25 },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    await advanceTimersWithFlush(24);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advanceTimersWithFlush(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('Verifies that the abort listener is removed after a retry delay completes', async () => {
    const removeListener = vi.spyOn(
      AbortSignal.prototype,
      'removeEventListener',
    );
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('retry'), { retryable: true }),
      )
      .mockResolvedValueOnce({ ok: true });
    const { useApiQuery } = createTestableApiStore(
      '/api/retry-listener',
      fetcher,
      {
        retryAttempts: 2,
        retryDelay: 0,
      },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await advanceTimersWithFlush(0);

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  test('Verifies that a failing retry policy terminates safely', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network'));
    const shouldRetry = vi.fn(() => {
      throw new Error('policy failed');
    });
    const { useApiQuery, logger } = createTestableApiStore(
      '/api/retry-policy-error',
      fetcher,
      { retryAttempts: 2, shouldRetry },
    );
    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(logger.error).toHaveBeenCalledWith(
      '[Factora runtime] Failed to evaluate retry policy.',
      { message: 'policy failed' },
    );
  });

  test.each([
    {
      name: 'throws',
      errorMapper: () => {
        throw new Error('mapper failed');
      },
    },
    { name: 'returns malformed state', errorMapper: () => null as never },
  ])(
    'Verifies that the error mapper $name settles safely',
    async ({ errorMapper }) => {
      const { useApiQuery, logger } = createTestableApiStore(
        '/api/error-mapper-failure',
        vi.fn().mockRejectedValue(new Error('request failed')),
        { retryAttempts: 1 },
        { dependencyOverrides: { errorMapper } },
      );
      render(<DataConsumer useApiQuery={useApiQuery} />);
      await act(flushPromises);

      expect(screen.getByTestId('loading')).toHaveTextContent('false');
      expect(screen.getByTestId('error')).toHaveTextContent(
        'error mapping failed',
      );
      expect(logger.error).toHaveBeenCalledWith(
        '[Factora runtime] Failed to map request error.',
        expect.any(Object),
      );
    },
  );

  test('Verifies that a new internal request without a descriptor is rejected', async () => {
    const { getInternalStore, getQueryKey } = createTestableApiStore(
      '/api/missing-descriptor',
      vi.fn(),
      {},
      { exposeInternal: true },
    );
    const store = getInternalStore();

    await expect(
      store.getState().triggerFetch(getQueryKey('/api/missing-descriptor', {})),
    ).rejects.toThrow('without a request descriptor');
    expect(store.getState().queryCount).toBe(0);
  });

  test('Verifies that a failed cycle settles only after clearing its in-flight state', async () => {
    const { getInternalStore, getQueryKey } = createTestableApiStore(
      '/api/finalization-order',
      vi.fn().mockRejectedValue(new Error('terminal')),
      { retryAttempts: 1 },
      { exposeInternal: true },
    );
    const store = getInternalStore();
    const key = getQueryKey('/api/finalization-order', {});

    await expect(
      store.getState().triggerFetch(key, false, {
        endpoint: '/api/finalization-order',
        params: {},
      }),
    ).rejects.toThrow('terminal');

    expect(store.getState().queries[key].inFlightPromise).toBeUndefined();
    expect(store.getState().queries[key].abortController).toBeUndefined();
  });
});
