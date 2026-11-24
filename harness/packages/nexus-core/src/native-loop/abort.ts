/**
 * 中止訊號的兩個小工具，照 `@langchain/core` 的語意，兩個 loop 中止時拋同一個錯。
 *
 * @module
 */

/** 中止時拋的錯：signal 的 reason，同 `@langchain/core` 的 `getAbortSignalError`。 */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  return new Error('Aborted');
}

/** `promise` 與 `signal` 競速：先中止就拋 {@link abortReason}，`promise` 之後的拒絕吞掉，同 `@langchain/core` 的 `raceWithSignal`。 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined;
  return Promise.race([
    promise.catch((error: unknown) => {
      if (!signal.aborted) throw error;
      return undefined as never;
    }),
    new Promise<never>((_resolve, reject) => {
      listener = () => reject(abortReason(signal));
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) reject(abortReason(signal));
    }),
  ]).finally(() => {
    if (listener !== undefined) signal.removeEventListener('abort', listener);
  });
}
