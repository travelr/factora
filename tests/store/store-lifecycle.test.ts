import { attachStoreLifecycle } from '@core/store-lifecycle';
import { RuntimeServices, createPartialStoreHandle } from '@core/runtime';
import { noopLogger } from '@utils/noop-logger';
import { describe, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

describe('store lifecycle watcher', () => {
  test('Verifies that failed debounce cancellation does not block later deregistration', () => {
    const runtime = new RuntimeServices();
    const schedule = vi
      .spyOn(runtime, 'setTimeout')
      .mockReturnValueOnce(1 as never)
      .mockReturnValueOnce(2 as never);
    vi.spyOn(runtime, 'clearTimeout').mockImplementation(() => {
      throw new Error('timer cleanup failed');
    });
    const reportError = vi.spyOn(runtime, 'reportInternalError');
    const store = createStore(() => ({ queryCount: 0 }));
    const dispose = attachStoreLifecycle(
      store,
      createPartialStoreHandle({}),
      runtime,
      noopLogger,
    );

    store.setState({ queryCount: 1 });
    store.setState({ queryCount: 0 });
    store.setState({ queryCount: 1 });
    store.setState({ queryCount: 0 });

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      'cancel store deregistration',
      expect.any(Error),
      noopLogger,
    );
    dispose();
  });

  test('Verifies that disposal unregisters and unsubscribes when timer cleanup fails', () => {
    const runtime = new RuntimeServices();
    vi.spyOn(runtime, 'setTimeout').mockReturnValue(1 as never);
    vi.spyOn(runtime, 'clearTimeout').mockImplementation(() => {
      throw new Error('timer cleanup failed');
    });
    const reportError = vi.spyOn(runtime, 'reportInternalError');
    const store = createStore(() => ({ queryCount: 0 }));
    const dispose = attachStoreLifecycle(
      store,
      createPartialStoreHandle({}),
      runtime,
      noopLogger,
    );

    store.setState({ queryCount: 1 });
    expect(runtime.getStoreCount()).toBe(1);
    store.setState({ queryCount: 0 });

    expect(dispose).not.toThrow();
    expect(runtime.getStoreCount()).toBe(0);
    expect(reportError).toHaveBeenCalledWith(
      'dispose store lifecycle timer',
      expect.any(Error),
      noopLogger,
    );

    store.setState({ queryCount: 1 });
    expect(runtime.getStoreCount()).toBe(0);
  });
});
