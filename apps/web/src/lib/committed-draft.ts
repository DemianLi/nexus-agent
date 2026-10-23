/**
 * 命令收下之後草稿留下什麼（[#1941](https://github.com/DemianLi/nexus-agent/issues/1941)）。
 *
 * 照 dsh 的 `commit-draft`（`ui-conversation/src/client/input/facade.ts:715-722`，`687f282e`）：現在的草稿以送出的那一行開頭，
 * 才留下後面多打的那段；其餘一律清空。只清送出的那段，在途期間多打的字不跟著消失。dsh 另外判了「不等於送出的那一行」，
 * 等於時後綴本來就是空字串，這裡不另判。
 *
 * @module
 */

/**
 * @param current - 收下當下的草稿。
 * @param sent - 送出的那一行（按 Enter 當下的草稿）。
 * @returns 收下之後的草稿。
 */
export function retainedSuffix(current: string, sent: string): string {
  return current.startsWith(sent) ? current.slice(sent.length) : '';
}
