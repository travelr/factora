// tests/store/registry-boundaries.test.ts
import {
  clearAllApiStores,
  initializeApiRegistry,
  refetchAllStaleQueries,
  registerStoreActions,
  type StoreActions,
} from '@core/api-store-registry';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { _test_clearGcRegistry, mockLogger } from '@test-helper/test-helpers';

describe('public store-action registration boundaries', () => {
  afterEach(() => {
    _test_clearGcRegistry();
    vi.clearAllMocks();
  });

  test('Verifies malformed actions are rejected without registration and return safe cleanup', () => {
    initializeApiRegistry({ logger: mockLogger });
    const malformedActions = {
      clearAllQueryStates: vi.fn(),
      refetchStaleQueries: 'not-a-function',
    } as unknown as StoreActions;

    const unregister = registerStoreActions(malformedActions);

    expect(() => unregister()).not.toThrow();
    expect(() => unregister()).not.toThrow();
    refetchAllStaleQueries();
    clearAllApiStores();

    expect(malformedActions.clearAllQueryStates).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[Factora runtime] Failed to register store actions.',
      { message: 'Invalid store actions object.' },
    );
    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});
