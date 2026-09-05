/**
 * 壓縮即將運行時，把過大的工具結果剪成「頭部 ＋ 中段已剪除 ＋ 尾部」。
 *
 * **這件事不叫模型。** 它的價值正好相反——剪完之後 token 壓力可能自己就消了，於是那一輪
 * **摘要用的模型呼叫整個不會發生**。省下的不是字元，是一次 LLM 呼叫。
 *
 * ## 基座其實已經有一個工具結果壓縮器，而它對我們是死的
 *
 * `deepagents@1.13.1` 的 `compactToolResults`（`dist/langsmith-zm0ILQsV.js:2937`）做的事
 * 表面上就是這個。但它**三道閘門疊在一起，我們一道都過不了**：
 *
 * 1. 只在 `performSummarization` **內部**跑——也就是摘要已經決定要做了；
 * 2. 只在 `preservedMessages.length === 0` 時跑——切點一則都沒留下的那種絕境；
 * 3. 只在 `maxInputTokens` 為真時跑（`:3143`）——而**我們的模型解不出那個欄位**，
 *    它恆為 `undefined`（理由與實測見 {@link ./summarization.ts} 檔頭與
 *    [#142](https://github.com/DemianLi/nexus-agent/issues/142)）。
 *
 * 所以它在我們這棵樹上一次都不會執行。而且**它的次序跟 dsh 相反**：它是摘要之後的最後
 * 手段，永遠救不掉那次模型呼叫。dsh 是摘要之前的預處理，明文可以讓摘要整個跳過。
 *
 * ## 但基座還有**第二個**大結果處置，而那個是活的——它決定了這把剪刀的射程上界
 *
 * `createFilesystemMiddleware` 的 `wrapToolCall` 有自己的一條：`toolTokenLimitBeforeEvict`
 * 預設 `2e4`，工具結果的文字超過 `4 * 2e4 = 80,000` 字元就**寫進檔案系統**、換成一段頭尾
 * 預覽加一句「用 `read_file` 自己去讀」（`TOO_LARGE_TOOL_MSG`，`dist/langsmith-zm0ILQsV.js:1574`、
 * `:2426`、`:2507-2510`；`read_file`／`write_file`／`edit_file`／`glob`／`grep` 這幾個檔案
 * 工具自己被排除，`execute` 不排除）。它掛在**工具那一格**，比摘要器早得多。
 *
 * > **這把剪刀真正的射程是「8,192 到 80,000 字元」這一段。** 上面那截基座已經搬去檔案
 * > 系統了——而那件事的形狀其實是 dsh 的 `spill/`
 * > （[#151](https://github.com/DemianLi/nexus-agent/issues/151)），不是 pruner 的。
 * > 下面那截本來就在預算內。
 *
 * 那條 8 萬字元的線因此是我們的**上界**，而它是基座的一個預設值——它變了、或 eviction 被
 * 拿掉了，這把剪刀能碰到的區間就跟著變，**兩邊都不會拋**。所以
 * `apps/harness/src/summarization.test.ts` 有一條測試把它釘住。
 *
 * ⚠️ 這同時是 {@link ./summarization.ts} 那條絆索（「模型哪天解得出 `maxInputTokens`
 * 就要紅」）現在守的**第二**件事：那天到了，`compactToolResults` 會醒過來，跟這個檔
 * **同時**在剪，而且剪的預算不一樣。那天要回頭決定留哪個。
 *
 * ## dsh 怎麼做
 *
 * `packages/compaction/compaction-tool-result-pruner`（SHA `4e84901`，動工當天對過
 * upstream，這條路徑只有 `package.json` 版號與一行測試 fixture 的差別）：
 *
 * - 預算是 **Unicode code point**，不是 UTF-16 code unit——切點不會劈開代理對。
 *   預設 `thresholdChars: 8192`、`headChars: 4096`、`tailChars: 1024`，**原值照抄**。
 * - 載入期就驗 `headChars ＋ 標記 ＋ tailChars ≤ thresholdChars`，所以「剪完比原本還大」
 *   在設定那一層就不可能。
 * - 非文字區塊（圖片等）**原序保留、不計費**；替換保留工具呼叫、步驟、錯誤與元資料，
 *   只有文字變。
 * - 誰來叫它是**呼叫端的事**：它是一個 `Service`，`compaction-basic` 在壓力達標之後才
 *   `pruneSession()`，然後**用同一把 meter 重新計量；壓力降到安全水平就跳過模型呼叫**
 *   （`.agents/notes/implemented/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.zh.md`）。
 *   「低于压力的对话绝不被碰」是那一層的性質，不是剪刀自己的。
 *
 * ## 兩筆偏離登記（AGENTS.md 的規則）
 *
 * **一、剪在請求上，不是剪在日誌上。** dsh 是**落盤**的：它 append 一則新的 `tool/result`
 * 取代表層節點，並在它前面緊貼一顆 `compaction/prune` 影子價格事件，用注入的
 * `tokenMeter` 替被遮蔽的節點計價，讓純消費者不必自己記狀態就能扣掉。我們沒有那條路，
 * **而 2026-09-05 起擋住它的理由換了一條**：會話日誌現在落得了盤
 * （[#172](https://github.com/DemianLi/nexus-agent/issues/172)、
 * [#174](https://github.com/DemianLi/nexus-agent/issues/174)），所以「不落盤」不再是原因。
 * 今天缺的是另外兩樣：
 *
 * - **事件詞彙對不上。** 我們的日誌刻意不記訊息內容（`session-log.ts` 檔頭：兩條路的
 *   顆粒度不一樣），所以沒有一則「取代表層節點的 `tool/result`」可寫——要寫得先擴詞彙，
 *   而詞彙一擴就是一次帶格式版本的遷移。
 * - **沒有可注入的 token meter**，所以影子價格那一顆也記不出來。
 *
 * 結論沒變，理由整條換掉。所以我們**只改這一次請求看到的訊息**：
 *
 * - 好處是**原文沒有消失**，它還在圖的狀態裡；下一輪從完整原文重新剪一次。
 * - 代價是**沒有事件、沒有影子價格、省下的量每一輪都要重付一次**，而不是落一次地就算數。
 * - 這正是 [#149](https://github.com/DemianLi/nexus-agent/issues/149) 卡上那個
 *   ❌「原文留日誌供回放」的誠實對應：**不是做到了，也不是丟了。**
 *
 * **二、掛點不是我們選的，是唯一的。** 剪必須發生在基座摘要器**外面**才救得到那次模型
 * 呼叫，而基座的 `mergeMiddlewareStack` 回的是
 * `[...預設（同名就地取代）, ...新名字的, ...tail]`——`SummarizationMiddleware` 在**預設**
 * 那段，新名字的一律排在它**後面**（也就是更內層）。**沒有任何一個陣列位置能讓一個新
 * 名字的 middleware 站到摘要器外面**（#159 的「排第 0 格」只排得贏其他 custom，同一個
 * 天花板）。所以這把剪刀不是一顆獨立的 middleware，而是**包在同名取代的那顆摘要器外面**
 * ——見 {@link ./summarization.ts} 的 `createSummarizer`。
 *
 * 兩個後果要明講：
 *
 * - **`summarization: false` 就沒有剪。** 剪刀搭在摘要器上，摘要器不在就一起不在。這與
 *   dsh 一致（那邊的 pruner 也是 optional，`ctx.get('toolResultPruner')` 拿不到就不剪），
 *   而且它**不是**第二顆開關——我們沒有加開關。
 * - **與 `truncateArgs` 是兩件事。** 那個剪的是舊訊息裡的工具**參數**（門檻
 *   `{messages: 20}`），這個剪的是工具**結果**，而且跑在它前面。互不取代。
 *
 * ## 一條不准破的性質：長度與順序不變
 *
 * 基座的 `getEffectiveMessages` 是 `[summaryMessage, ...messages.slice(cutoffIndex)]`，
 * 而那個 `cutoffIndex` 是**前幾輪**算出來存在 state 裡的。少一則訊息，那個 slice 就切在
 * 錯的地方，AI／Tool 配對當場斷掉——而且不會拋。所以 {@link pruneToolResults} **只換內容、
 * 永遠不刪訊息**；連內容剪成空字串的區塊都只在訊息**內部**丟掉（dsh 同款）。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

/** 每一段被剪掉的中段換成這個標記。結構照抄 dsh 的 `PRUNE_MARKER`，字面走中文。 */
export const TOOL_RESULT_PRUNE_MARKER = '\n\n[... 工具結果中段已剪除 ...]\n\n';

/** 一份工具結果的字元預算，單位是 Unicode code point。 */
export interface ToolResultPruneConfig {
  /** 文字總量超過這麼多 code point 才剪。 */
  readonly thresholdChars: number;
  /** 頭部最多留幾個 code point。 */
  readonly headChars: number;
  /** 尾部最多留幾個 code point。 */
  readonly tailChars: number;
}

/** dsh 的預設值，原值照抄（`compaction-tool-result-pruner/src/config.ts`）。 */
export const DEFAULT_TOOL_RESULT_PRUNE: ToolResultPruneConfig = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
};

/**
 * 數 Unicode code point，不是 UTF-16 code unit。
 *
 * `'😀'.length` 是 2 但只有一個 code point；用 `.length` 去切會劈開代理對，剪出來的尾巴
 * 開頭會是一個孤兒 surrogate。字素叢集（emoji ＋ 修飾符）還是可能被切開，dsh 也一樣，
 * 那是它明文接受的代價。
 *
 * @param text - 要量的文字。
 * @returns code point 數。
 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * 驗一份預算，順便擋掉「剪完比門檻還大」。
 *
 * dsh 在載入期做這件事（`resolveConfig`）。照抄的理由是它把一整類 bug 移到設定那一層：
 * 只要 `headChars ＋ 標記 ＋ tailChars ≤ thresholdChars` 成立，剪出來的東西就不可能還在
 * 門檻之上，剪刀本身不必再防一次。
 *
 * @param config - 要驗的預算。
 * @returns 原樣回傳，方便串接。
 * @throws 任何一格不是非負整數、`thresholdChars` 不是正整數，或頭尾加標記塞不進門檻。
 */
export function assertToolResultPruneConfig(config: ToolResultPruneConfig): ToolResultPruneConfig {
  assertPositiveInteger('thresholdChars', config.thresholdChars);
  assertNonNegativeInteger('headChars', config.headChars);
  assertNonNegativeInteger('tailChars', config.tailChars);
  const emitted = config.headChars + codePointLength(TOOL_RESULT_PRUNE_MARKER) + config.tailChars;
  if (emitted > config.thresholdChars)
    throw new Error(
      `工具結果預算不成立：headChars ＋ 標記 ＋ tailChars（${emitted}）` +
        `必須不大於 thresholdChars（${config.thresholdChars}）。`,
    );
  return config;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`工具結果預算的 ${name} 是 ${String(value)}，要正整數。`);
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`工具結果預算的 ${name} 是 ${String(value)}，要非負整數。`);
}

/**
 * 一則工具結果的內容：字串，或 LangChain 的複合區塊陣列。
 *
 * 走陣列那條時，只有 `type === 'text'` 的區塊算進預算、也只有它們會被剪；圖片之類的
 * **原序留著**（dsh 的 `measureContent`／`pruneContent` 同款）。
 */
type ContentPart = Extract<BaseMessage['content'], readonly unknown[]>[number];
type TextBlock = ContentPart & { type: 'text'; text: string };

function isTextBlock(block: ContentPart): block is TextBlock {
  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === 'text' && typeof candidate.text === 'string';
}

/**
 * 量一則內容裡的文字總量。
 *
 * @param content - 工具結果的內容。
 * @returns 文字區塊的 code point 總數；非文字區塊算 0。
 */
export function measureToolResultContent(content: BaseMessage['content']): number {
  if (typeof content === 'string') return codePointLength(content);
  let chars = 0;
  for (const block of content) if (isTextBlock(block)) chars += codePointLength(block.text);
  return chars;
}

/**
 * 把一則超出預算的內容剪成頭 ＋ 標記 ＋ 尾。
 *
 * 被剪掉的是 `[headChars, 總量 − tailChars)` 這一段，**跨區塊**算：頭尾的邊界可能落在
 * 不同的文字區塊裡，標記只插一次（插在第一個與被剪區間相交的區塊上）。這正是 dsh
 * `pruneContent` 的做法，理由是文字被切成幾塊是傳輸的細節，不該影響剪出來的形狀。
 *
 * @param content - 原內容。
 * @param config - 預算。
 * @returns 剪過的內容；**沒超過門檻時回 `null`**（呼叫端據此判斷「一字不動」）。
 */
export function pruneToolResultContent(
  content: BaseMessage['content'],
  config: ToolResultPruneConfig,
): BaseMessage['content'] | null {
  const totalChars = measureToolResultContent(content);
  if (totalChars <= config.thresholdChars) return null;

  const removedStart = config.headChars;
  const removedEnd = totalChars - config.tailChars;

  if (typeof content === 'string') {
    const points = Array.from(content);
    return (
      points.slice(0, removedStart).join('') +
      TOOL_RESULT_PRUNE_MARKER +
      points.slice(removedEnd).join('')
    );
  }

  const pruned: ContentPart[] = [];
  let consumed = 0;
  let markerInserted = false;
  for (const block of content) {
    if (!isTextBlock(block)) {
      pruned.push(block);
      continue;
    }
    const points = Array.from(block.text);
    const blockStart = consumed;
    const blockEnd = blockStart + points.length;
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
    const intersects = blockStart < removedEnd && blockEnd > removedStart;
    const marker = intersects && !markerInserted ? TOOL_RESULT_PRUNE_MARKER : '';
    if (marker.length > 0) markerInserted = true;
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('');
    // 空區塊丟掉是**訊息內部**的事，訊息本身永遠留著——理由見檔頭那條「長度與順序不變」。
    if (text.length > 0) pruned.push({ ...block, text });
    consumed = blockEnd;
  }
  return pruned;
}

/** 一趟剪下來的帳。 */
export interface ToolResultPruneResult {
  /** 剪過的訊息串。**長度與順序與輸入完全相同。** */
  readonly messages: readonly BaseMessage[];
  /** 被改寫的工具結果則數。0 代表一字未動。 */
  readonly prunedCount: number;
  /** 一共少掉幾個 code point。 */
  readonly charsRemoved: number;
}

/**
 * 把訊息串裡每一則超出預算的工具結果剪掉中段。
 *
 * **只換 `content`，其餘欄位（`tool_call_id`、`name`、`status`、`artifact`……）原樣帶過**
 * ——這是 dsh 那句「替换保留工具呼叫、步骤、错误与元数据，只有文本变」的對應。
 *
 * @param messages - 原訊息串。
 * @param config - 預算，預設 {@link DEFAULT_TOOL_RESULT_PRUNE}。
 * @returns 剪過的訊息串與帳目。一則都沒剪時 `messages` 就是**原本那個陣列**。
 */
export function pruneToolResults(
  messages: readonly BaseMessage[],
  config: ToolResultPruneConfig = DEFAULT_TOOL_RESULT_PRUNE,
): ToolResultPruneResult {
  let prunedCount = 0;
  let charsRemoved = 0;
  const next = messages.map((message) => {
    if (!ToolMessage.isInstance(message)) return message;
    const pruned = pruneToolResultContent(message.content, config);
    if (pruned === null) return message;
    prunedCount += 1;
    charsRemoved += measureToolResultContent(message.content) - measureToolResultContent(pruned);
    // `ToolMessage` 的複製建構子：帶著全部欄位進去，只換 `content`。
    return new ToolMessage({ ...message, content: pruned });
  });
  if (prunedCount === 0) return { messages, prunedCount: 0, charsRemoved: 0 };
  return { messages: next, prunedCount, charsRemoved };
}
