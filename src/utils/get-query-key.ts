/** Tagged representation used to create unambiguous in-memory cache identities. */
type EncodedValue =
  | ['null']
  | ['undefined']
  | ['boolean', boolean]
  | ['number', number]
  | ['bigint', string]
  | ['string', string]
  | ['date', string]
  | ['array', EncodedValue[]]
  | ['object', Array<[string, EncodedValue]>];

const unsupported = (): never => {
  throw new TypeError('[getQueryKey] Unsupported query parameter value.');
};

const encodeValue = (value: unknown, stack: Set<object>): EncodedValue => {
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return unsupported();
    return ['number', Object.is(value, -0) ? 0 : value];
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return unsupported();
  }
  if (typeof value !== 'object') return unsupported();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return unsupported();
    return ['date', value.toISOString()];
  }

  if (stack.has(value)) {
    throw new TypeError(
      '[getQueryKey] Circular query parameters are not supported.',
    );
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return ['array', value.map((item) => encodeValue(item, stack))];
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupported();
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return unsupported();
    }
    return [
      'object',
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, encodeValue(item, stack)]),
    ];
  } finally {
    stack.delete(value);
  }
};

export const getQueryKey = (
  endpoint: string,
  params?: Record<string, unknown> | null,
): string => {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new TypeError(
      '[getQueryKey] Invalid endpoint provided. Expected a non-empty string.',
    );
  }
  return JSON.stringify([
    ['string', endpoint],
    encodeValue(params ?? {}, new Set()),
  ]);
};
