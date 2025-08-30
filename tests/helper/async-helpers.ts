/**
 * @fileoverview Generic, low-level utilities for managing time and promises in async tests.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';

// Define a proper interface for Vitest with optional async method
interface Vitest {
  advanceTimersByTime(ms: number): void;
  advanceTimersByTimeAsync?(ms: number): Promise<void>;
}

/**
 * Robustly flush the microtask queue to ensure promise jobs and React updates settle.
 */
export const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve(); // A second flush handles promises queued by other promises.
};

/**
 * Canonical helper for advancing time in tests, combining the async-friendly
 * timer advance with a promise flush.
 */
export const advanceTimersWithFlush = async (ms: number): Promise<void> => {
  await act(async () => {
    const vitest = vi as unknown as Vitest;

    if (vitest.advanceTimersByTimeAsync) {
      await vitest.advanceTimersByTimeAsync(ms);
    } else {
      vitest.advanceTimersByTime(ms);
    }
  });
  await act(flushPromises);
};

/**
 * Waits for an async condition to be met with precise timing control.
 */
export const waitFor = async (
  callback: () => boolean,
  {
    timeout,
    interval,
    onTimeout,
  }: { timeout: number; interval: number; onTimeout: () => string },
) => {
  const startTime = Date.now();
  while (!callback()) {
    if (Date.now() - startTime > timeout) {
      throw new Error(onTimeout());
    }
    await flushPromises();
    await advanceTimersWithFlush(interval);
  }
};
