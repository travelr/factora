import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, type Mock, test, vi } from 'vitest';

import { RenderTracker } from '@test-helper/test-components';
import {
  _test_clearGcRegistry,
  createTestableApiStore,
} from '@test-helper/test-helpers';
import { flushPromises } from '@test-helper/async-helpers';
import { ApiStoreOptions } from '@/types/store';

afterEach(() => {
  // 1. Unmount any React components to prevent memory leaks and side effects.
  cleanup();
  // 2. Clear our test-local GC registry to ensure test isolation.
  _test_clearGcRegistry();
});

/**
 * A local, specialized test setup function for this file.
 * It handles the common boilerplate of creating a store and rendering the
 * `RenderTracker` component, which is used in most tests here, reducing
 * code duplication.
 */
const setupRenderTest = async (options: ApiStoreOptions = {}, mock?: Mock) => {
  const mockFetch =
    mock ?? vi.fn().mockResolvedValue({ value: 'default test data' });
  const testStore = createTestableApiStore(
    '/api/render-test',
    mockFetch,
    options,
  );

  const renderResult = render(
    <RenderTracker useApiQuery={testStore.useApiQuery} />,
  );
  await act(flushPromises);

  return { ...testStore, mockFetch, screen, ...renderResult };
};

describe('API store rendering precision', () => {
  /**
   * This is a basic but critical test to ensure that the hook's state updates
   * are stable and do not trigger cascading or infinite re-renders, which would
   * result in a "Maximum update depth exceeded" error from React.
   */
  test('avoids "Maximum update depth exceeded" error with stable state', async () => {
    await setupRenderTest(
      {},
      vi.fn(async () => ({ value: 'test data' })),
    );

    // The total render count should be a small, finite number. This assertion is non-brittle,
    // as the exact number can vary with React versions, but it should be low.
    expect(
      parseInt(screen.getByTestId('render-count').textContent!, 10),
    ).toBeLessThan(5);
    expect(screen.getByTestId('data').textContent).toBe(
      '{"value":"test data"}',
    );
  });

  /**
   * This test validates the precision of the store's state selectors (a core feature of Zustand).
   * It ensures that a component only re-renders when a slice of the state that it
   * actually subscribes to has changed. It also verifies stability by showing that
   * actions not affecting the state slice do not cause re-renders.
   */
  test('Verifies component only re-renders when its subscribed state slice changes', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ value: 'initial' })
      .mockResolvedValueOnce({ value: 'updated' });
    const { clearStaleQueries } = await setupRenderTest({}, mockFetch);

    const getRenderCount = () =>
      parseInt(screen.getByTestId('render-count').textContent!, 10);

    const initialRenderCount = getRenderCount();

    // ACT 1: Trigger an internal store action (a GC sweep) that does NOT
    // affect this component's query state.
    act(() => clearStaleQueries());
    await act(flushPromises);

    // ASSERT 1: The component should not have re-rendered, proving stability.
    expect(getRenderCount()).toBe(initialRenderCount);

    // ACT 2: Now, trigger a relevant state change by refetching.
    act(() => screen.getByTestId('refetch-button').click());
    expect(screen.getByTestId('loading').textContent).toBe('true'); // Verify immediate loading state update.

    await act(flushPromises); // Wait for the refetch to complete.

    // ASSERT 2: The render count should now have increased, and the data should be updated.
    expect(getRenderCount()).toBeGreaterThan(initialRenderCount);
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('data').textContent).toBe('{"value":"updated"}');
  });

  /**
   * This test directly checks for render loops by using a minimal component. It confirms
   * the number of renders aligns with expectations for a modern React (Strict Mode) environment,
   * ensuring it is a small, finite number.
   */
  test('Verifies the number of initial renders is stable and finite', async () => {
    const mockFetch = vi.fn(async () => ({ value: 'test' }));
    const { useApiQuery } = createTestableApiStore('/api/test-loop', mockFetch);

    // This component is sensitive to how the hook returns state. If the hook's state
    // management wasn't precise, it could trigger an infinite render loop.
    const StressTestComponent = () => {
      useApiQuery(); // Subscribes to the hook.
      const renderCountRef = React.useRef(0);
      renderCountRef.current++;
      return (
        <div data-testid="stress-render-count">{renderCountRef.current}</div>
      );
    };

    render(<StressTestComponent />);
    await act(flushPromises);

    // This assertion confirms the render count is stable and finite. Instead of a
    // brittle exact number, we assert it's within a small, reasonable limit.
    // This accommodates differences in React versions and Strict Mode.
    expect(
      parseInt(screen.getByTestId('stress-render-count').textContent!, 10),
    ).toBeLessThan(5);
  });
});
