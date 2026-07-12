import { act, render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { DataConsumer } from '@test-helper/test-components';
import { createTestableApiStore } from '@test-helper/test-helpers';
import { flushPromises } from '@test-helper/async-helpers';

describe('cache semantics', () => {
  test.each([false, 0, '', null])(
    'Verifies that successful falsy payloads are cached (%p)',
    async (payload) => {
      const fetcher = vi.fn().mockResolvedValue(payload);
      const { useApiQuery } = createTestableApiStore('/api/falsy', fetcher);
      const first = render(<DataConsumer useApiQuery={useApiQuery} />);
      await act(flushPromises);
      first.unmount();

      render(<DataConsumer useApiQuery={useApiQuery} />);
      await act(flushPromises);

      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  test('Verifies that a successful timestamp of zero is treated as cached data', async () => {
    vi.setSystemTime(0);
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const { useApiQuery } = createTestableApiStore('/api/epoch-cache', fetcher);
    const first = render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);
    first.unmount();

    render(<DataConsumer useApiQuery={useApiQuery} />);
    await act(flushPromises);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('Verifies that original ISO strings and Date objects reach the fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const { useApiQuery } = createTestableApiStore('/api/types', fetcher);
    const date = new Date('2024-01-01T00:00:00.000Z');
    render(
      <DataConsumer
        useApiQuery={useApiQuery}
        params={{ iso: date.toISOString(), date }}
      />,
    );
    await act(flushPromises);

    expect(fetcher.mock.calls[0][1].iso).toBe(date.toISOString());
    expect(fetcher.mock.calls[0][1].date).toBe(date);
  });
});
