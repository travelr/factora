/** Public compatibility facade over the default runtime's unified registry. */
import type { FactoraLogger } from '@/types/dependencies';

import {
  createPartialStoreHandle,
  defaultRuntime,
  type StoreHandle,
} from './runtime';

export interface StoreActions {
  refetchStaleQueries: () => void;
  revalidateAgedQueries?: () => void;
  clearAllQueryStates: () => void;
}

export const initializeApiRegistry = (dependencies: {
  logger: FactoraLogger;
}): void => {
  defaultRuntime.setLogger(dependencies.logger);
};

export const registerStoreHandle = (handle: StoreHandle): (() => void) =>
  defaultRuntime.registerStore(handle);

export const registerStoreActions = (actions: StoreActions): (() => void) => {
  if (
    typeof actions?.refetchStaleQueries !== 'function' ||
    typeof actions?.clearAllQueryStates !== 'function'
  ) {
    defaultRuntime.reportInternalError(
      'register store actions',
      new TypeError('Invalid store actions object.'),
    );
    return () => undefined;
  }
  return defaultRuntime.registerStore(createPartialStoreHandle(actions));
};

export const refetchAllStaleQueries = (): void => {
  defaultRuntime.refetchAllStaleQueries();
};

export const revalidateAgedQueries = (): void => {
  defaultRuntime.revalidateAgedQueries();
};

export const clearAllApiStores = (): void => {
  defaultRuntime.clearAllQueryStates();
};
