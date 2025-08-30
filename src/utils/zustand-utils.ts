/* eslint-disable no-unused-vars */
/**
 * @fileoverview A collection of utility functions for working with Zustand stores,
 * particularly for creating efficient, non-React subscriptions.
 */
import type { StoreApi, UseBoundStore } from 'zustand';

/**
 * A minimal, correct shallow equality checker for arrays or flat objects.
 * Used to prevent subscription listeners from firing unnecessarily.
 */
function shallowEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  // Checks if all keys in `a` exist in `b` and have the same value (by reference).
  return aKeys.every((key) => Object.is(a[key], b[key]));
}

/**
 * Subscribes to a slice of a Zustand store and only calls the listener when the
 * selected slice has changed (determined by a shallow comparison).
 *
 * This provides the benefits of `useShallow` for non-React `subscribe` calls,
 * improving performance by avoiding unnecessary listener execution.
 *
 * @param store The Zustand store to subscribe to.
 * @param selector A function to select a slice of the state.
 * @param listener The callback to execute when the selected slice changes.
 * @returns An `unsubscribe` function.
 */
export function subscribeToSlices<T, S>(
  store: UseBoundStore<StoreApi<T>>,
  selector: (state: T) => S,
  listener: (selected: S) => void,
): () => void {
  let prevSlice = selector(store.getState());
  return store.subscribe((state) => {
    const nextSlice = selector(state);
    if (!shallowEqual(prevSlice, nextSlice)) {
      prevSlice = nextSlice;
      listener(nextSlice);
    }
  });
}

/**
 * A specialized, type-safe utility to subscribe to a `queryCount` property on a store.
 * This implementation is compatible with all versions of Zustand's `subscribe` method.
 *
 * @param store The Zustand store, which must have a `queryCount: number` property.
 * @param listener The callback to execute when the `queryCount` changes.
 * @returns An `unsubscribe` function.
 */
export function subscribeToQueryCount<T extends { queryCount: number }>(
  store: UseBoundStore<StoreApi<T>>,

  listener: (count: number) => void,
): () => void {
  // Manually track the previous count to ensure compatibility with older Zustand versions.
  let prevCount = store.getState().queryCount;
  return store.subscribe((state) => {
    const nextCount = state.queryCount;
    if (prevCount !== nextCount) {
      prevCount = nextCount;
      listener(nextCount);
    }
  });
}
