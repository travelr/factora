// tests/utils/api-error-handler.test.ts
import { handleApiError } from '@utils/api-error-handler';
import axios from 'axios';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Define a reusable base context for all tests to keep them DRY.
const baseContext = { endpoint: '/test', description: 'Test Operation' };

// Restore system time after each test to ensure test isolation.
afterEach(() => {
  vi.useRealTimers();
});

describe('handleApiError', () => {
  describe('Axios Error Classification', () => {
    test('Verifies a client-side abort error is identified correctly', () => {
      // Modern versions of Axios use axios.Cancel and set the `code` property.
      const abortError: any = new axios.Cancel('Request aborted');
      abortError.code = 'ERR_CANCELED';
      const parsed = handleApiError(abortError, baseContext);

      expect(parsed.isAbort).toBe(true);
      expect(parsed.retryable).toBe(false);
      expect(parsed.message).toContain('Request aborted');
      // The production code prefers `error.code` when available, which is 'ERR_CANCELED' for modern Axios.
      expect(parsed.errorCode).toBe('ERR_CANCELED');
    });

    test('Verifies a timeout error is marked as retryable', () => {
      const timeoutError: any = new Error('Timeout');
      timeoutError.isAxiosError = true;
      timeoutError.code = 'ECONNABORTED'; // Axios's specific code for a timeout.
      const parsed = handleApiError(timeoutError, baseContext);

      expect(parsed.retryable).toBe(true);
      expect(parsed.errorCode).toBe('ECONNABORTED');
      expect(parsed.message).toContain('Request timed out');
    });

    test('Verifies a 5xx server error is marked as retryable', () => {
      const serverError: any = {
        isAxiosError: true,
        response: { status: 503, statusText: 'Service Unavailable' },
      };
      const parsed = handleApiError(serverError, baseContext);

      expect(parsed.retryable).toBe(true);
      expect(parsed.status).toBe(503);
      expect(parsed.errorCode).toBe('HTTP_503');
    });

    test('Verifies a 4xx client error is marked as not retryable', () => {
      const clientError: any = {
        isAxiosError: true,
        response: { status: 404, statusText: 'Not Found' },
      };
      const parsed = handleApiError(clientError, baseContext);

      expect(parsed.retryable).toBe(false);
      expect(parsed.status).toBe(404);
      expect(parsed.errorCode).toBe('HTTP_404');
    });

    test('Verifies a generic network error without a response is not retryable', () => {
      const networkError: any = new Error('Network Error');
      networkError.isAxiosError = true;
      networkError.code = 'ENOTFOUND';
      networkError.response = undefined; // Key condition: no response from server.
      const parsed = handleApiError(networkError, baseContext);

      expect(parsed.retryable).toBe(false);
      expect(parsed.errorCode).toBe('ENOTFOUND');
      expect(parsed.message).toContain('Request failed');
    });
  });

  describe('Retry-After Header Parsing', () => {
    test('Verifies it parses fractional-second header ("0.5") to 500ms', () => {
      vi.setSystemTime(Date.now());
      const err = {
        isAxiosError: true,
        response: { status: 429, headers: { 'retry-after': '0.5' } },
      } as any;

      const parsed = handleApiError(err, baseContext);
      expect(parsed.retryAfter).toBe(500);
    });

    test('Verifies it parses integer-second header ("2") to 2000ms', () => {
      vi.setSystemTime(Date.now());
      const err = {
        isAxiosError: true,
        response: { status: 429, headers: { 'retry-after': '2' } },
      } as any;

      const parsed = handleApiError(err, baseContext);
      expect(parsed.retryAfter).toBe(2000);
    });

    test('Verifies it parses HTTP-date header and returns correct positive delta', () => {
      // ARRANGE: Create timestamps that are perfectly on a second boundary.
      // The `toUTCString()` method truncates milliseconds, which can cause test flakiness.
      // By starting with a rounded timestamp, we ensure the calculation is exact.
      const nowOnTheSecond = Math.floor(Date.now() / 1000) * 1000;
      vi.setSystemTime(nowOnTheSecond);

      const futureMs = nowOnTheSecond + 3000; // A precise 3-second delta.
      const httpDate = new Date(futureMs).toUTCString();
      const err = {
        isAxiosError: true,
        response: { status: 429, headers: { 'retry-after': httpDate } },
      } as any;

      // ACT
      const parsed = handleApiError(err, baseContext);

      // ASSERT: Because we eliminated millisecond rounding, the delta should be exact.
      expect(parsed.retryAfter).toBe(3000);
    });

    test('Verifies an HTTP-date in the past yields retryAfter = 0', () => {
      const now = Date.now();
      vi.setSystemTime(now);
      const pastDate = new Date(now - 5000).toUTCString();
      const err = {
        isAxiosError: true,
        response: { status: 429, headers: { 'retry-after': pastDate } },
      } as any;

      const parsed = handleApiError(err, baseContext);
      expect(parsed.retryAfter).toBe(0);
    });

    test('Verifies no retry-after header yields undefined retryAfter', () => {
      const err = {
        isAxiosError: true,
        response: { status: 429, headers: {} },
      } as any;

      const parsed = handleApiError(err, baseContext);
      expect(parsed.retryAfter).toBeUndefined();
    });
  });

  describe('Non-Axios and Malformed Error Handling', () => {
    test('Verifies a standard Error object is handled gracefully', () => {
      const thrown = new Error('Something broke');
      const parsed = handleApiError(thrown, baseContext);

      expect(parsed.message).toContain('Something broke');
      expect(parsed.retryable).toBeUndefined(); // Should not assume retryable.
      expect(parsed.errorCode).toBe('UNEXPECTED_ERROR');
      expect(parsed.originalError).toBe(thrown);
    });

    test('Verifies a plain string thrown as an error is handled', () => {
      const thrown = 'A string error';
      const parsed = handleApiError(thrown, baseContext);

      expect(parsed.message).toContain('A string error');
      expect(parsed.errorCode).toBe('UNEXPECTED_ERROR');
    });

    test('Verifies it respects custom retryable and retryAfter properties on error-like objects', () => {
      // NON-OBVIOUS: The production code checks `instanceof Error` to get the message.
      // Therefore, we must test with a true Error instance, not a plain object,
      // to accurately simulate a custom error class with extra properties.
      const customError: any = new Error('A custom error message');
      customError.retryable = true;
      customError.retryAfter = 1234;

      const parsed = handleApiError(customError, baseContext);

      expect(parsed.message).toContain('A custom error message');
      expect(parsed.retryable).toBe(true);
      expect(parsed.retryAfter).toBe(1234);
    });

    test('Verifies a null or undefined error produces a generic message', () => {
      const parsedNull = handleApiError(null, baseContext);
      expect(parsedNull.message).toContain(
        'An unexpected non-Axios error occurred: null',
      );

      const parsedUndefined = handleApiError(undefined, baseContext);
      expect(parsedUndefined.message).toContain(
        'An unexpected non-Axios error occurred: undefined',
      );
    });
  });

  describe('Context Handling', () => {
    test('Verifies it applies default context values if not provided', () => {
      const error = new Error('test');
      // Call without description or attempt.
      const parsed = handleApiError(error, { endpoint: '/test' });

      expect(parsed.context).toBeDefined();
      expect(parsed.context?.description).toBe('API Request'); // Default applied.
      expect(parsed.context?.attempt).toBe(1); // Default applied.
      expect(parsed.context?.endpoint).toBe('/test');
    });

    test('Verifies it preserves all provided context values', () => {
      const error = new Error('test');
      const fullContext = {
        endpoint: '/users',
        params: { id: 1 },
        description: 'Fetch User Data',
        attempt: 3,
      };
      const parsed = handleApiError(error, fullContext);

      expect(parsed.context).toEqual(fullContext);
    });
  });
});
