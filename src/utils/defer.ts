/**
 * A utility to create a deferred promise, allowing separation of promise
 * creation from its execution. This is essential for solving the primary
 * race condition in `triggerFetch` by allowing the request "slot" to be
 * claimed synchronously before any async work begins.
 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

const defer = <T>(): Deferred<T> => {
  let resolveFn: (value: T | PromiseLike<T>) => void;
  let rejectFn: (reason?: unknown) => void;

  // eslint-disable-next-line promise/avoid-new
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  return { promise, resolve: resolveFn!, reject: rejectFn! };
};

export default defer;
