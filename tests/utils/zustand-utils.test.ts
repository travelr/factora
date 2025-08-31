/**
 * @fileoverview Unit tests for Zustand-specific utility functions.
 */
import { act } from '@testing-library/react';
import {
  shallowEqual,
  subscribeToQueryCount,
  subscribeToSlices,
} from '@utils/zustand-utils';

import { afterEach, describe, expect, test, vi, beforeEach } from 'vitest';
import { create, StoreApi, UseBoundStore } from 'zustand';

describe('Zustand Utilities', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Verifies the correctness of the `shallowEqual` utility, which is a key
   * performance optimization for Zustand selectors.
   */
  describe('shallowEqual', () => {
    const obj = { a: 1 };
    const commonRef = { id: 1 };

    test.each([
      { a: 1, b: 1, description: 'identical primitive numbers' },
      { a: 'hello', b: 'hello', description: 'identical primitive strings' },
      { a: null, b: null, description: 'two null values' },
      { a: obj, b: obj, description: 'the exact same object instance' },
      {
        a: { ref: commonRef },
        b: { ref: commonRef },
        description: 'objects with the same key-value pairs by reference',
      },
    ])('Verifies it returns true for $description', ({ a, b }) => {
      expect(shallowEqual(a, b)).toBe(true);
    });

    test.each([
      { a: 1, b: 2, description: 'different numbers' },
      { a: 'a', b: 'b', description: 'different strings' },
      {
        a: { val: 1 },
        b: { val: 2 },
        description: 'objects with different values',
      },
      {
        a: { key1: 1 },
        b: { key2: 1 },
        description: 'objects with different keys',
      },
      {
        a: { a: 1 },
        b: { a: 1, b: 2 },
        description: 'objects with a different number of keys',
      },
      { a: { a: 1 }, b: null, description: 'an object and a null value' },
      { a: null, b: { a: 1 }, description: 'a null value and an object' },
    ])('Verifies it returns false for $description', ({ a, b }) => {
      expect(shallowEqual(a, b)).toBe(false);
    });
  });

  /**
   * Verifies the `subscribeToSlices` utility, which allows for subscribing
   * to a specific, memoized part of the store's state.
   */
  describe('subscribeToSlices', () => {
    type MockState = { user: { name: string; age: number }; theme: string };
    let useMockStore: UseBoundStore<StoreApi<MockState>>;

    beforeEach(() => {
      useMockStore = create<MockState>()(() => ({
        user: { name: 'John', age: 30 },
        theme: 'light',
      }));
    });

    const userSelector = (state: MockState) => state.user;

    /**
     * This is a comprehensive lifecycle test that Verifies the subscription
     * logic from creation to unsubscription, ensuring the callback is fired
     * only when the selected slice changes.
     */
    test('Verifies the complete listener lifecycle for a selected slice', () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToSlices(
        useMockStore,
        userSelector,
        callback,
      );

      // Phase 1: Verify it is not called on initial subscription.
      expect(callback).not.toHaveBeenCalled();

      // Phase 2: Verify it is called when the selected slice changes.
      const newUser = { name: 'Jane', age: 31 };
      act(() => useMockStore.setState({ user: newUser }));
      expect(callback).toHaveBeenCalledWith(newUser);
      expect(callback).toHaveBeenCalledTimes(1);

      // Phase 3: Verify it is NOT called when an unselected part of the state changes.
      act(() => useMockStore.setState({ theme: 'dark' }));
      expect(callback).toHaveBeenCalledTimes(1);

      // Phase 4: Verify it is NOT called if the slice is updated with a shallowly equal object.
      act(() => useMockStore.setState({ user: { ...newUser } }));
      expect(callback).toHaveBeenCalledTimes(1);

      // Phase 5: Verify unsubscription correctly prevents further calls.
      unsubscribe();
      act(() => useMockStore.setState({ user: { name: 'Jake', age: 40 } }));
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Verifies the `subscribeToQueryCount` utility, a specialized subscription
   * for tracking the number of active queries.
   */
  describe('subscribeToQueryCount', () => {
    /**
     * Verifies the core lifecycle: the callback is not called initially,
     * fires on every change, and stops firing after unsubscription.
     */
    test('Verifies it tracks changes and unsubscribes correctly', () => {
      const useMockStore = create<{ queryCount: number }>()(() => ({
        queryCount: 0,
      }));
      const callback = vi.fn();
      const unsubscribe = subscribeToQueryCount(useMockStore, callback);

      expect(callback).not.toHaveBeenCalled();

      act(() => useMockStore.setState({ queryCount: 1 }));
      expect(callback).toHaveBeenCalledWith(1);
      expect(callback).toHaveBeenCalledTimes(1);

      act(() => useMockStore.setState({ queryCount: 2 }));
      expect(callback).toHaveBeenCalledWith(2);
      expect(callback).toHaveBeenCalledTimes(2);

      unsubscribe();
      act(() => useMockStore.setState({ queryCount: 3 }));
      expect(callback).toHaveBeenCalledTimes(2);
    });

    /**
     * Verifies that the subscription behaves correctly even if the store
     * is initialized with a non-zero count, only firing on the first change.
     */
    test('Verifies it handles an initial non-zero state correctly', () => {
      const useMockStore = create<{ queryCount: number }>()(() => ({
        queryCount: 5,
      }));
      const callback = vi.fn();
      subscribeToQueryCount(useMockStore, callback);

      expect(callback).not.toHaveBeenCalled();

      act(() => useMockStore.setState({ queryCount: 6 }));
      expect(callback).toHaveBeenCalledWith(6);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    /**
     * Verifies the resilience of the subscription mechanism. If one listener
     * throws an error, it should not prevent other listeners from executing.
     */
    test('Verifies it continues working after a listener error', () => {
      const useMockStore = create<{ queryCount: number }>()(() => ({
        queryCount: 0,
      }));
      const erroringCallback = vi.fn(() => {
        throw new Error('Listener error');
      });
      const workingCallback = vi.fn();

      subscribeToQueryCount(useMockStore, erroringCallback);
      subscribeToQueryCount(useMockStore, workingCallback);

      // Triggering a change should not throw an unhandled exception.
      expect(() =>
        act(() => useMockStore.setState({ queryCount: 1 })),
      ).not.toThrow();

      // Both the erroring and working callbacks should have been called.
      expect(erroringCallback).toHaveBeenCalledTimes(1);
      expect(workingCallback).toHaveBeenCalledWith(1);

      // A subsequent change should still trigger both listeners.
      act(() => useMockStore.setState({ queryCount: 2 }));
      expect(erroringCallback).toHaveBeenCalledTimes(2);
      expect(workingCallback).toHaveBeenCalledWith(2);
    });
  });
});
