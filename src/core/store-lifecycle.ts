/**
 * @fileoverview Keeps a store registered with the internal runtime only while
 * it owns cached queries, with a debounce for rapid mount/unmount transitions.
 */
import type { FactoraLogger } from '@/types/dependencies';
import type { StoreApi } from 'zustand/vanilla';

import { subscribeToQueryCount } from '../utils/zustand-utils';
import type { RuntimeServices, StoreHandle } from './runtime';

const DEREGISTRATION_DELAY_MS = 1_500;

/**
 * Registers a store only while it owns cached queries.
 *
 * Registration begins on the first query instead of factory creation, so unused
 * factories do not stay in the global runtime. Deregistration is delayed to
 * tolerate React Strict Mode and rapid route transitions. The count watcher
 * intentionally remains active after deregistration so later reuse can register
 * the same store again.
 */
export const attachStoreLifecycle = <T extends { queryCount: number }>(
  store: StoreApi<T>,
  handle: StoreHandle,
  runtime: RuntimeServices,
  logger: FactoraLogger,
): (() => void) => {
  let unregisterStore: (() => void) | undefined;
  let deregisterTimer: ReturnType<typeof setTimeout> | undefined;

  const unsubscribe = subscribeToQueryCount(
    store,
    (count) => {
      if (count > 0) {
        if (deregisterTimer !== undefined) {
          const timerToCancel = deregisterTimer;
          deregisterTimer = undefined;
          try {
            runtime.clearTimeout(timerToCancel);
          } catch (error) {
            runtime.reportInternalError(
              'cancel store deregistration',
              error,
              logger,
            );
          }
        }
        unregisterStore ??= runtime.registerStore(handle);
        return;
      }

      if (deregisterTimer === undefined) {
        deregisterTimer = runtime.setTimeout(() => {
          deregisterTimer = undefined;
          if (store.getState().queryCount === 0) {
            try {
              unregisterStore?.();
              unregisterStore = undefined;
            } catch (error) {
              runtime.reportInternalError(
                'deregister empty store',
                error,
                logger,
              );
            }
          }
        }, DEREGISTRATION_DELAY_MS);
      }
    },
    (error) =>
      runtime.reportInternalError('update store lifecycle', error, logger),
  );

  return () => {
    if (deregisterTimer !== undefined) {
      try {
        runtime.clearTimeout(deregisterTimer);
      } catch (error) {
        runtime.reportInternalError(
          'dispose store lifecycle timer',
          error,
          logger,
        );
      }
      deregisterTimer = undefined;
    }
    try {
      unregisterStore?.();
    } catch (error) {
      runtime.reportInternalError('unregister disposed store', error, logger);
    } finally {
      unregisterStore = undefined;
      unsubscribe();
    }
  };
};
