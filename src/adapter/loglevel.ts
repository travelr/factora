/**
 * @fileoverview Optional adapter for the 'loglevel' library.
 * This module provides a pre-configured logger object that is compatible with the
 * library's core dependency contract.
 */
import log from 'loglevel';

import type { FactoraLogger } from '@/types/dependencies';

/**
 * A logger object that implements the `FactoraLogger` interface by delegating
 * all calls to the `loglevel` library. This acts as a bridge between the
 * pure library core and the external logging implementation.
 */
export const loglevelAdapter: FactoraLogger = {
  info: (...args: any[]) => log.info(...args),
  warn: (...args: any[]) => log.warn(...args),
  error: (...args: any[]) => log.error(...args),
  debug: (...args: any[]) => log.debug(...args),
  getLevel: () => log.getLevel(),
  levels: {
    DEBUG: log.levels.DEBUG,
  },
};
