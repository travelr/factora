/**
 * @fileoverview Pure utility functions for creating and parsing store query keys.
 */

/**
 * Generates a consistent cache key from API endpoint and parameters.
 * Sorts parameters to ensure consistent keys regardless of property order.
 * Uses JSON.stringify, which converts Date objects to ISO strings.
 *
 * @param endpoint - API endpoint path (e.g., '/api/history/period', '/wellness')
 * @param params - Request parameters object (can be undefined/null)
 * @returns Stringified JSON containing endpoint and sorted params, serving as the cache key.
 * @throws {TypeError} If the endpoint is not a non-empty string.
 */
export const getQueryKey = (
  endpoint: string,
  params?: Record<string, unknown> | null,
): string => {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new TypeError(
      `[getQueryKey] Invalid endpoint provided. Expected a non-empty string, but received: ${endpoint}`,
    );
  }

  // Coalesce null or undefined params to an empty object for consistent handling.
  const safeParams = params ?? {};

  try {
    // A WeakSet is used to track objects we have already seen during serialization.
    // It's chosen over a standard Set because it holds weak references, preventing memory leaks
    // by not stopping the garbage collector from removing objects that are no longer in use.
    const seen = new WeakSet();
    const getCircularReplacer = () => (key: string, value: any) => {
      // This "replacer" function is called by JSON.stringify for each key/value pair.
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          // If we have already serialized this object in this path, we have a circular reference.
          throw new Error(
            `[getQueryKey] Circular reference detected in query parameters at key "${key}". ` +
              `Query parameters cannot contain circular references.`,
          );
        }
        seen.add(value);
      }
      return value;
    };

    // To ensure the output is always the same for the same parameters, regardless of their
    // original order, we create a new object from the entries of the params, sorted by key.
    const sortedParams = Object.fromEntries(
      Object.entries(safeParams).sort(([keyA], [keyB]) =>
        keyA.localeCompare(keyB),
      ),
    );

    return JSON.stringify(
      { endpoint, params: sortedParams },
      getCircularReplacer(),
    );
  } catch (error: unknown) {
    // Re-throw our specific circular reference error if it was the cause.
    if (error instanceof Error && error.message.includes('circular')) {
      throw error;
    }
    // Provide a more generic error for other stringification failures.
    throw new Error(
      `[getQueryKey] Failed to create query key: ${(error as Error).message}. ` +
        `Parameters: ${JSON.stringify(safeParams).substring(0, 100)}...`,
    );
  }
};

/**
 * Parses a query key back into its endpoint and parameters.
 * Uses a specific reviver function with JSON.parse to convert ISO 8601 date strings back into Date objects.
 *
 * @param key - The string key to parse
 * @returns Object with endpoint and params
 * @throws Error if the key is malformed or validation fails.
 */
export const parseQueryKey = (
  key: string,
): { endpoint: string; params: Record<string, unknown> } => {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `Failed to parse query key. Reason: parseQueryKey expects a non-empty string.`,
    );
  }

  try {
    // This regex specifically matches the ISO 8601 format that `JSON.stringify(new Date())` produces.
    // It is intentionally strict to avoid accidentally converting user-provided strings
    // like "2025-08-30" into Date objects.
    // Breakdown:
    // ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}  - Matches "YYYY-MM-DDTHH:mm:ss"
    // (?:\.\d{1,3})?                      - Optionally matches milliseconds (".sss")
    // (?:Z|[+-]\d{2}:\d{2})$              - Matches a literal "Z" (Zulu/UTC) or a timezone offset like "+05:30"
    const ISO_DATE_REGEX =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

    // The second argument to JSON.parse is a "reviver" function. It's called for every
    // key-value pair during parsing, allowing us to transform values on the fly.
    const parsed = JSON.parse(key, (_k, value) => {
      if (typeof value === 'string' && ISO_DATE_REGEX.test(value)) {
        const date = new Date(value);
        // `new Date(invalid_string)` can result in an "Invalid Date" object.
        // This check ensures we only return valid Date objects.
        if (!Number.isNaN(date.getTime())) {
          return date;
        }
      }
      return value;
    }) as unknown;

    // This large conditional acts as a type guard, ensuring the parsed object has the exact
    // structure we expect ({ endpoint: string, params: object }).
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('endpoint' in parsed) ||
      !('params' in parsed) ||
      typeof (parsed as any).endpoint !== 'string' ||
      typeof (parsed as any).params !== 'object' ||
      (parsed as any).params === null
    ) {
      throw new Error('Invalid query key structure after parsing');
    }

    return {
      endpoint: (parsed as any).endpoint,
      params: (parsed as any).params as Record<string, unknown>,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // For debugging, provide a preview of the malformed key without logging the entire thing.
    const preview =
      key.length > 60 ? `${key.slice(0, 60)}... (len=${key.length})` : key;
    throw new Error(
      `Failed to parse query key. Reason: ${msg}. Key preview: "${preview}"`,
    );
  }
};
