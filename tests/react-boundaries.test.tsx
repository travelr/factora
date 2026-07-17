// tests/react-boundaries.test.tsx
import { createQueryHook } from '../src/react/create-query-hook';
import type { KeyedApiState, RequestDescriptor } from '@core/store-engine';
import { mockLogger } from '@test-helper/test-helpers';
import type { SubscriptionManager } from '@utils/subscription-registry';
import { act, render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

const createReactStore = (
  triggerFetch: KeyedApiState<unknown>['triggerFetch'],
) =>
  createStore<KeyedApiState<unknown>>(() => ({
    queries: {},
    queryCount: 0,
    globalError: null,
    triggerFetch,
    refetchStaleQueries: vi.fn(),
    revalidateAgedQueries: vi.fn(),
    clearQueryState: vi.fn(),
    clearAllQueryStates: vi.fn(),
    clearStaleQueries: vi.fn(),
    setGlobalErrorState: vi.fn(),
    setQueryState: vi.fn(),
  }));

describe('React query identity boundaries', () => {
  test('Verifies invalid identities do not fetch and valid subscriptions recover cleanly', async () => {
    const triggerFetch = vi
      .fn<
        (
          key: string,
          forceFetch?: boolean,
          request?: RequestDescriptor,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    const subscribe = vi.fn<(key: string) => symbol>();
    const unsubscribe = vi.fn();
    const subscriptions: SubscriptionManager = {
      subscribe,
      unsubscribe,
      hasSubscribers: vi.fn(() => false),
    };
    const useApiQuery = createQueryHook({
      store: createReactStore(triggerFetch),
      subscriptions,
      endpoint: '/api/identity-boundary',
      description: 'identity boundary',
      logger: mockLogger,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    subscribe
      .mockReturnValueOnce(Symbol('first'))
      .mockReturnValueOnce(Symbol('second'));

    const Consumer = ({ params }: { params: Record<string, unknown> }) => {
      useApiQuery(params);
      return <output data-testid="identity-state" />;
    };
    const mounted = render(<Consumer params={{ id: 'first' }} />);
    await act(async () => undefined);
    mounted.rerender(<Consumer params={circular} />);
    mounted.rerender(<Consumer params={{ id: 'second' }} />);
    await act(async () => undefined);

    expect(triggerFetch).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith(
      triggerFetch.mock.calls[0]?.[0],
      expect.any(Symbol),
    );

    mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenLastCalledWith(
      triggerFetch.mock.calls[1]?.[0],
      expect.any(Symbol),
    );
  });
});
