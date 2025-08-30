/* eslint-disable no-unused-vars */
/**
 * @fileoverview Type definitions for dependency injection.
 */
import type { ApiError, ErrorMapperContext } from './error';

/**
 * Defines the interface for a logger compatible with the library.
 * This allows consumers to inject their own logging implementation.
 */
export interface FactoraLogger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug: (...args: any[]) => void;
  getLevel: () => number;
  levels: {
    DEBUG: number;
  };
}

/** A function to map unknown thrown errors into a standardized ApiError. */
export type ErrorMapper = (
  error: unknown,
  context: ErrorMapperContext,
) => ApiError;

/**
 * A collection of dependencies required by the core API store factory.
 * This allows for a fully dependency-injected and pure core.
 */
export interface FactoraDependencies<T> {
  /** The function responsible for making the actual network request. */
  fetcher: (
    endpoint: string,
    params: Record<string, any>,
    signal?: AbortSignal,
  ) => Promise<T>;

  /** A function to map unknown thrown errors into a standardized ApiError. */
  errorMapper: ErrorMapper;

  /** The logging implementation. */
  logger: FactoraLogger;
}
