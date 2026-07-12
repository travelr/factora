export interface SubscriptionManager {
  subscribe: (key: string) => symbol;
  unsubscribe: (key: string, subscriberId: symbol) => void;
  hasSubscribers: (key: string) => boolean;
}

export const createSubscriptionManager = (): SubscriptionManager => {
  const subscribersByKey = new Map<string, Set<symbol>>();
  return {
    subscribe(key) {
      const subscribers = subscribersByKey.get(key) ?? new Set<symbol>();
      subscribersByKey.set(key, subscribers);
      const id = Symbol();
      subscribers.add(id);
      return id;
    },
    unsubscribe(key, id) {
      const subscribers = subscribersByKey.get(key);
      if (!subscribers) return;
      subscribers.delete(id);
      if (subscribers.size === 0) subscribersByKey.delete(key);
    },
    hasSubscribers: (key) => (subscribersByKey.get(key)?.size ?? 0) > 0,
  };
};
