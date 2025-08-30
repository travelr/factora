/**
 * @fileoverview Unit tests for the Loglevel adapter.
 * Verifies that the adapter correctly delegates calls to the underlying loglevel library.
 */
import { loglevelAdapter } from '@adapter/loglevel';
import log from 'loglevel';
import { describe, expect, test, vi } from 'vitest';

// Spy on all methods of the 'loglevel' library that we use.
const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
const getLevelSpy = vi.spyOn(log, 'getLevel').mockImplementation(() => 0);

describe('loglevelAdapter', () => {
  test('Verifies info() call is delegated to loglevel.info', () => {
    loglevelAdapter.info('test message', { id: 1 });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('test message', { id: 1 });
  });

  test('Verifies warn() call is delegated to loglevel.warn', () => {
    loglevelAdapter.warn('warning', { code: 500 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('warning', { code: 500 });
  });

  test('Verifies error() call is delegated to loglevel.error', () => {
    const err = new Error('test error');
    loglevelAdapter.error('An error occurred', err);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('An error occurred', err);
  });

  test('Verifies debug() call is delegated to loglevel.debug', () => {
    loglevelAdapter.debug('debug info');
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith('debug info');
  });

  test('Verifies getLevel() call is delegated to loglevel.getLevel', () => {
    loglevelAdapter.getLevel();
    expect(getLevelSpy).toHaveBeenCalledTimes(1);
  });
});
