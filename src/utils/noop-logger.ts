/**
 * @fileoverview Provides a no-operation logger implementation and related utilities.
 */
import type { FactoraLogger } from '@/types/dependencies';

/**
 * An empty function that does nothing. Useful as a default for optional callbacks.
 */
export const noop = (): void => {};

/**
 * A default, safe logger implementation that performs no operations (a "null object").
 * This is used to prevent runtime errors when a real logger has not yet been injected.
 */
export const noopLogger: FactoraLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  getLevel: () => Number.MAX_SAFE_INTEGER, // A level that effectively disables all logging.
  levels: { DEBUG: 1 },
};
