import { loglevelAdapter } from '@adapter/loglevel';

import type { FactoraLogger } from '@/types/dependencies';

export type Logger = FactoraLogger;

let currentLogger: Logger = loglevelAdapter;

/**
 * A proxy logger that delegates to the currently configured logger instance.
 * This allows the logger to be swapped at runtime via `setLogger` while maintaining
 * references in dependency-injected factories.
 */
export const loggerInstance: Logger = {
  trace: (...args: any[]) => currentLogger.trace(...args),
  info: (...args: any[]) => currentLogger.info(...args),
  warn: (...args: any[]) => currentLogger.warn(...args),
  error: (...args: any[]) => currentLogger.error(...args),
  debug: (...args: any[]) => currentLogger.debug(...args),
  getLevel: () => currentLogger.getLevel(),
  get levels() {
    return currentLogger.levels;
  },
};

/**
 * Allows overriding the default logger instance used by Factora.
 * This is useful for testing or integrating with a different logging library.
 *
 * @param newLogger The logger instance to use.
 */
export const setLogger = (newLogger: Logger) => {
  currentLogger = newLogger;
};
