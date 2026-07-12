/**
 * @fileoverview Internal runtime boundary for store registration, global actions,
 * garbage-collector scheduling, and diagnostic reporting.
 */
import type { FactoraLogger } from '@/types/dependencies';

import { noop, noopLogger } from '../utils/noop-logger';

export interface StoreHandle {
  clearAllQueryStates: () => void;
  clearStaleQueries: () => void;
  refetchStaleQueries: () => void;
}

export interface RuntimeScheduler {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

interface ActiveGarbageCollector {
  id: ReturnType<typeof setInterval>;
  scheduler: RuntimeScheduler;
  logger: FactoraLogger;
}

/**
 * Internal owner for process-wide store coordination.
 *
 * Existing public global functions proxy `defaultRuntime`; individual stores
 * register only while they contain queries. The default logger is intentionally
 * inert so `factora/pure` has no logging-adapter dependency. Timer methods live
 * here to keep engine scheduling injectable and deterministic in tests.
 */
export class RuntimeServices {
  private readonly stores = new Set<StoreHandle>();

  private logger: FactoraLogger = noopLogger;

  private activeGarbageCollector?: ActiveGarbageCollector;

  now(): number {
    return Date.now();
  }

  setTimeout(
    callback: () => void,
    delay: number,
  ): ReturnType<typeof setTimeout> {
    return globalThis.setTimeout(callback, delay);
  }

  clearTimeout(id: ReturnType<typeof setTimeout>): void {
    globalThis.clearTimeout(id);
  }

  registerStore(handle: StoreHandle): () => void {
    this.stores.add(handle);
    return () => this.stores.delete(handle);
  }

  setLogger(logger: FactoraLogger): void {
    this.logger = logger;
  }

  refetchAllStaleQueries(): void {
    if (this.stores.size === 0) return;
    this.logger.info(
      `[API Registry] Window focus detected. Checking ${this.stores.size} store(s) for stale queries.`,
    );
    this.forEachStore('refetch stale queries', (store) =>
      store.refetchStaleQueries(),
    );
  }

  clearAllQueryStates(): void {
    if (this.stores.size === 0) return;
    this.logger.info(
      `[API Registry] Clearing all data from ${this.stores.size} store(s).`,
    );
    this.forEachStore('clear query state', (store) =>
      store.clearAllQueryStates(),
    );
  }

  sweepStaleQueries(logger: FactoraLogger = this.logger): void {
    this.forEachStore(
      'clear stale queries',
      (store) => store.clearStaleQueries(),
      logger,
    );
  }

  startGarbageCollector(
    intervalMs: number,
    scheduler: RuntimeScheduler,
    logger?: FactoraLogger,
  ): void {
    if (typeof window === 'undefined' || this.activeGarbageCollector) return;
    const activeLogger = logger ?? this.logger;
    try {
      const id = scheduler.setInterval(
        () => this.sweepStaleQueries(activeLogger),
        intervalMs,
      );
      this.activeGarbageCollector = {
        id,
        scheduler,
        logger: activeLogger,
      };
    } catch (error) {
      this.reportInternalError('start garbage collector', error, activeLogger);
    }
  }

  stopGarbageCollector(): void {
    // Always clear through the scheduler that created the interval. Accepting a
    // different scheduler at stop time previously leaked custom-scheduler jobs.
    const active = this.activeGarbageCollector;
    if (!active) return;
    try {
      active.scheduler.clearInterval(active.id);
      this.activeGarbageCollector = undefined;
    } catch (error) {
      // Keep the active record so callers can retry the stop operation.
      this.reportInternalError('stop garbage collector', error, active.logger);
    }
  }

  getStoreCount(): number {
    return this.stores.size;
  }

  clearStores(): void {
    this.stores.clear();
  }

  reportInternalError(
    operation: string,
    error: unknown,
    logger: FactoraLogger = this.logger,
  ): void {
    logger.error(`[Factora runtime] Failed to ${operation}.`, {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private forEachStore(
    operation: string,
    action: (store: StoreHandle) => void,
    logger: FactoraLogger = this.logger,
  ): void {
    // Snapshot before iteration: a store may deregister itself during an action.
    // Each failure is isolated so global clear/refetch/GC still reaches peers.
    [...this.stores].forEach((store) => {
      try {
        action(store);
      } catch (error) {
        this.reportInternalError(operation, error, logger);
      }
    });
  }
}

export const createPartialStoreHandle = (
  partial: Partial<StoreHandle>,
): StoreHandle => ({
  clearAllQueryStates: partial.clearAllQueryStates ?? noop,
  clearStaleQueries: partial.clearStaleQueries ?? noop,
  refetchStaleQueries: partial.refetchStaleQueries ?? noop,
});

export const defaultRuntime: RuntimeServices = new RuntimeServices();
