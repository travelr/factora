/**
 * @fileoverview Unit tests for the Axios adapter.
 * This file verifies that the axiosErrorMapper correctly classifies various
 * Axios and non-Axios errors into the library's standard ApiError format.
 */

import { axiosErrorMapper } from '@adapter/axios';
import axios, { type AxiosError } from 'axios';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Define a reusable base context for all tests to keep them DRY.
const baseContext = { endpoint: '/test', description: 'Test Operation' };

// Restore system time after each test to ensure test isolation.
afterEach(() => {
  vi.useRealTimers();
});

describe('axiosErrorMapper', () => {
  describe('Axios Error Classification', () => {
    test('Verifies a client-side abort error is identified correctly', () => {
      // Modern versions of Axios use axios.Cancel and set the `code` property.
      const abortError: any = new axios.Cancel('Request aborted');
      abortError.code = 'ERR_CANCELED';
      const parsed = axiosErrorMapper(abortError, baseContext);

      expect(parsed.isAbort).toBe(true);
      expect(parsed.retryable).toBe(false);
      expect(parsed.message).toContain('Request aborted');
      expect(parsed.errorCode).toBe('ERR_CANCELED');
    });

    test('Verifies a timeout error is marked as retryable', () => {
      const timeoutError: Partial<AxiosError> = {
        isAxiosError: true,
        message: 'Timeout',
        code: 'ECONNABORTED', // Axios's specific code for a timeout.
      };
      const parsed = axiosErrorMapper(timeoutError, baseContext);

      expect(parsed.retryable).toBe(true);
      expect(parsed.errorCode).toBe('ECONNABORTED');
      expect(parsed.message).toContain('Timeout');
    });

    test('Verifies a 5xx server error is marked as retryable', () => {
      const serverError: Partial<AxiosError> = {
        isAxiosError: true,
        message: 'Server Error',
        response: {
          status: 503,
          data: null,
          statusText: 'Service Unavailable',
          headers: {},
          config: {} as any,
        },
      };
      const parsed = axiosErrorMapper(serverError, baseContext);

      expect(parsed.retryable).toBe(true);
      expect(parsed.status).toBe(503);
      expect(parsed.errorCode).toBe('HTTP_503');
    });

    test('Verifies a 4xx client error is marked as not retryable', () => {
      const clientError: Partial<AxiosError> = {
        isAxiosError: true,
        message: 'Client Error',
        response: {
          status: 404,
          data: null,
          statusText: 'Not Found',
          headers: {},
          config: {} as any,
        },
      };
      const parsed = axiosErrorMapper(clientError, baseContext);

      expect(parsed.retryable).toBe(false);
      expect(parsed.status).toBe(404);
      expect(parsed.errorCode).toBe('HTTP_404');
    });

    test('Verifies a generic network error without a response is not retryable', () => {
      const networkError: Partial<AxiosError> = {
        isAxiosError: true,
        message: 'Network Error',
        code: 'ENOTFOUND',
        response: undefined, // Key condition: no response from server.
      };
      const parsed = axiosErrorMapper(networkError, baseContext);

      expect(parsed.retryable).toBe(false);
      expect(parsed.errorCode).toBe('ENOTFOUND');
      expect(parsed.message).toContain('Network Error');
    });
  });

  describe('Retry-After Header Parsing', () => {
    const createRateLimitError = (
      retryAfterHeader: string | number,
    ): Partial<AxiosError> => ({
      isAxiosError: true,
      message: 'Rate Limited',
      response: {
        status: 429,
        headers: { 'retry-after': retryAfterHeader },
        data: null,
        statusText: 'Too Many Requests',
        config: {} as any,
      },
    });

    test('Verifies it parses fractional-second header ("0.5") to 500ms', () => {
      const err = createRateLimitError('0.5');
      const parsed = axiosErrorMapper(err, baseContext);
      expect(parsed.retryAfter).toBe(500);
      expect(parsed.retryable).toBe(true);
    });

    test('Verifies it parses integer-second header ("2") to 2000ms', () => {
      const err = createRateLimitError('2');
      const parsed = axiosErrorMapper(err, baseContext);
      expect(parsed.retryAfter).toBe(2000);
      expect(parsed.retryable).toBe(true);
    });

    test('Verifies it parses HTTP-date header and returns correct positive delta', () => {
      const nowOnTheSecond = Math.floor(Date.now() / 1000) * 1000;
      vi.setSystemTime(nowOnTheSecond);
      const httpDate = new Date(nowOnTheSecond + 3000).toUTCString();
      const err = createRateLimitError(httpDate);
      const parsed = axiosErrorMapper(err, baseContext);
      expect(parsed.retryAfter).toBe(3000);
      expect(parsed.retryable).toBe(true);
    });

    test('Verifies an HTTP-date in the past yields retryAfter = 0', () => {
      const now = Date.now();
      vi.setSystemTime(now);
      const pastDate = new Date(now - 5000).toUTCString();
      const err = createRateLimitError(pastDate);
      const parsed = axiosErrorMapper(err, baseContext);
      expect(parsed.retryAfter).toBe(0);
    });

    test('Verifies no retry-after header yields undefined retryAfter but is still retryable', () => {
      const err: Partial<AxiosError> = {
        isAxiosError: true,
        message: 'Rate limit',
        response: {
          status: 429,
          headers: {},
          data: null,
          statusText: 'Too Many Requests',
          config: {} as any,
        },
      };
      const parsed = axiosErrorMapper(err, baseContext);
      expect(parsed.retryAfter).toBeUndefined();
      expect(parsed.retryable).toBe(true);
    });
  });

  describe('Non-Axios Error Handling', () => {
    test('Verifies a standard Error object is handled gracefully', () => {
      const thrown = new Error('Something broke');
      const parsed = axiosErrorMapper(thrown, baseContext);

      expect(parsed.message).toContain('Something broke');
      expect(parsed.retryable).toBe(false);
      expect(parsed.originalError).toBe(thrown);
    });

    test('Verifies a plain string thrown as an error is handled', () => {
      const thrown = 'A string error';
      const parsed = axiosErrorMapper(thrown, baseContext);

      expect(parsed.message).toContain('An unknown error occurred');
      expect(parsed.retryable).toBe(false);
    });

    test('Verifies a null or undefined error produces a generic message', () => {
      const parsedNull = axiosErrorMapper(null, baseContext);
      expect(parsedNull.message).toContain('An unknown error occurred');

      const parsedUndefined = axiosErrorMapper(undefined, baseContext);
      expect(parsedUndefined.message).toContain('An unknown error occurred');
    });
  });

  describe('Context Handling', () => {
    test('Verifies it preserves all provided context values', () => {
      const error = new Error('test');
      const fullContext = {
        endpoint: '/users',
        params: { id: 1 },
        description: 'Fetch User Data',
        attempt: 3,
      };
      const parsed = axiosErrorMapper(error, fullContext);

      expect(parsed.context).toEqual(fullContext);
    });
  });
});
