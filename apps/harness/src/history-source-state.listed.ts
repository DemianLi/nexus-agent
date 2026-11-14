/**
 * `history-source-state.setup.ts` 與 `native-loop.setup.ts` 共用：清單上 `history-source` 那一列寫的來源。
 */

/** 清單上 `history-source` 那一列寫的來源；沒有那一列或沒寫就是 `undefined`。 */
export function listedHistorySource(plugins: readonly unknown[]): unknown {
  const row = plugins.find((entry) => (entry as { id?: unknown }).id === 'history-source') as
    { config?: { source?: unknown } } | undefined;
  return row?.config?.source;
}
