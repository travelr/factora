/**
 * @fileoverview This test suite is dedicated to validating the internal architectural
 * contracts of the library, specifically the dependency injection (DI) patterns.
 *
 * These are "white-box" tests that verify *how* the library is built internally,
 * ensuring the core is correctly decoupled and that its dependencies are being
 * used as intended.
 */
import { DataConsumer } from '@test-helper/test-components';
import { createTestableApiStore, mockLogger } from '@test-helper/test-helpers';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { flushPromises } from '@test-helper/async-helpers';
import { createApiFactoryPure } from '@core/index';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const simpleErrorMapper = (error: unknown) => ({
  message: error instanceof Error ? error.message : 'Test error',
  retryable: false,
});

// Create the base factory with a simple error mapper for most tests.
const baseFactory = createApiFactoryPure({
  errorMapper: simpleErrorMapper,
  logger: mockLogger,
});

describe('Architectural Contract Tests', () => {
  /**
   * This test validates the DI pattern for error handling. It proves that the
   * core correctly calls the `errorMapper` function provided in its dependencies
   * instead of using a hard-coded handler.
   */
  test('Verifies the injected errorMapper is called on fetch failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network Failure'));
    const mockErrorMapper = vi.fn().mockReturnValue({
      message: 'Mapped Error From Mock',
      retryable: false,
    });

    const { useApiQuery } = createTestableApiStore(
      '/api/error-mapper-test',
      mockFetch,
      {},
      {
        dependencyOverrides: {
          errorMapper: mockErrorMapper,
        },
      },
    );

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    expect(mockErrorMapper).toHaveBeenCalledTimes(1);
    expect(mockErrorMapper).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ endpoint: '/api/error-mapper-test' }),
    );

    expect(screen.getByTestId('error').textContent).toBe(
      'Mapped Error From Mock',
    );
  });

  /**
   * This test validates both the resilience of the core and the logger DI contract.
   * It ensures that when a pure internal utility (getQueryKey) throws an error,
   * the hook catches it, uses the injected logger, and returns a stable error
   * state to the component to prevent a crash.
   */
  test('Verifies hook returns stable error state and does not crash when getQueryKey fails', () => {
    // Create a store with an invalid `apiPathKey` to trigger an internal error.
    const { useApiQuery } = createTestableApiStore(
      '', // Invalid apiPathKey
      vi.fn(),
      {},
      {
        dependencyOverrides: { logger: mockLogger },
      },
    );

    render(<DataConsumer useApiQuery={useApiQuery} />);

    // Assert that the component rendered the error state without crashing.
    const errorElement = screen.getByTestId('error');
    expect(errorElement).toBeInTheDocument();
    expect(errorElement.textContent).toContain('Invalid endpoint provided');

    // Assert that the injected logger was used to report the internal problem.
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to generate a valid query key'),
      expect.any(Object),
    );
  });

  test('Verifies hook handles fetcher promise rejections and logs them', async () => {
    const asyncError = new Error('Async error');
    const rejectingFetcher = () => Promise.reject(asyncError);

    // Create the hook using the base factory.
    const useApiQuery = baseFactory('/test', rejectingFetcher, {
      retryAttempts: 1,
    });

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    // Assert that the UI correctly displays the error from the store's state.
    expect(screen.getByTestId('error')).toHaveTextContent('Async error');

    // The library DOES log standard fetch errors. This assertion is now correct.
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Fetch failed for query'),
      // The payload is the ApiError object produced by the mapper.
      expect.objectContaining({
        error: { message: 'Async error', retryable: false },
      }),
    );
  });

  /**
   * This test is critical for the DI contract. It ensures that if an injected
   * dependency (like the errorMapper) fails, the core catches the failure,
   * logs it using the injected logger, and displays a fallback error.
   */
  test('Verifies injected logger is called for internal dependency errors', async () => {
    const internalMapperError = new Error('Error mapper crashed!');
    const faultyErrorMapper = () => {
      throw internalMapperError;
    };

    const rejectingFetcher = () =>
      Promise.reject(new Error('Original fetcher error'));

    // Create a new factory specifically with the faulty error mapper.
    const faultyFactory = createApiFactoryPure({
      errorMapper: faultyErrorMapper,
      logger: mockLogger,
    });

    const useApiQuery = faultyFactory('/test', rejectingFetcher, {
      retryAttempts: 1,
    });

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    // The logger is called with the same consistent message format.
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Fetch failed for query'),
      // The payload is the raw error thrown by the dependency that crashed.
      expect.objectContaining({ error: internalMapperError }),
    );

    // The UI should display the error from the dependency that crashed,
    // as that is the most recent and relevant error in the chain.
    expect(screen.getByTestId('error')).toHaveTextContent(
      'Error mapper crashed!',
    );
  });
});
