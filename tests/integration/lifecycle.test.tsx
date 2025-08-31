/**
 * @fileoverview This integration test suite validates the complete, end-to-end
 * lifecycle of API stores, ensuring they behave correctly from creation to
 * garbage collection to prevent long-term memory leaks.
 */

import { _test_only_apiRegistry } from '@core/api-store-registry';
import { act, cleanup, render, screen } from '@testing-library/react';
import { subscriptionManager } from '@utils/subscription-registry';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DataConsumer } from '@test-helper/test-components';
import {
  _test_clearGcRegistry,
  _test_getGcRegistrySize,
  createTestableApiStore,
  _test_runGlobalGc,
} from '@test-helper/test-helpers';
import {
  flushPromises,
  advanceTimersWithFlush,
} from '@test-helper/async-helpers';
import { createRetryableError } from '@test-helper/error-generators';

afterEach(() => {
  // Isolate the integration tests from each other.
  cleanup();
  _test_clearGcRegistry();
  _test_only_apiRegistry?.clearRegistry();
  (subscriptionManager as any)._clearAll();
});

describe('API Store End-to-End Lifecycle', () => {
  /**
   * This is a high-level smoke test to verify the store's entire lifecycle,
   * specifically its ability to self-deregister from all global registries
   * to prevent long-term memory leaks in a long-lived application.
   */
  test('Verifies stores and components correctly deregister from all global registries', async () => {
    // ARRANGE: Get test-only helpers to inspect the global registry sizes.
    const getActionRegistrySize = _test_only_apiRegistry!.getRegistrySize;
    const getSubscriberRegistrySize = (subscriptionManager as any)
      ._getRegistrySize;
    const gcGracePeriod = 50; // Use a short, explicit grace period for the test.

    // Capture the initial state of all three registries.
    expect(_test_getGcRegistrySize()).toBe(0);
    expect(getActionRegistrySize()).toBe(0);
    expect(getSubscriberRegistrySize()).toBe(0);

    // ACT 1: In a loop, create stores, render them briefly, and unmount them.
    for (let i = 0; i < 5; i++) {
      const mockFetch = vi.fn().mockResolvedValue({ value: `data-${i}` });
      const { useApiQuery } = createTestableApiStore(
        `/api/leak-test/${i}`,
        mockFetch,
        { gcGracePeriod },
      );
      const { unmount } = render(<DataConsumer useApiQuery={useApiQuery} />);
      await act(flushPromises);
      unmount();
    }

    // ASSERT 1 (IMMEDIATE): The component-level subscriber registry should be empty.
    expect(getSubscriberRegistrySize()).toBe(0);
    expect(_test_getGcRegistrySize()).toBe(5);

    // ACT 2: Simulate time passing to make the cached data stale.
    await advanceTimersWithFlush(gcGracePeriod + 1);

    // ACT 3: Simulate a global GC sweep.
    act(() => _test_runGlobalGc());
    await act(flushPromises);

    // ACT 4: Wait for the store-level cleanup debounce period (1500ms).
    await advanceTimersWithFlush(2000);

    // ASSERT 2 (DELAYED): The store-level registries should now be empty.
    expect(_test_getGcRegistrySize()).toBe(0);
    expect(getActionRegistrySize()).toBe(0);
  });

  /**
   * This test simulates a "concurrent error storm" to ensure that an error
   * and subsequent retry loop in one query does not interfere with the successful
   * lifecycle of a completely separate query.
   */
  test('Verifies an error in one query does not affect an independent concurrent query', async () => {
    // ARRANGE: Create two separate stores.
    // Store 1 will be configured to fail and retry.
    const mockFetchError = vi
      .fn()
      .mockRejectedValue(createRetryableError('Network Error', 500));
    const { useApiQuery: useApiQueryError } = createTestableApiStore(
      '/api/error-storm',
      mockFetchError,
      { retryAttempts: 3 },
    );

    // Store 2 will be configured to succeed.
    const mockFetchSuccess = vi
      .fn()
      .mockResolvedValue({ value: 'success data' });
    const { useApiQuery: useApiQuerySuccess } = createTestableApiStore(
      '/api/success-path',
      mockFetchSuccess,
    );

    // ACT: Render both consumers simultaneously.
    render(
      <div>
        <DataConsumer useApiQuery={useApiQueryError} />
        <DataConsumer useApiQuery={useApiQuerySuccess} />
      </div>,
    );

    await act(flushPromises);

    // ASSERT:
    // The error component should be in a loading state, waiting for a retry.
    expect(screen.getAllByTestId('loading')[0]).toHaveTextContent('true');
    expect(screen.getAllByTestId('error')[0]).not.toHaveTextContent('null');

    // CRITICAL: The success component should have loaded its data correctly,
    // completely unaffected by the other query's error state.
    expect(screen.getAllByTestId('loading')[1]).toHaveTextContent('false');
    expect(screen.getAllByTestId('data')[1]).toHaveTextContent(
      '{"value":"success data"}',
    );
    expect(screen.getAllByTestId('error')[1]).toHaveTextContent('null');
  });
});
