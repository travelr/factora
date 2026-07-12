/** Compatibility facade for the default runtime's garbage collector. */
import type { FactoraLogger } from '@/types/dependencies';

import {
  createPartialStoreHandle,
  defaultRuntime,
  type RuntimeScheduler,
} from './runtime';

const DEFAULT_GC_INTERVAL_MS = 2 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface GcOptions {
  /** Sweep interval in milliseconds. Defaults to two minutes. */
  intervalMs?: number;
  /** Injectable interval scheduler, primarily for deterministic tests. */
  scheduler?: RuntimeScheduler;
  /** Logger used for failures raised during GC sweeps. */
  logger?: FactoraLogger;
}

export const registerStoreForGc = (store: {
  clearStaleQueries: () => void;
}): (() => void) =>
  defaultRuntime.registerStore(createPartialStoreHandle(store));

export const startApiStoreGarbageCollector = (
  options: GcOptions = {},
): void => {
  const requestedInterval = options.intervalMs ?? DEFAULT_GC_INTERVAL_MS;
  const intervalMs =
    Number.isFinite(requestedInterval) && requestedInterval > 0
      ? Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.floor(requestedInterval)))
      : DEFAULT_GC_INTERVAL_MS;
  if (intervalMs !== requestedInterval) {
    options.logger?.warn('[Factora GC] Invalid interval; using a safe value.', {
      fallback: intervalMs,
    });
  }
  defaultRuntime.startGarbageCollector(
    intervalMs,
    options.scheduler ?? globalThis,
    options.logger,
  );
};

// The optional argument remains accepted for source compatibility. The runtime
// intentionally stops through the scheduler that created the active interval.
export const stopApiStoreGarbageCollector = (
  _scheduler: RuntimeScheduler = globalThis,
): void => {
  defaultRuntime.stopGarbageCollector();
};

export function clearGcStoreRegistry(): void {
  defaultRuntime.clearStores();
}
