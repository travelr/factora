/**
 * @fileoverview High-level integration tests for the library's public entry points.
 *
 * These tests validate that the packaging and module exports are configured correctly,
 * ensuring that the pure and pre-configured entry points behave as designed.
 * They are the ultimate confirmation of our decoupling and tree-shaking strategy.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/react';

import { flushPromises } from '@test-helper/async-helpers';

import { DataConsumer } from '@test-helper/test-components';

// --- Mocks for External Libraries ---
// These mocks are hoisted to the top and run before any imports.
const mockAxiosGet = vi.fn();
vi.mock('axios', async (importOriginal) => {
  const actualAxios = await importOriginal<typeof import('axios')>();
  return {
    ...actualAxios,
    default: {
      ...actualAxios.default,
      get: mockAxiosGet,
    },
    isAxiosError: actualAxios.isAxiosError,
    isCancel: actualAxios.isCancel,
  };
});

const mockLoglevelError = vi.fn();
vi.mock('loglevel', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoglevelError,
    debug: vi.fn(),
    getLevel: () => 0,
    levels: { DEBUG: 1 },
  },
}));

// --- Test Suite ---

describe('Library Entry Point Integration Tests', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Validates the contract of the `pure.ts` entry point.
   */
  test('Verifies the "pure" entry point is decoupled and uses provided mocks', async () => {
    // ARRANGE: Dynamically import the pure factory *inside the test*.
    // This ensures the module is loaded AFTER vi.mock has run.
    const { createApiFactoryPure } = await import('../../src/pure');

    const mockFetcher = vi.fn().mockResolvedValue({ data: 'pure data' });
    const mockLogger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      getLevel: () => 0,
      levels: { DEBUG: 1 },
    };
    const mockErrorMapper = vi.fn();

    const pureFactory = createApiFactoryPure({
      logger: mockLogger,
      errorMapper: mockErrorMapper,
    });
    const useTestApi = pureFactory('/api/pure-test', mockFetcher);

    // ACT
    render(<DataConsumer useApiQuery={useTestApi} />);
    await act(flushPromises);

    // ASSERT
    expect(mockFetcher).toHaveBeenCalledTimes(1);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  /**
   * Validates the contract of the main `index.ts` entry point.
   */
  test('Verifies the main entry point uses the pre-configured Axios and Loglevel adapters', async () => {
    // ARRANGE: Dynamically import the main entry point *inside the test*.
    const { createApiStore } = await import('../../src/index');
    const axios = (await import('axios')).default; // Get a handle to the mocked axios

    mockAxiosGet.mockRejectedValue({
      isAxiosError: true,
      message: 'Network Error',
    });

    const userFetcher = (endpoint: string, params: any) =>
      axios.get(endpoint, { params });

    const useTestApi = createApiStore('/api/main-test', userFetcher, {
      retryAttempts: 1,
    });

    // ACT
    render(<DataConsumer useApiQuery={useTestApi} />);
    await act(flushPromises);

    // ASSERT
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(mockLoglevelError).toHaveBeenCalled();
    expect(mockLoglevelError).toHaveBeenCalledWith(
      expect.stringContaining('Fetch failed for query'),
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'API Request: Network Error',
        }),
      }),
    );
  });
});
