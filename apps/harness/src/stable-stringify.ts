/**
 * 欄位順序固定的序列化，雜湊才不隨鍵的寫法而變。
 *
 * eval 結果檔的題庫版本（`eval/result-file.ts`，#1000）與會話日誌 header 的設定雜湊（`session-header-metadata.ts`，#1025）
 * 共用這一份：兩邊各寫一份的話，有一天「同一份東西」在兩處算出不同的雜湊。值是 `undefined` 的鍵略過，同 `JSON.stringify`。
 *
 * @param value - 要序列化的 JSON 值。
 * @returns 物件的鍵依字典序排好的 JSON 字串。
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
