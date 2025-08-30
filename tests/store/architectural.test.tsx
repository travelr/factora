/**
 * @fileoverview This test suite is dedicated to validating the internal architectural
 * contracts of the library, specifically the dependency injection (DI) patterns.
 *
 * These are "white-box" tests that verify *how* the library is built internally,
 * ensuring the core is correctly decoupled and that its dependencies are being
 * used as intended.
 */
import { DataConsumer } from '@test-helper/api-store.test-components';
import {
  createTestableApiStore,
  flushPromises,
} from '@test-helper/api-store.test-helpers';
import { act, render, screen } from '@testing-library/react';
import type { FactoraLogger } from '@/types/dependencies';
import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
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
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      getLevel: () => 0,
      levels: { DEBUG: 1 },
    } as FactoraLogger;

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
});
