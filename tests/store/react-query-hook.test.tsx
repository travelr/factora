import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { DataConsumer, RenderTracker } from '@test-helper/test-components';
import { createTestableApiStore } from '@test-helper/test-helpers';
import { flushPromises } from '@test-helper/async-helpers';

describe('React query adapter', () => {
  test('Verifies that hook order is preserved when invalid params become valid', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const { useApiQuery } = createTestableApiStore('/api/hook-order', fetcher);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const { rerender } = render(
      <DataConsumer useApiQuery={useApiQuery} params={circular} />,
    );
    expect(screen.getByTestId('error')).not.toHaveTextContent('null');

    rerender(<DataConsumer useApiQuery={useApiQuery} params={{ id: 1 }} />);
    await act(flushPromises);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('Verifies that updating query B does not rerender query A', async () => {
    const fetcher = vi.fn(async (_endpoint, params) => ({ id: params.id }));
    const { useApiQuery, getInternalStore, getQueryKey } =
      createTestableApiStore(
        '/api/render-isolation',
        fetcher,
        {},
        { exposeInternal: true },
      );
    render(
      <>
        <RenderTracker useApiQuery={useApiQuery} params={{ id: 'a' }} />
        <DataConsumer useApiQuery={useApiQuery} params={{ id: 'b' }} />
      </>,
    );
    await act(flushPromises);
    const renderCount = screen.getByTestId('render-count').textContent;
    const keyB = getQueryKey('/api/render-isolation', { id: 'b' });

    await act(async () => {
      await getInternalStore().getState().triggerFetch(keyB, true);
    });
    expect(screen.getByTestId('render-count').textContent).toBe(renderCount);
  });

  test('Verifies that refetch restores a cleared query without remounting', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });
    const { useApiQuery } = createTestableApiStore(
      '/api/clear-refetch',
      fetcher,
    );
    render(<DataConsumer useApiQuery={useApiQuery} params={{ id: 7 }} />);
    await act(flushPromises);
    expect(screen.getByTestId('data')).toHaveTextContent('{"version":1}');

    fireEvent.click(screen.getByTestId('clear-button'));
    expect(screen.getByTestId('data')).toHaveTextContent('null');

    fireEvent.click(screen.getByTestId('refetch-button'));
    await act(flushPromises);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/clear-refetch',
      { id: 7 },
      expect.any(AbortSignal),
    );
    expect(screen.getByTestId('data')).toHaveTextContent('{"version":2}');
  });
});
