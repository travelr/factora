import { describe, it, expect, afterEach, vi } from 'vitest';

// Mocks must be hoisted or defined before imports if using vi.mock (implied context)
// For this test, we assume @adapter/loglevel exports a valid object.
// If it's a 3rd party lib, we might mock it to control the "Default" state.
import { loglevelAdapter } from '@adapter/loglevel';
import { setLogger } from 'src';
import { loggerInstance } from 'src/logger';

// Mock the default adapter to ensure we have a baseline spy
vi.mock('@adapter/loglevel', () => ({
  loglevelAdapter: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getLevel: vi.fn(() => 1),
    levels: { DEBUG: 1 },
  },
}));

describe('Logger Architecture', () => {
  // We keep a reference to the mocked default adapter
  const defaultLogger = loglevelAdapter;

  afterEach(() => {
    setLogger(defaultLogger);
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('Integration & Switching', () => {
    it('should redirect logs to the new logger when setLogger is called', () => {
      // 1. Setup a "silent" / custom mock logger
      const customLogger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        getLevel: () => 0,
        levels: { DEBUG: 0 },
      };

      // 2. Inject the custom logger
      setLogger(customLogger);

      // 3. Act: call the exported proxy instance
      loggerInstance.error('Test Error Message');

      // 4. Assert: The NEW logger received the call
      expect(customLogger.error).toHaveBeenCalledWith('Test Error Message');

      // 5. Assert: The OLD (default) logger did NOT receive the call
      expect(defaultLogger.error).not.toHaveBeenCalled();
    });

    it('Pure (Proxy): should respect setLogger updates dynamically', () => {
      const mockLogger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        getLevel: () => 0,
        levels: { DEBUG: 0 },
      };

      // SIMULATION: A function that relies on the global 'loggerInstance'
      // This mimics 'createApiFactoryPure' utilizing the proxy
      const someService = () => {
        loggerInstance.info('Pure Proxy Check');
      };

      // Switch logger
      setLogger(mockLogger);

      // Run service
      someService();

      // Verify delegation
      expect(mockLogger.info).toHaveBeenCalledWith('Pure Proxy Check');
    });

    it('Pure (Fixed): specific logger references should IGNORE setLogger', () => {
      // 1. Create a specific logger (simulating a "Fixed" injection)
      const fixedLogger = {
        ...defaultLogger,
        info: vi.fn(), // Spy on this specific instance
      };

      const newGlobalLogger = {
        ...defaultLogger,
        info: vi.fn(),
      };

      // 2. SIMULATION: A factory that accepted a specific logger argument at creation time
      // This mimics `createApiFactoryPure(fixedLogger)`
      const fixedService = {
        doWork: () => fixedLogger.info('Fixed Work'),
      };

      // 3. Switch the global logger
      setLogger(newGlobalLogger);

      // 4. Verify Global State changed
      loggerInstance.info('Global Check');
      expect(newGlobalLogger.info).toHaveBeenCalledWith('Global Check');

      // 5. Verify Fixed Service did NOT change
      fixedService.doWork();
      expect(fixedLogger.info).toHaveBeenCalledWith('Fixed Work');
      expect(newGlobalLogger.info).not.toHaveBeenCalledWith('Fixed Work');
    });
  });

  describe('API & Properties', () => {
    it('should proxy property getters (levels) correctly', () => {
      const mockLoggerWithLevels = {
        ...defaultLogger,
        levels: { DEBUG: 999, ERROR: 1 },
      };

      setLogger(mockLoggerWithLevels);

      // It should access the property on the CURRENT logger, not the initial one
      expect(loggerInstance.levels.DEBUG).toBe(999);
    });

    it('should proxy methods (getLevel) correctly', () => {
      const mockLogger = {
        ...defaultLogger,
        getLevel: vi.fn().mockReturnValue(5),
      };

      setLogger(mockLogger);

      const level = loggerInstance.getLevel();
      expect(level).toBe(5);
      expect(mockLogger.getLevel).toHaveBeenCalled();
    });
  });
});
