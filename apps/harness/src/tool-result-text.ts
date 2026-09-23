/**
 * 一次工具呼叫的**結果文字**：即時與重播共用的那一份
 * （[#439](https://github.com/DemianLi/nexus-agent/issues/439)）。
 *
 * ## 為什麼從日誌抽
 *
 * dsh 的工具卡只從會話日誌導出，文字就是 `tool/result` 那一則的內容，`isError` 是另一個旗標——
 * **成功的結果文字照樣帶**（`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:51-68`，
 * `ddefc45`）。提問卡解析的就是這段字（`ui-tool/.../toolviews/ask-question-row.tsx`）。
 *
 * 我們這邊另一個現成的來源是基座那顆 `tool-finished` 的 `output`，但它**比日誌差**：基座的
 * `FilesystemMiddleware` 排在圍堵外層，超過 80,000 字元的結果在那裡已經被換成預覽
 * （`agent-factory.ts` 的 `TOOL_RESULT_STASH_PREFIX`），而圍堵寫日誌時拿到的還是原文
 * （`@nexus/core` 的 `session-log.ts`）。加上它是序列化過的 LangChain `ToolMessage`，
 * 拆它等於把基座的形狀搬進前端。所以**兩條路一律從 `tool/result.message` 抽**。
 *
 * ## 為什麼拒絕多塊
 *
 * 照 dsh 的 `singleResultText`（`ui-tool/src/client/tool/models/raw-tool-call.ts:46-50`）：
 * 內容不是剛好一塊文字就回 `undefined`，**不自己把幾塊拼起來**。拼出來的字是我們發明的，
 * dsh 的卡在同樣的輸入下什麼都不顯示。今天工具結果的內容是字串（實測），所以這條規則
 * 現在只是把「將來多了圖片或檔案區塊」那天的行為先定死。
 *
 * ## 上限是換了一層的政策（**登記的偏離**）
 *
 * dsh 也有上限，但它截在**模型面**：`spill-policy` 掛在 `tools/post-execute`，base bundle 給
 * `maxInlineBytes: 50000`（`packages/bundle/base/cordis.patch.yml:393-396`），超過就把全文存成
 * spill 檔、內容換成 head/tail 各半的預覽加一行**帶檔案位址**的通知。日誌因此天生就是截過的，
 * 日誌之後到畫面沒有任何內容上限。
 *
 * 我們沒有 spill 這個能力，日誌又刻意保著搬移前的全文，所以只能截在**放上線**這一刻：
 *
 * - **數值由清單上 `tool-text` 那一列講**（[#538](https://github.com/DemianLi/nexus-agent/issues/538)）——
 *   預設 50000 一樣照 dsh `spill-policy` 的 `maxInlineBytes`，但它現在是 schema 的預設值，不是
 *   寫死在這裡的常數。**「可設定」這件事本身沒有偏離**：dsh 那側它本來就是條目的一格；
 *   **寫死才是偏離**，而 #538 把它收掉了。頭尾各半的形狀照 dsh
 *   （`spill-policy/src/index.ts:96-103`，`Math.ceil`／`Math.floor` 分頭尾）；
 * - 但**通知的位置跟 dsh 不一樣**：dsh 的 `TextRetainer({ kind: 'headTail' })` 在兩段之間
 *   **不插任何東西**，通知接在整段預覽的**尾巴**（`spill-policy/src/index.ts:170` 的
 *   `previewText + '\n\n' + notice`）。把說明插在**中間**的是 dsh 的另一顆 plugin——
 *   `compaction-tool-result-pruner` 的 `PRUNE_MARKER`（`src/config.ts:7`），而那顆的單位是
 *   code point 不是 byte。**我們等於各取一半**：位元組上限與頭尾取自 `spill-policy`，
 *   中間那句說明取自 pruner。查證見 [#539](https://github.com/DemianLi/nexus-agent/pull/539)；
 * - **通知裡也沒有位址**可指（沒有 spill 檔），只能說被截掉了；
 * - **不學 dsh 的 `read` 例外**：那個例外成立在模型面（`read` 自己已經有上限），我們截在傳輸層，
 *   放行就等於讓一次 2000 行的 `read` 整份上線；
 * - **子代理不另開一條 arm**：dsh 的子呼叫走另一個只縮日誌副本的分支，我們一視同仁。
 *
 * @module
 */

import type { LoggedMessage } from '@nexus/core';

/** 中間被截掉那一段的說明。長度只隨位數變，所以預留時用上界算。 */
function notice(dropped: number): string {
  return `\n…（中間 ${dropped} 個位元組沒有送出來，全文在會話日誌裡）\n`;
}

/** 從頭取到不超過 `max` 個位元組，不切斷字元。 */
function head(text: string, max: number): string {
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > max) break;
    bytes += size;
    out += char;
  }
  return out;
}

/** 從尾取到不超過 `max` 個位元組，不切斷字元。 */
function tail(text: string, max: number): string {
  const chars = [...text];
  let bytes = 0;
  let out = '';
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > max) break;
    bytes += size;
    out = char + out;
  }
  return out;
}

/**
 * 套上限：超過就取頭尾各半，中間放一行通知。
 *
 * **上限是傳進來的，不是這個模組的常數**（#538）：值住在清單上 `tool-text` 那一列，由
 * `serve.ts` 在起動期解出來、穿過 `createWireHandler` 傳到這裡。刻意**沒有預設參數**——
 * 一個預設值會讓「呼叫端忘了傳」跟「設定就是這個數」長得一模一樣，而這條路上有兩個呼叫端。
 *
 * @param text - 原文。
 * @param maxBytes - 上限，見 `settings/tool-text.ts`。
 * @returns 原文，或截過的那一份（含通知不超過 `maxBytes`）。
 */
export function capToolText(text: string, maxBytes: number): string {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return text;
  // 通知的長度取決於被截掉幾個位元組，而那又取決於預留給通知的長度。用 `total` 當上界先算一次
  // 預留量：實際截掉的一定比 `total` 少，所以真正的通知只會更短，總長因此保證不超過上限。
  const reserved = Buffer.byteLength(notice(total), 'utf8');
  const budget = maxBytes - reserved;
  if (budget <= 0) return head(notice(total), maxBytes);
  const front = head(text, Math.ceil(budget / 2));
  const back = tail(text, Math.floor(budget / 2));
  const dropped = total - Buffer.byteLength(front, 'utf8') - Buffer.byteLength(back, 'utf8');
  return `${front}${notice(dropped)}${back}`;
}

/**
 * 一則 `tool/result` 的結果文字。
 *
 * @param message - 日誌記的那一則（格式 9 以前沒有，所以可以是 `undefined`）。
 * @param maxBytes - 上限，見 {@link capToolText}。
 * @returns 那段文字（已套上限）；沒有訊息、或內容不是剛好一塊文字時 `undefined`。
 */
export function toolResultText(
  message: LoggedMessage | undefined,
  maxBytes: number,
): string | undefined {
  const content: unknown = message?.data.content;
  if (typeof content === 'string') return capToolText(content, maxBytes);
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const only = content[0] as { type?: unknown; text?: unknown } | null;
  if (only?.type !== 'text' || typeof only.text !== 'string') return undefined;
  return capToolText(only.text, maxBytes);
}
