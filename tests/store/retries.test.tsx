import { DataConsumer } from '@test-helper/test-components';
import {
  _test_clearGcRegistry,
  createTestableApiStore,
} from '@test-helper/test-helpers';
import {
  advanceTimersWithFlush,
  flushPromises,
} from '@test-helper/async-helpers';
import {
  createNonRetryableError,
  createRetryableError,
} from '@test-helper/error-generators';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  cleanup();
  _test_clearGcRegistry();
});

describe('API store error handling and retries', () => {
  /**
   * This test validates the full retry lifecycle. It ensures the store:
   * 1. Prioritizes the server's `Retry-After` header over the default delay.
   * 2. Maintains a `loading` state throughout the entire retry process for a smooth UX.
   * 3. Finally succeeds and displays the correct data.
   */
  test("Verifies retry logic respects server 'retry-after' header and maintains loading state", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(createRetryableError('First error', 500))
      .mockRejectedValueOnce(createRetryableError('Second error', 1000))
      .mockResolvedValueOnce({ value: 'retried data' });
    const { useApiQuery } = createTestableApiStore('/api/retry', mockFetch, {
      retryAttempts: 3,
    });

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises); // Wait for first failure.

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loading').textContent).toBe('true');

    await advanceTimersWithFlush(500); // Advance by server-specified delay.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('loading').textContent).toBe('true');

    await advanceTimersWithFlush(1000);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('data').textContent).toBe(
      '{"value":"retried data"}',
    );
  });

  /**
   * Ensures that if an error is marked as non-retryable, the store
   * immediately gives up and shows the error instead of attempting retries.
   */
  test('Verifies a non-retryable error short-circuits the retry mechanism', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(createNonRetryableError('Not Found'));
    const { useApiQuery } = createTestableApiStore(
      '/api/not-found',
      mockFetch,
      { retryAttempts: 5 },
    );

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toContain('Not Found');
  });

  /**
   * This parameterized test accurately verifies the production behavior
   * of the `retryAttempts` option, confirming it controls the *total* number of attempts.
   */
  describe("Verifies the 'retryAttempts' option controls the total number of fetch attempts", () => {
    const testCases = [
      {
        description:
          'it makes 1 total call and fails, respecting the floor value of 1',
        retryAttempts: 0,
        expectedCalls: 1,
        shouldSucceed: false,
      },
      {
        description: 'it makes 1 total call and fails',
        retryAttempts: 1,
        expectedCalls: 1,
        shouldSucceed: false,
      },
      {
        description: 'it makes 2 total calls and succeeds on the second',
        retryAttempts: 2,
        expectedCalls: 2,
        shouldSucceed: true,
      },
      {
        description: 'it makes 3 total calls and succeeds on the third',
        retryAttempts: 3,
        expectedCalls: 3,
        shouldSucceed: true,
      },
    ];

    test.each(testCases)(
      'Verifies with retryAttempts = $retryAttempts, $description',
      async ({ retryAttempts, expectedCalls, shouldSucceed }) => {
        const mockFetch = vi.fn();
        if (shouldSucceed) {
          for (let i = 0; i < expectedCalls - 1; i++) {
            mockFetch.mockRejectedValueOnce(createRetryableError('Error', 100));
          }
          mockFetch.mockResolvedValueOnce({ value: 'success' });
        } else {
          mockFetch.mockRejectedValue(createRetryableError('Error'));
        }

        const { useApiQuery } = createTestableApiStore(
          `/api/retry-${retryAttempts}`,
          mockFetch,
          { retryAttempts, retryDelay: 100 },
        );

        // ACT
        render(<DataConsumer useApiQuery={useApiQuery} />);

        // Wait for all attempts to complete by advancing time accordingly.
        // The first attempt happens instantly. Subsequent attempts depend on the delay.
        await act(flushPromises);
        if (expectedCalls > 1) {
          await advanceTimersWithFlush(100 * (expectedCalls - 1));
        }

        // ASSERT: Verify the final state.
        expect(mockFetch).toHaveBeenCalledTimes(expectedCalls);
        expect(screen.getByTestId('loading')).toHaveTextContent('false');

        if (shouldSucceed) {
          expect(screen.getByTestId('data')).toHaveTextContent(
            '{"value":"success"}',
          );
          expect(screen.getByTestId('error')).toHaveTextContent('null');
        } else {
          expect(screen.getByTestId('error').textContent).not.toBe('null');
          expect(screen.getByTestId('error').textContent).toContain('Error');
          expect(screen.getByTestId('data')).toHaveTextContent('null');
        }
      },
    );
  });

  /**
   * This test verifies that if the provided `fetchFn` itself throws a synchronous
   * error, our internal error handling correctly catches it and transitions the
   * store to an error state.
   */
  test('Verifies the store correctly handles synchronous errors from the fetch function', async () => {
    const mockFetch = vi.fn(() => {
      throw new Error('Synchronous validation error');
    });
    const { useApiQuery } = createTestableApiStore(
      '/api/sync-error',
      mockFetch,
    );

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('error')).toHaveTextContent(
      'Synchronous validation error',
    );
  });
});
