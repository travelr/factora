/* eslint-disable no-unused-vars */
/**
 * A utility to create a deferred promise, allowing separation of promise
 * creation from its execution. This is essential for solving the primary
 * race condition in `triggerFetch` by allowing the request "slot" to be
 * claimed synchronously before any async work begins.
 */
const defer = <T>() => {
  let resolveFn: (value: T | PromiseLike<T>) => void;
  // Add rejectFn variable
  let rejectFn: (reason?: any) => void;

  // eslint-disable-next-line promise/avoid-new
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    // Capture reject function
    rejectFn = reject;
  });

  // Return reject alongside resolve
  return { promise, resolve: resolveFn!, reject: rejectFn! };
};

export default defer;
