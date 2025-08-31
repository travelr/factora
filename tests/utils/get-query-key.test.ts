import { parseQueryKey } from '@utils/get-query-key';

/**
 * @fileoverview Unit tests for the `parseQueryKey` utility.
 * This suite ensures the parser is robust against malformed inputs, correctly
 * validates the required structure of a query key, and properly revives
 * specific data types like ISO date strings.
 */
describe('Query Key Parsing', () => {
  test.each([
    {
      scenario: 'a valid JSON structure',
      input: '{"endpoint":"/test","params":{}}',
      expected: { endpoint: '/test', params: {} },
    },
    {
      scenario: 'a deeply nested object structure',
      input:
        '{"endpoint":"/test","params":{"user":{"profile":{"name":"test","settings":{"theme":"dark"}}}}}',
      expected: {
        endpoint: '/test',
        params: {
          user: {
            profile: {
              name: 'test',
              settings: {
                theme: 'dark',
              },
            },
          },
        },
      },
    },
    {
      scenario: 'an ISO date with fractional seconds',
      input:
        '{"endpoint":"/test","params":{"date":"2024-01-01T12:00:00.123Z"}}',
      expected: {
        endpoint: '/test',
        params: { date: new Date('2024-01-01T12:00:00.123Z') },
      },
    },
    {
      scenario: 'an ISO date with a timezone offset',
      input:
        '{"endpoint":"/test","params":{"date":"2024-01-01T12:00:00+02:00"}}',
      expected: {
        endpoint: '/test',
        params: { date: new Date('2024-01-01T12:00:00+02:00') },
      },
    },
    // --- Non-Revival Scenarios (should remain strings) ---
    {
      scenario: 'a simple date-like string that is not ISO compliant',
      input: '{"endpoint":"/test","params":{"date":"2024-01-01"}}',
      expected: { endpoint: '/test', params: { date: '2024-01-01' } },
    },
    {
      scenario: 'a date string with an invalid ISO format',
      input: '{"endpoint":"/test","params":{"date":"2024/01/01"}}',
      expected: { endpoint: '/test', params: { date: '2024/01/01' } },
    },
    {
      scenario: 'a date string with a partial ISO format',
      input: '{"endpoint":"/test","params":{"date":"2024-01-01T12:00"}}',
      expected: { endpoint: '/test', params: { date: '2024-01-01T12:00' } },
    },
    {
      scenario: 'a date string with an invalid time component',
      input: '{"endpoint":"/test","params":{"date":"2024-01-01T25:00:00Z"}}',
      expected: { endpoint: '/test', params: { date: '2024-01-01T25:00:00Z' } },
    },
    // --- Failure Scenarios ---
    {
      scenario: 'a non-JSON string',
      input: 'not a json string',
      error: /Failed to parse query key/,
    },
    {
      scenario: 'an empty string',
      input: '',
      error: /Failed to parse query key/,
    },
    {
      scenario: 'valid JSON that is missing the required `endpoint` field',
      input: '{"params":{}}',
      error: /Invalid query key structure/,
    },
    {
      scenario: 'valid JSON that is missing the required `params` field',
      input: '{"endpoint":"/test"}',
      error: /Invalid query key structure/,
    },
  ])('Verifies the scenario $scenario', ({ input, expected, error }) => {
    // If an error is expected, assert that the function throws.
    if (error) {
      expect(() => parseQueryKey(input)).toThrow(error);
    } else {
      const result = parseQueryKey(input);
      // Because `toEqual` performs a deep equality check, we must handle
      // Date objects specially, as two Date instances are never strictly equal.
      if (expected?.params && expected.params.date instanceof Date) {
        expect(result.params.date).toBeInstanceOf(Date);
        expect((result.params.date as Date).toISOString()).toBe(
          expected.params.date.toISOString(),
        );
      } else {
        expect(result).toEqual(expected);
      }
    }
  });
});
