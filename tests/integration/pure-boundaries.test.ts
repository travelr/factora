// tests/integration/pure-boundaries.test.ts
import { afterEach, describe, expect, test, vi } from 'vitest';

import { _test_clearGcRegistry, mockLogger } from '@test-helper/test-helpers';

describe('pure public entry point boundaries', () => {
  afterEach(async () => {
    const pure = await import('../../src/pure');
    pure.stopApiStoreGarbageCollector();
    _test_clearGcRegistry();
    vi.clearAllMocks();
  });

  test('Verifies its intentional public facades are callable implementations', async () => {
    const pure = await import('../../src/pure');
    const factory = pure.createApiFactoryPure({
      errorMapper: vi.fn(),
      logger: mockLogger,
    });
    const useApiQuery = factory('/pure-boundary', vi.fn());

    pure.initializeApiRegistry({ logger: mockLogger });
    expect(() => pure.refetchAllStaleQueries()).not.toThrow();
    expect(() => pure.revalidateAgedQueries()).not.toThrow();
    expect(() => pure.clearAllApiStores()).not.toThrow();
    expect(pure.startApiStoreGarbageCollector).toBeTypeOf('function');
    expect(pure.stopApiStoreGarbageCollector).toBeTypeOf('function');

    expect(useApiQuery).toBeTypeOf('function');
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('Verifies GC does not schedule or throw when window is unavailable', async () => {
    const pure = await import('../../src/pure');
    const scheduler = {
      clearInterval: vi.fn(),
      setInterval: vi.fn(),
    };
    const originalWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      'window',
    );

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: undefined,
      });

      expect(() =>
        pure.startApiStoreGarbageCollector({ intervalMs: 10, scheduler }),
      ).not.toThrow();
      expect(scheduler.setInterval).not.toHaveBeenCalled();
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});
