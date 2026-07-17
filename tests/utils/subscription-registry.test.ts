// tests/utils/subscription-registry.test.ts
import { createSubscriptionManager } from '@utils/subscription-registry';
import { describe, expect, test } from 'vitest';

describe('subscription registry', () => {
  test('Verifies unknown and duplicate unsubscriptions retain remaining subscribers', () => {
    const subscriptions = createSubscriptionManager();
    const first = subscriptions.subscribe('orders');
    const second = subscriptions.subscribe('orders');

    subscriptions.unsubscribe('unknown', first);
    subscriptions.unsubscribe('orders', Symbol('unknown'));
    expect(subscriptions.hasSubscribers('orders')).toBe(true);

    subscriptions.unsubscribe('orders', first);
    subscriptions.unsubscribe('orders', first);
    expect(subscriptions.hasSubscribers('orders')).toBe(true);

    subscriptions.unsubscribe('orders', second);
    expect(subscriptions.hasSubscribers('orders')).toBe(false);
  });
});
