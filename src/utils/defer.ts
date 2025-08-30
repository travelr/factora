/* eslint-disable no-unused-vars */
/**
 * A utility to create a deferred promise, allowing separation of promise
 * creation from its execution. This is essential for solving the primary
 * race condition in `triggerFetch` by allowing the request "slot" to be
 * claimed synchronously before any async work begins.
 */
const defer = <T>() => {
  let resolveFn: (value: T | PromiseLike<T>) => void;
  // eslint-disable-next-line promise/avoid-new -- This is a deliberate and necessary use of the Promise constructor for the deferred pattern.
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn! };
};
export default defer;
