/**
 * @fileoverview A central registry for API stores.
 * This module allows global event handlers (like on window focus or logout) to trigger
 * actions on all active API stores without being directly coupled to them.
 * It uses a Set to maintain strong references to the actions of singleton stores,
 * which is the correct memory model for stores intended to live for the app's lifetime.
 */
import log from 'loglevel';

type ActionFn = () => void;

/**
 * Defines the shape of the globally accessible actions for each store.
 */
export interface StoreActions {
  refetchStaleQueries: ActionFn;
  clearAllQueryStates: ActionFn;
}

// A Set is used to store the action objects, ensuring no duplicates.
// This holds strong references, which is correct for singleton stores.
const allStoreActions = new Set<StoreActions>();

/**
 * An empty function for use as a no-op return value.
 */
const noop = (): void => {};

/**
 * Registers a store's actions with the central registry.
 * This is called automatically when a store is created via the factory.
 * @param {StoreActions} actions - An object containing the store's actions.
 * @returns {() => void} An unregister function to remove the actions from the registry.
 */
export const registerStoreActions = (actions: StoreActions): (() => void) => {
  if (
    typeof actions?.refetchStaleQueries !== 'function' ||
    typeof actions?.clearAllQueryStates !== 'function'
  ) {
    log.error('[API Registry] Attempted to register invalid actions object.');
    return noop;
  }

  allStoreActions.add(actions);
  return () => {
    allStoreActions.delete(actions);
  };
};

/**
 * Iterates through all registered stores and triggers their check for stale queries.
 * This is intended to be called by a global event handler for refetch-on-focus.
 */
export const refetchAllStaleQueries = (): void => {
  if (allStoreActions.size === 0) {
    return;
  }
  log.info(
    `[API Registry] Window focus detected. Checking ${allStoreActions.size} store(s) for stale queries.`,
  );
  allStoreActions.forEach((actions) => {
    try {
      actions.refetchStaleQueries();
    } catch (error) {
      log.error(
        '[API Registry] An error occurred while a store was attempting to refetch stale queries.',
        error,
      );
    }
  });
};

/**
 * Iterates through all registered stores and clears their state.
 * This is intended to be called by a global event handler, such as logout.
 */
export const clearAllApiStores = (): void => {
  if (allStoreActions.size === 0) {
    return;
  }
  log.info(
    `[API Registry] Clearing all data from ${allStoreActions.size} store(s).`,
  );
  allStoreActions.forEach((actions) => {
    try {
      actions.clearAllQueryStates();
    } catch (error) {
      log.error(
        '[API Registry] An error occurred while a store was attempting to clear its state.',
        error,
      );
    }
  });
};

// --- Test-only helpers ---
// This new object is exported only for testing, providing a reliable way to access helpers.
// This is the minimal change required to fix the test failures robustly.
// eslint-disable-next-line no-underscore-dangle
export const _test_only_apiRegistry =
  process.env.NODE_ENV === 'production'
    ? undefined
    : {
        getRegistrySize: (): number => allStoreActions.size,
        clearRegistry: (): void => allStoreActions.clear(),
      };
