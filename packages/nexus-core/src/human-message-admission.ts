/**
 * 人話太大就在收下之前拒收（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）：native loop 的入口用它，
 * 那句話不進佇列、日誌一個字都不寫。
 *
 * 門檻與量法照基座 `FilesystemMiddleware` 的 `beforeAgent`（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js` 的
 * `extractTextFromMessage` 與 `4 * humanMessageTokenLimitBeforeEvict`）：拒收的那一刀與基座搬移的那一刀落在同一處，經過入口的
 * 人話因此到不了基座的搬移；命令接著送的話（`/plan <message>`）不經這裡，仍可能被基座搬移。已經搬過、帶 `lc_evicted_to` 的舊訊息照基座原路畫。組裝點沒改那個選項。
 *
 * @module
 */

import type { MessageContent } from '@langchain/core/messages';

/** 基座的 `humanMessageTokenLimitBeforeEvict` 預設 `5e4`，乘 4 是字元數。 */
export const HUMAN_MESSAGE_LIMIT_CHARS = 5e4 * 4;

/** 拒收時錯誤說法前面那個代碼。 */
export const HUMAN_MESSAGE_TOO_LARGE = 'message-too-large';

/**
 * 基座量人話的那段文字：字串原樣；區塊只取文字區塊的 `text`，以換行接起來。附件的參照區塊不算。
 *
 * @param content - `HumanMessage` 的內容。
 * @returns 量門檻用的那段文字。
 */
export function humanMessageText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block: unknown): block is { readonly text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join('\n');
  }
  return String(content);
}

/**
 * 這則人話收不收。
 *
 * @param content - 送進圖的那則 `HumanMessage` 的內容（wire 那側是 `userContent` 組出來、引用已換成 `@標題` 的那一份）。
 * @returns 收就是 `undefined`；不收是 `<代碼>: <說法>`，帶實際字數與上限。
 */
export function humanMessageRejection(content: MessageContent): string | undefined {
  const chars = humanMessageText(content).length;
  if (chars <= HUMAN_MESSAGE_LIMIT_CHARS) return undefined;
  return `${HUMAN_MESSAGE_TOO_LARGE}: 這則訊息有 ${chars.toLocaleString('en-US')} 字，超過上限 ${HUMAN_MESSAGE_LIMIT_CHARS.toLocaleString('en-US')} 字`;
}
