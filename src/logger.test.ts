// src/logger.test.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import { setLogger, loggerInstance } from './logger';
import { loglevelAdapter } from '@adapter/loglevel';

// Keep a reference to the original logger to restore it later
const originalLogger = loglevelAdapter; // Since loggerInstance defaults to loglevelAdapter

describe('Logger Injection', () => {
  afterEach(() => {
    // Restore the original logger after each test to prevent test pollution
    setLogger(originalLogger);
  });

  it('should allow overriding the default logger', () => {
    const mockLogger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      getLevel: vi.fn(),
      levels: { DEBUG: 1 },
    };

    setLogger(mockLogger);

    // Trigger a log event using the public instance
    loggerInstance.error('test message');

    expect(mockLogger.error).toHaveBeenCalledWith('test message');
  });

  it('should use the default loglevelAdapter if no override is provided', () => {
    // Ensure the logger is reset to default
    setLogger(originalLogger);

    const spy = vi.spyOn(originalLogger, 'error');

    loggerInstance.error('another test');

    expect(spy).toHaveBeenCalledWith('another test');
  });

  it('should proxy levels correctly', () => {
      const mockLogger = {
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          getLevel: vi.fn(),
          levels: { DEBUG: 123 },
      };
      setLogger(mockLogger);
      expect(loggerInstance.levels.DEBUG).toBe(123);
  });
});
