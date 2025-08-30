/**
 * @fileoverview Global garbage collector for API stores. Automatically cleans stale queries
 * across all registered stores at regular intervals. Designed to be idempotent and safe for
 * multiple concurrent starts/stops.
 */
import log from 'loglevel';

interface GcScheduler {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export interface GcOptions {
  /** The interval in milliseconds at which the GC sweep runs. @default 120000 */
  intervalMs?: number;
  /** An optional scheduler. Used for testing with fake timers. @default globalThis */
  scheduler?: GcScheduler;
}

const gcStoreRegistry: Array<{ clearStaleQueries: () => void }> = [];

export const registerStoreForGc = (store: {
  clearStaleQueries: () => void;
}) => {
  gcStoreRegistry.push(store);
  return () => {
    const idx = gcStoreRegistry.indexOf(store);
    if (idx >= 0) gcStoreRegistry.splice(idx, 1);
  };
};

const getRegisteredGcStores = () => gcStoreRegistry.slice();

/**
 * Global symbol used to track the active GC interval.
 * Prevents duplicate intervals across multiple start calls.
 * @internal
 */
const GC_GLOBAL_KEY = Symbol.for('__API_STORE_GC_INTERVAL__');

/**
 * Starts the global garbage collector. This function is idempotent.
 *
 * @example
 * // In your application's root component (e.g., App.tsx)
 * React.useEffect(() => {
 *   startApiStoreGarbageCollector();
 *   return () => stopApiStoreGarbageCollector();
 * }, []);
 *
 * @param options Configuration for the GC, primarily for testing.
 */
export const startApiStoreGarbageCollector = (options: GcOptions = {}) => {
  if (typeof window === 'undefined') return;

  const g = globalThis as any;
  if (g[GC_GLOBAL_KEY]) return;

  const { intervalMs = 2 * 60 * 1000, scheduler = globalThis } = options;

  const intervalId: any = scheduler.setInterval(() => {
    // Note: The list of stores is read at the time of the sweep. It's safe if a store
    // deregisters concurrently, as `clearStaleQueries` must be idempotent.
    getRegisteredGcStores().forEach((store) => {
      try {
        store.clearStaleQueries();
      } catch (err) {
        log.error('[GC] store.clearStaleQueries() failed for a store.', err);
      }
    });
  }, intervalMs);

  g[GC_GLOBAL_KEY] = intervalId;
};

/**
 * Stops the global garbage collector.
 * @param scheduler Custom scheduler (should match start scheduler in tests)
 */
export const stopApiStoreGarbageCollector = (
  scheduler: GcScheduler = globalThis,
) => {
  if (typeof window === 'undefined') return;
  const g = globalThis as any;
  const intervalId = g[GC_GLOBAL_KEY];
  if (intervalId) {
    scheduler.clearInterval(intervalId);
    delete g[GC_GLOBAL_KEY];
  }
};

/** --- HMR Disposal Logic for Vite --- */
/** Automatically stops GC during Vite HMR updates to prevent memory leaks */
// @ts-ignore
if (import.meta.hot) {
  // @ts-ignore
  import.meta.hot.dispose(() => stopApiStoreGarbageCollector());
}

/**
 * Clears all stores from the GC registry.
 * INTENDED FOR TEST USE ONLY to ensure a clean state between tests.
 */
export function clearGcStoreRegistry() {
  gcStoreRegistry.length = 0;
}
