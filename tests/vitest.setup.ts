// tests/vitest.setup.ts
import '@testing-library/jest-dom';

import { afterEach, beforeEach, vi } from 'vitest';
/**
 * Global Test Setup: Enforces a consistent testing environment.
 *
 * Default Policy:
 * - Tests run with fake timers by default for deterministic control over async operations.
 * - After each test, all mocks and timers are cleared, and fake timers are
 *   re-enabled as a safety net. This prevents state leakage between tests,
 *   especially from those that might temporarily switch to real timers.
 */
beforeEach(() => {
  // Ensure each test begins with fake timers active.
  vi.useFakeTimers();
});

afterEach(() => {
  // Clear all timers and mock history to ensure test isolation.
  vi.clearAllTimers();
  vi.clearAllMocks();

  // Re-enable fake timers. This is idempotent but acts as a crucial safety net,
  // guaranteeing that a test calling `vi.useRealTimers()` cannot affect subsequent tests.
  vi.useFakeTimers();
});
