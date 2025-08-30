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
  // Input validation for endpoint. A pure utility must throw an error on invalid input.
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new TypeError(
      `[getQueryKey] Invalid endpoint provided. Expected a non-empty string, but received: ${endpoint}`,
    );
  }

  // Handle null/undefined params case explicitly
  const safeParams = params ?? {};

  // Sort keys for consistent stringification output
  // Object.fromEntries preserves the order of keys from the sorted array.
  const sortedParams = Object.fromEntries(
    Object.entries(safeParams).sort(([keyA], [keyB]) =>
      keyA.localeCompare(keyB),
    ),
  );

  // JSON.stringify handles Date objects by converting them to ISO strings (YYYY-MM-DDTHH:mm:ss.sssZ).
  // The structure of the key is explicitly { endpoint: string, params: Record<string, unknown> }
  return JSON.stringify({ endpoint, params: sortedParams });
};

/**
 * Parses a query key back into its endpoint and parameters.
 * Uses a specific reviver function with JSON.parse to convert strings that are
 * in the *exact* ISO 8601 format produced by JSON.stringify for Dates back into Date objects.
 * This prevents unintended conversion of simple date strings (like 'yyyy-MM-dd').
 * Includes validation of the parsed structure.
 *
 * Optimization: Adds preliminary checks (type, length, specific characters)
 * before applying the regex test, significantly reducing the number of regex executions.
 *
 * @param key - The string key to parse
 * @returns Object with endpoint and params
 * @throws Error if the key is malformed or validation fails.
 */
export const parseQueryKey = (
  key: string,
): { endpoint: string; params: Record<string, unknown> } => {
  try {
    // Regex to specifically match the ISO 8601 format produced by JSON.stringify for Date objects.
    // This format includes 'T', milliseconds (.sss), and 'Z' (UTC indicator).
    // Kept for precise structural validation *after* quick checks pass.
    const ISO_DATE_STRING_REGEX =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const ISO_DATE_STRING_LENGTH = 24; // "YYYY-MM-DDTHH:mm:ss.sssZ".length

    // Use JSON.parse with a reviver function.
    const parsed = JSON.parse(key, (_k, value) => {
      // --- Performance Optimization: Quick checks before regex ---
      // 1. Check if it's a string.
      // 2. Check if the length matches the expected ISO format length (24 chars).
      // 3. Check if specific, fixed characters are in the expected positions.
      //    This filters out most strings that can't possibly be the target date format.
      if (
        typeof value === 'string' &&
        value.length === ISO_DATE_STRING_LENGTH &&
        value[4] === '-' &&
        value[7] === '-' &&
        value[10] === 'T' && // 'T' separator
        value[13] === ':' &&
        value[16] === ':' &&
        value[19] === '.' && // Milliseconds separator
        value[23] === 'Z' // UTC indicator
      ) {
        // If quick checks pass, perform the more precise regex test.
        // The regex ensures the *digits* and overall structure are correct.
        if (ISO_DATE_STRING_REGEX.test(value)) {
          // Attempt to create a Date object from the string.
          const date = new Date(value);
          // Check if the resulting Date object is valid (parsing didn't result in Invalid Date).
          if (!isNaN(date.getTime())) {
            // If it's a valid date in the expected format, return the Date object.
            return date;
          }
          // If the string matched the regex but didn't produce a valid date (shouldn't happen
          // with the specific ISO format string from JSON.stringify, but good defensive check),
          // fall through and return the original string.
        }
      }
      // If the value is not a string, or it failed the quick checks,
      // or it failed the regex test, return the value unchanged.
      return value;
    }) as unknown; // Cast to unknown initially for safety

    // --- Validation after parsing and reviving ---
    // Ensure the parsed result has the expected top-level structure:
    // must be a non-null object with a string 'endpoint' and an object 'params'.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('endpoint' in parsed) ||
      !('params' in parsed) ||
      typeof parsed.endpoint !== 'string' ||
      typeof parsed.params !== 'object' ||
      parsed.params === null
    ) {
      // A pure utility throws; it does not log. The caller is responsible for logging.
      throw new Error('Invalid query key structure after parsing');
    }

    // Return the validated and revived object.
    // 'params' will contain Date objects only for values that were ISO strings matching the regex
    // after passing the quick checks. Other strings will remain strings.
    return {
      endpoint: parsed.endpoint,
      params: parsed.params as Record<string, unknown>,
    };
  } catch (error: any) {
    // Re-throw a new, more specific error to the caller. Do not log here.
    throw new Error(
      `Failed to parse query key. Reason: ${error.message || 'Unknown parsing error'}. Key was: "${key}"`,
    );
  }
};
