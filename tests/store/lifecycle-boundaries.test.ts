// tests/store/lifecycle-boundaries.test.ts
import { attachStoreLifecycle } from '@core/store-lifecycle';
import { RuntimeServices, createPartialStoreHandle } from '@core/runtime';
import { noopLogger } from '@utils/noop-logger';
import { describe, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

describe('store lifecycle registration boundaries', () => {
  test('Verifies a registration failure reports and recovers on a later active transition', () => {
    const runtime = new RuntimeServices();
    const registerStore = vi
      .spyOn(runtime, 'registerStore')
      .mockImplementationOnce(() => {
        throw new Error('registry unavailable');
      })
      .mockImplementationOnce((handle) =>
        RuntimeServices.prototype.registerStore.call(runtime, handle),
      );
    const reportInternalError = vi.spyOn(runtime, 'reportInternalError');
    const store = createStore(() => ({ queryCount: 0 }));
    const dispose = attachStoreLifecycle(
      store,
      createPartialStoreHandle({}),
      runtime,
      noopLogger,
    );

    expect(() => store.setState({ queryCount: 1 })).not.toThrow();
    expect(reportInternalError).toHaveBeenCalledWith(
      'update store lifecycle',
      expect.any(Error),
      noopLogger,
    );

    store.setState({ queryCount: 0 });
    store.setState({ queryCount: 1 });
    expect(registerStore).toHaveBeenCalledTimes(2);
    expect(runtime.getStoreCount()).toBe(1);
    dispose();
  });
});
