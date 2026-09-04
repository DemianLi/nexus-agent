/**
 * 輸出校驗這一半的回饋措辭，集中在這裡。
 *
 * 這些字串**會送進模型的 context**，所以有兩條規矩：不帶堆疊、不帶原始參數。理由與
 * 那個外洩形狀的來歷寫在 `@nexus/core` 的 {@link formatToolFailure} 上——**圍堵那一半
 * 連同它的措辭已經搬進 core**（[#159](https://github.com/DemianLi/nexus-agent/issues/159)），
 * 因為它不是這個 plugin 的選配功能，是每一次組裝都該有的性質。這裡剩下的兩句是校驗器
 * 自己的話。
 */

/** 輸出不合宣告的 schema 時給模型的那句話。 */
export function formatSchemaViolation(toolName: string, issues: readonly string[]): string {
  const body = issues.length === 0 ? '（沒有可讀的原因）' : issues.join('；');
  return `工具 ${toolName} 的輸出不合它宣告的 schema：${body}`;
}

/**
 * 校驗器自己壞掉時給模型的那句話。
 *
 * **它是一則錯誤，不是放行**——dsh 的做法是渲染器／投影器自己失敗也「转为 JSON 安全的
 * `isError`」（`docs/subsystems/tools.zh.md`）。一個壞掉的校驗器靜默放行，等於把
 * 「驗過了」這件事變成一句不能信的話。
 */
export function formatValidatorFailure(toolName: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `工具 ${toolName} 的輸出校驗本身失敗了，因此這次結果不予採信：${detail}`;
}
