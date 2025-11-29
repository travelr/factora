import { createTestableApiStore } from '@test-helper/test-helpers';
import { act, render } from '@testing-library/react';
import * as QueryKeyUtils from '@utils/get-query-key';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { flushPromises } from '@test-helper/async-helpers'; // Import flushPromises

const spyGetQueryKey = vi.spyOn(QueryKeyUtils, 'getQueryKey');

describe('API Store Performance', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('Verifies getQueryKey is Memoized and NOT called on every render with stable params', async () => {
    const { useApiQuery } = createTestableApiStore('/api/perf-test', vi.fn());
    const stableParams = { id: 1, filter: 'active' };

    const Wrapper = ({ p }: { p: any }) => {
      useApiQuery(p);
      return <div />;
    };

    const { rerender } = render(<Wrapper p={stableParams} />);

    // Capture initial count (Includes Strict Mode double-invocation)
    const initialCallCount = spyGetQueryKey.mock.calls.length;
    expect(initialCallCount).toBeGreaterThan(0);

    // Re-renders: Wrap in act + flush to silence warnings
    rerender(<Wrapper p={stableParams} />);
    await act(flushPromises);

    rerender(<Wrapper p={stableParams} />);
    await act(flushPromises);

    rerender(<Wrapper p={stableParams} />);
    await act(flushPromises);

    // Assert: Count should not have increased beyond the initial mount
    expect(spyGetQueryKey).toHaveBeenCalledTimes(initialCallCount);
  });
});
