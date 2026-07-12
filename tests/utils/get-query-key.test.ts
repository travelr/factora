import { getQueryKey } from '@utils/get-query-key';

describe('query key canonicalization', () => {
  test('Verifies that nested property order produces the same key', () => {
    expect(getQueryKey('/test', { filter: { a: 1, b: 2 } })).toBe(
      getQueryKey('/test', { filter: { b: 2, a: 1 } }),
    );
  });

  test('Verifies that canonical order does not depend on locale collation', () => {
    const composed = 'ä';
    const decomposed = 'a\u0308';
    expect(getQueryKey('/test', { [composed]: 1, [decomposed]: 2 })).toBe(
      getQueryKey('/test', { [decomposed]: 2, [composed]: 1 }),
    );
  });

  test('Verifies that symbol-keyed properties are rejected instead of silently ignored', () => {
    const params = { visible: true, [Symbol('hidden')]: 'value' };
    expect(() => getQueryKey('/test', params)).toThrow(
      /Unsupported query parameter value/,
    );
  });

  test('Verifies that unsupported-value errors cannot expose a custom type label', () => {
    const secret = 'credential-from-to-string-tag';
    const value = new Map();
    Object.defineProperty(value, Symbol.toStringTag, { value: secret });

    let thrown: unknown;
    try {
      getQueryKey('/test', { value });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toContain(secret);
  });

  test('Verifies that shared non-circular references are accepted', () => {
    const shared = { id: 1 };
    expect(() =>
      getQueryKey('/test', { left: shared, right: shared }),
    ).not.toThrow();
  });

  test('Verifies that missing and explicitly undefined values have different identities', () => {
    expect(getQueryKey('/test', {})).not.toBe(
      getQueryKey('/test', { value: undefined }),
    );
  });

  test.each([
    () => undefined,
    Symbol('unsupported'),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Map(),
    new Set(),
    Object.create({ custom: true }),
  ])(
    'Verifies that unsupported value %# is rejected without including its contents',
    (value) => {
      expect(() => getQueryKey('/test', { secret: value })).toThrow(
        /Unsupported query parameter value/,
      );
    },
  );

  test('Verifies that cycles are rejected but repeated references are permitted', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => getQueryKey('/test', circular)).toThrow(/Circular/);
  });

  test('Verifies that BigInt, arrays, primitives, and dates receive tagged keys', () => {
    expect(() =>
      getQueryKey('/test', {
        bigint: 10n,
        array: [true, 'value', null],
        date: new Date('2024-01-01T00:00:00.000Z'),
      }),
    ).not.toThrow();
  });

  test('Verifies that invalid endpoints are rejected without reflecting their contents', () => {
    expect(() => getQueryKey('', {})).toThrow('Invalid endpoint provided');
  });
});
