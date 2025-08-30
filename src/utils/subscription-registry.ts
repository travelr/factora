/**
 * @fileoverview Tracks active subscriptions to query keys without React dependencies.
 * Maintains minimal memory footprint by auto-removing empty keys.
 */

const subscriberRegistry = new Map<string, Set<symbol>>();

/**
 * Manages query key subscriptions for cache invalidation.
 *
 * **Critical behavior**:
 * - Auto-removes keys with zero subscribers (prevents memory leaks)
 * - Uses Symbols for collision-proof subscriber IDs (safe across bundles)
 * - Non-reactive: Pure data structure with no side effects
 */
export const subscriptionManager = {
  /**
   * Registers a new subscription to a query key.
   * @returns Unique subscriber ID for cleanup
   */
  subscribe(key: string): symbol {
    if (!subscriberRegistry.has(key)) {
      subscriberRegistry.set(key, new Set());
    }
    const subscriberId = Symbol();
    subscriberRegistry.get(key)!.add(subscriberId);
    return subscriberId;
  },

  /**
   * Removes a subscription. Automatically cleans empty keys.
   * @note Idempotent - safe to call multiple times for same ID
   */
  unsubscribe(key: string, subscriberId: symbol): void {
    const subscribers = subscriberRegistry.get(key);
    if (subscribers) {
      subscribers.delete(subscriberId);
      if (subscribers.size === 0) {
        subscriberRegistry.delete(key);
      }
    }
  },

  /**
   * Checks if any subscribers exist for a key.
   * @note More efficient than checking count for existence checks
   */
  hasSubscribers(key: string): boolean {
    return (subscriberRegistry.get(key)?.size ?? 0) > 0;
  },
};

// --- Test-only helpers ---
// Conditionally attached so they can be tree-shaken from production builds.
const mode = process.env.NODE_ENV;
if (mode !== 'production') {
  // eslint-disable-next-line no-underscore-dangle
  (subscriptionManager as any)._getSubscriberCount = (key: string): number => {
    return subscriberRegistry.get(key)?.size ?? 0;
  };
  // eslint-disable-next-line no-underscore-dangle
  (subscriptionManager as any)._getRegistrySize = (): number => {
    // This is the new helper needed for the smoke test.
    return subscriberRegistry.size;
  };
  // eslint-disable-next-line no-underscore-dangle
  (subscriptionManager as any)._clearAll = () => {
    subscriberRegistry.clear();
  };
}
