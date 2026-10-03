/**
 * 一次工具呼叫的**結果文字**：即時與重播共用的那一份
 * （[#439](https://github.com/DemianLi/nexus-agent/issues/439)）。
 *
 * ## 為什麼從日誌抽
 *
 * dsh 的工具卡，結果文字只從會話日誌導出，就是 `tool/result` 那一則的內容，`isError` 是另一個旗標——
 * **成功的結果文字照樣帶**（`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:51-68`，
 * `ddefc45`；`5badb15009a` 的 `rootResult` 仍是這樣，只是行號位移。開卡的時機則已提前到參數串流中，見
 * `thread-pump.ts` 檔頭）。提問卡解析的就是這段字（`ui-tool/.../toolviews/ask-question-row.tsx`）。
 *
 * 我們這邊另一個現成的來源是基座那顆 `tool-finished` 的 `output`，但它**比日誌差**：基座的
 * `FilesystemMiddleware` 排在圍堵外層，超過 80,000 字元的結果在那裡已經被換成預覽
 * （`agent-factory.ts` 的 `TOOL_RESULT_STASH_PREFIX`），而圍堵寫日誌時拿到的是基座搬移之前那一份
 * （`@nexus/core` 的 `session-log.ts`；外溢層開著時是外溢換過的那則，見下面）。加上它是序列化過的 LangChain `ToolMessage`，
 * 拆它等於把基座的形狀搬進前端。所以**兩條路一律從 `tool/result.message` 抽**。
 *
 * ## 為什麼拒絕多塊
 *
 * 照 dsh 的 `singleResultText`（`ui-tool/src/client/tool/models/raw-tool-call.ts:46-50`）：
 * 內容不是剛好一塊文字就回 `undefined`，**不自己把幾塊拼起來**。拼出來的字是我們發明的，
 * dsh 的卡在同樣的輸入下什麼都不顯示。今天工具結果的內容是字串（實測），所以這條規則
 * 現在只是把「將來多了圖片或檔案區塊」那天的行為先定死。
 *
 * ## 文字放上線不截（[#736](https://github.com/DemianLi/nexus-agent/issues/736)）
 *
 * 照 dsh：上限在**模型面**，日誌到畫面這一段不再截。dsh 的 `spill-policy` 掛在 `tools/post-execute`，超過預算就把全文
 * 存成 spill 檔、內容換成頭尾預覽加一行帶路徑的通知（`packages/spill/spill-policy/src/index.ts:133-150`），日誌記的就是
 * 換過的那則（`packages/core/agent-loop/src/tool-calls.ts:152-156`）；工具卡直接拿 `tool/result` 的內容
 * （`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:64-74`）。以上對 dsh `c1b47e4`，卡上引的 `477b4f4` 同內容。
 *
 * 我們的外溢層（[#719](https://github.com/DemianLi/nexus-agent/issues/719)，`@nexus/core` 的 `spill-policy.ts`）做的是
 * 同一件事，日誌記的也是換過的那則。所以這裡**原樣交出日誌裡那則**：即時與重播都是預覽加路徑，一字不差，沒有第二層截斷。
 * 這裡原本截在**放上線**那一刻（頭尾各半、中間一句「沒有送出來」），那是「沒有外溢、日誌保全文」時登記的偏離；
 * 前提不在了，偏離收掉。
 *
 * 一張卡的文字因此由**生產者自己的上限**決定，不再由 `tool-text` 那一列決定：
 *
 * - **外溢層開著**：一則最多 `maxInlineTokens`（出廠 12500）個估算 token，含通知。
 * - **`read_file` 不外溢**（同 dsh 只放過 `read`）：受讀檔自己的上限，一頁 2000 行、累計 50 KiB 就停
 *   （`@nexus/core` 的 `read-continuation.ts`）；單行超過時退到基座格式化後的 80,000 字元。
 * - **外溢層關掉**（刪掉 `maxInlineTokens`）：日誌回到全文，文字沒有上限——**dsh 關掉時也一樣**。
 *
 * 一頁歷史的位元組預算怎麼跟著算，見 `@nexus/wire` 的 `HISTORY_PAGE_MAX_BYTES`。
 *
 * `tool-text` 那一列仍然管兩件事：**`meta` 的上限**（見 {@link capToolResultMeta}）與**壓縮摘要全文**
 * （[#896](https://github.com/DemianLi/nexus-agent/issues/896)，用 {@link capToolText}）。
 *
 * @module
 */

import type { LoggedMessage, SearchResultMeta } from '@nexus/core';
import { loggedContentBlocks } from '@nexus/core';

/** 中間被截掉那一段的說明。長度只隨位數變，所以預留時用上界算。 */
function notice(dropped: number): string {
  return `\n…（中間 ${dropped} 個位元組沒有送出來）\n`;
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
 * **今天只有壓縮摘要全文用它**（[#896](https://github.com/DemianLi/nexus-agent/issues/896)）；工具結果文字自
 * [#736](https://github.com/DemianLi/nexus-agent/issues/736) 起不再經過這裡，見檔頭。
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
 * 一則 `tool/result` 的結果文字，**原樣**：不截，見檔頭（#736）。
 *
 * @param message - 日誌記的那一則（格式 9 以前沒有，所以可以是 `undefined`）。
 * @returns 那段文字；沒有訊息、或內容不是剛好一塊文字時 `undefined`。
 */
export function toolResultText(message: LoggedMessage | undefined): string | undefined {
  if (!message) return undefined;
  const blocks = loggedContentBlocks(message.data.content);
  if (blocks.length !== 1) return undefined;
  const only = blocks[0] as { type?: unknown; text?: unknown } | null;
  if (only?.type !== 'text' || typeof only.text !== 'string') return undefined;
  return only.text;
}

/** 序列化之後的位元組數。 */
function metaBytes(meta: unknown): number {
  return Buffer.byteLength(JSON.stringify(meta), 'utf8');
}

/**
 * 讀檔 meta 的上限是 `tool-text` 那一列 `maxBytes` 的幾倍（[#630](https://github.com/DemianLi/nexus-agent/issues/630)）。
 *
 * 是乘數不是另一個寫死的值：部署在 patch 裡改 `tool-text` 的 `maxBytes`，讀檔 meta 的上限跟著變。
 * 歷史分頁的上限照一張卡的最壞值算，改這個數要一起看 `@nexus/wire` 的 `HISTORY_PAGE_MAX_BYTES`
 * （`conversation-history.test.ts` 的絆索會紅）。
 */
export const READ_META_MAX_BYTES_FACTOR = 2;

/**
 * 是不是讀檔的 meta（`@nexus/core` 的 `ReadResultMeta`，同 dsh 的 `FsReadMeta`）。
 *
 * 生產者只有五處：`read_file` 寫這個形狀，`grep`／`glob` 寫帶 `shape` 的搜尋，`write_file`／`edit_file`
 * 寫帶 `diffs` 的改檔。只有讀檔帶 `lines` 陣列與 `totalLines`。
 */
function isReadMeta(meta: unknown): boolean {
  const read = meta as { readonly lines?: unknown; readonly totalLines?: unknown } | null;
  return Array.isArray(read?.lines) && typeof read.totalLines === 'number';
}

/**
 * 一格 `tool/result.meta` 放上線之前的上限。即時與重播共用，理由同 {@link toolResultText}。
 *
 * - **搜尋與 diff 的上限就是 `tool-text` 那一列的 `maxBytes`**
 *   （[#617](https://github.com/DemianLi/nexus-agent/issues/617) 決定 2；那時它也是工具文字的上限，#736 之後文字不再截）。
 * - **讀檔是 {@link READ_META_MAX_BYTES_FACTOR} 倍**（[#630](https://github.com/DemianLi/nexus-agent/issues/630)）：
 *   #602 把一頁放大到 dsh 的 2000 行之後，每行 `{"number":N,"text":"…"}` 的外殼約 25 位元組，短行的大檔
 *   文字沒被截、meta 卻超過一倍的上限。兩倍裝得下一整頁 2000 行短行。
 * - **搜尋照 dsh 的 `capMetaBytes`**（`fs/tool-fs-search/src/presentation.ts:107-117`）：從尾巴整組砍，
 *   標 `truncated`，`total` 不動，至少留一項——一項自己就超過的也留著，不讓一張空卡蓋掉真的結果。
 * - **讀檔與 diff 超過就整格不給**：dsh 這兩種沒有上限；我們的歷史頁是照每張卡的最大值算的，
 *   一次大改寫的 diff 會讓一頁失控（偏離）。web 照 dsh 退：write 用參數算 diff，其他走 generic。
 *
 * @param meta - 日誌裡那一份。
 * @param maxBytes - `tool-text` 那一列的上限（位元組）；讀檔 meta 用它的 {@link READ_META_MAX_BYTES_FACTOR} 倍。
 * @returns 放得下的那一份；放不下就 `undefined`。
 */
export function capToolResultMeta(meta: unknown, maxBytes: number): unknown {
  if (meta === undefined) return meta;
  const bytes = metaBytes(meta);
  if (bytes <= maxBytes) return meta;
  if (isReadMeta(meta)) return bytes <= READ_META_MAX_BYTES_FACTOR * maxBytes ? meta : undefined;
  const search = meta as { readonly shape?: unknown };
  if (search.shape === 'matches') {
    const whole = meta as Extract<SearchResultMeta, { shape: 'matches' }>;
    const files = [...whole.files];
    while (files.length > 1 && metaBytes({ ...whole, files, truncated: true }) > maxBytes)
      files.pop();
    return { ...whole, files, truncated: true };
  }
  if (search.shape === 'paths') {
    const whole = meta as Extract<SearchResultMeta, { shape: 'paths' }>;
    const paths = [...whole.paths];
    while (paths.length > 1 && metaBytes({ ...whole, paths, truncated: true }) > maxBytes)
      paths.pop();
    return { ...whole, paths, truncated: true };
  }
  return undefined;
}
