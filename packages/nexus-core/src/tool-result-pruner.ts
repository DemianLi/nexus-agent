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
 * > **2026-09-30 補（[#719](https://github.com/DemianLi/nexus-agent/issues/719)）**：外溢層（`spill-policy.ts`）開著時，
 * > 上界從 80,000 字元往下拉到它的 `maxInlineTokens`（出貨 12,500 token，約 5 萬字元）——超過的結果先被換成預覽加路徑，
 * > 輪不到這把剪刀。外溢層關掉才回到下面說的 80,000 字元。

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

**一、剪的是請求，不是 session 的訊息節點；但決定落盤了（[#1302](https://github.com/DemianLi/nexus-agent/issues/1302)，日誌格式 46）。**
dsh 先 append 一顆 `compaction/prune` 影子價格事件，緊接著 append 一顆替換用的 `tool/result`（`surfaceOp: replace`、`sourceEventSeqs`），
替換永久有效。我們**沒有 surface 那一軸**（沒有 `surfaceOp`，替換不能掛在事件上），也**沒有可注入的 token meter**（影子價格記不出來）。
退到最接近的實作：**一顆 `compaction/prune` 事件自己帶替換的內容**（`results: [{ callId, originalChars, content }]`，見 `session-log.ts`）；
`callId` 指向被替換的 `tool/result`，因為請求端的剪刀看到的是訊息、不是事件，沒有 `seq` 可指。

- **每顆結果只記一次，之後每次請求都沿用**（{@link withToolResultPruning}）：先把日誌上記過的換上去，再在壓力到了時剪還沒記過的、當場記。
  這是對 dsh「替換永久有效」的對應，也是**與以前唯一的行為差別**——以前每次從原文重算、壓力退了（摘要之後常見）原文會回來，現在不會。
- **記內容，不記規則**：2026-10-09 拍板的理由是歷史要能只從日誌推導、不能依賴程式碼版本。門檻、頭尾長度、標記字改了，已剪的仍是當時剪成的樣子。
- **原文沒有消失**：圖的狀態與 `tool/result` 事件仍是原文；只有送給模型的那一份是剪過的。續接灌回 graph state 的那一串也是原文
  （`replayConversation` 的 `applyPrunes` 預設關），下一次請求由這裡照日誌換上去。
- 沒剪的會話，日誌與以前位元組相同。沒有日誌（組裝沒接註冊表）時退回以前的每次重算。

**二、掛點不是我們選的，是唯一的。** 剪必須發生在基座摘要器**外面**才救得到那次模型
 * 呼叫，而基座的 `mergeMiddlewareStack` 回的是
 * `[...預設（同名就地取代）, ...新名字的, ...tail]`——`SummarizationMiddleware` 在**預設**
 * 那段，新名字的一律排在它**後面**（也就是更內層）。**沒有任何一個陣列位置能讓一個新
 * 名字的 middleware 站到摘要器外面**（#159 的「排第 0 格」只排得贏其他 custom，同一個
 * 天花板）。所以這把剪刀不是一顆獨立的 middleware，而是**包在同名取代的那顆摘要器外面**
 * ——見 {@link withToolResultPruning}，組裝在 {@link ./summarization.ts} 的 `createSummarizer`。
 *
 * 兩個後果要明講：
 *
 * - **它有自己的開關，但只在摘要開著時有作用**（[#446](https://github.com/DemianLi/nexus-agent/issues/446)）。
 *   dsh 的 pruner 是一個 Service，唯一的消費者是 `compaction-basic`（`ctx.get('toolResultPruner')`
 *   選擇性地讀，拿不到就不剪）：修剪可以單獨不掛，摘要照跑；摘要不掛，修剪就沒人叫。
 *   我們的兩格對應同一張表——`FoldOptions.toolResultPruning: false` 是摘要外面不包剪刀，
 *   `summarization: false` 則連剪刀一起沒有。
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
import { z } from 'zod';
import type { AgentMiddleware } from './base-types.js';
import type { NexusPlugin } from './plugin.js';
import type { PluginRegistry } from './registry.js';
import {
  applyRecordedPrunes,
  codePointLength,
  isTextBlock,
  measureToolResultContent,
} from './tool-result-prune-log.js';
import type { ContentPart, RecordedPrunes } from './tool-result-prune-log.js';

export { codePointLength, measureToolResultContent };

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

/**
 * 把組裝點給的那一格補成一份預算，或明著不要。
 *
 * 省略即 {@link DEFAULT_TOOL_RESULT_PRUNE}；給物件就逐格淺合併上去，再用
 * {@link assertToolResultPruneConfig} 驗——照 dsh，設定寫錯在載入期就失敗，不等到第一次
 * 真的要剪。`false` 原樣回去。
 *
 * @param option - `FoldOptions.toolResultPruning` 那一格。
 * @returns 驗過的預算，或 `false`。
 * @throws 合併後的預算不成立，見 {@link assertToolResultPruneConfig}。
 */
export function resolveToolResultPruneConfig(
  option: Partial<ToolResultPruneConfig> | false | undefined,
): ToolResultPruneConfig | false {
  if (option === false) return false;
  return assertToolResultPruneConfig({ ...DEFAULT_TOOL_RESULT_PRUNE, ...option });
}

/**
 * 剪刀跟會話日誌的接口（[#1302](https://github.com/DemianLi/nexus-agent/issues/1302)）：讀出日誌上記過的剪法，記下新剪的。
 * 組裝在 {@link ./summarization.ts} 的 `createSummarizer`（那裡有會話註冊表與「這次請求真正送出去的是哪一段」）。
 */
export interface ToolResultPruneLog {
  /** 這次請求所屬那份日誌上記過的剪法；**找不到日誌**（沒接註冊表、認不出呼叫者）是 `undefined`，剪刀退回每次重算。 */
  recorded(request: PruneRequest): RecordedPrunes | undefined;
  /** 把這次新剪的記進日誌。記不進去自己吃掉：記不進去不能反過來把模型呼叫殺掉。 */
  record(request: PruneRequest, results: readonly NewlyPruned[]): void;
}

/** 這次新剪的一顆：被剪的結果的 `tool_call_id`、剪之前的文字量、剪過的內容。 */
export interface NewlyPruned {
  readonly callId: string;
  readonly originalChars: number;
  readonly content: BaseMessage['content'];
}

/** 剪刀看到的請求。 */
export interface PruneRequest {
  readonly messages?: readonly BaseMessage[];
  readonly state?: unknown;
  readonly systemMessage?: unknown;
  readonly tools?: unknown;
  readonly model?: unknown;
  readonly runtime?: unknown;
}

/**
 * 把一把剪刀包在摘要器外面。
 *
 * 基座那顆是一個普通物件（`name` / `stateSchema` / `wrapModelCall` ／其餘鉤子皆為
 * `undefined`，全部可列舉），所以展開它就能原封不動保住 `name` 與 `stateSchema`——
 * **這兩樣少一樣，同名取代就不成立、狀態就對不上**，實測過才這樣寫。
 *
 * 這一層**沒有 closure 狀態**，所以 `foldSummarizer` 逐個 agent 建一份的理由沒有變多也
 * 沒有變少，還是原本那一條（基座那顆的 `sessionId` 在它自己的 closure 裡）。
 *
 * **「壓力到了沒」由呼叫端給。** 判準是摘要器自己的門檻（dsh 的 `compaction-basic` 壓力
 * 達標才 `pruneSession()`），那是摘要那一側的知識；這個檔只管怎麼剪。
 *
 * ## 有日誌時：剪過就永遠是剪過的（#1302，照 dsh）
 *
 * 每次呼叫先把日誌上記過的剪法換上去（{@link applyRecordedPrunes}，不看壓力、不重算），再在壓力到了時剪**還沒記過**的，剪出來的
 * 當場記一筆 `compaction/prune`（**在這次請求往下交之前**，所以排在這次的 `compaction/summary` 與 `model/start` 之前）。
 * 於是日誌就是模型看到的那一份的唯一來源：門檻、頭尾長度改了、壓力退了（摘要之後常見），已經剪過的仍是當時剪成的樣子。
 * **行為上與以前的差別只有一處**：以前壓力退了之後原文會回來（剪刀每次從原文重算、壓力不到就不碰），現在不會。
 * 沒有日誌（`log` 省略、或找不到那份日誌）時退回以前的每次重算。
 *
 * @param base - 基座那顆摘要器。
 * @param underPressure - 這次請求到了壓縮門檻沒有。收的是整份請求：`tokens` 門檻要估 system 與工具定義那一截
 *   （[#588](https://github.com/DemianLi/nexus-agent/issues/588)）。
 * @param config - 預算，來自 {@link resolveToolResultPruneConfig}。
 * @param log - 日誌接口；省略即不記、每次重算。
 * @returns 同名、同狀態、外面多一層前處理的 middleware。
 */
export function withToolResultPruning(
  base: AgentMiddleware,
  underPressure: (request: PruneRequest) => boolean,
  config: ToolResultPruneConfig,
  log?: ToolResultPruneLog,
): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 基座那顆一定有 wrapModelCall；沒有的話包了也沒意義，原樣回去。 */
  if (inner === undefined) return base;
  return {
    ...base,
    wrapModelCall: async (request, handler) => {
      const original = request.messages ?? [];
      let messages: readonly BaseMessage[] = original;
      const recorded = log?.recorded(request as PruneRequest);
      if (recorded !== undefined) messages = applyRecordedPrunes(messages, recorded);
      if (underPressure(request as PruneRequest)) {
        const { prunedCount, messages: pruned } = pruneToolResults(messages, config);
        if (prunedCount > 0) {
          if (log !== undefined && recorded !== undefined) {
            log.record(request as PruneRequest, newlyPruned(messages, pruned));
          }
          messages = pruned;
        }
      }
      if (messages === original) return inner(request, handler);
      return inner({ ...request, messages: [...messages] }, handler);
    },
  } as AgentMiddleware;
}

/** 前後兩串逐則比，列出被剪的那些工具結果。 */
function newlyPruned(before: readonly BaseMessage[], after: readonly BaseMessage[]): NewlyPruned[] {
  const out: NewlyPruned[] = [];
  for (const [index, message] of before.entries()) {
    const next = after[index];
    if (next === undefined || next === message || !ToolMessage.isInstance(message)) continue;
    out.push({
      callId: message.tool_call_id,
      originalChars: measureToolResultContent(message.content),
      content: next.content,
    });
  }
  return out;
}

/**
 * 剪刀預算的服務名。fold 從這裡讀條目提供的那一份。
 *
 * **沒人提供不等於「不剪」**：那兩種成因的正確答案相反，分野見
 * {@link ./registry.ts | DisabledEntryView}。
 */
export const TOOL_RESULT_PRUNE_SERVICE = 'toolResultPruning';

/**
 * 這個條目的 plugin 名。
 *
 * **承重的常數**：{@link ./fold.ts | foldRegistry} 拿它去問
 * {@link ./registry.ts | DisabledEntryView}。刻意不是條目的 `id`——id 是使用者的 patch
 * 改得動的字串（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。
 */
export const TOOL_RESULT_PRUNER_PLUGIN_NAME = 'tool-result-pruner';

/**
 * 條目收的設定。每一格都可省，省掉的那格用 {@link DEFAULT_TOOL_RESULT_PRUNE} 的值。
 *
 * **預設值只寫在一個地方**：這裡的 `.default()` 指的就是那個常數的欄位，不是把數字再抄
 * 一次。**跨欄位那條規則（`headChars ＋ 標記 ＋ tailChars ≤ thresholdChars`）不在這個
 * schema 裡**，它留在 {@link assertToolResultPruneConfig}——那是唯一知道它的地方，抄進
 * schema 就是第二個真相。所以壞值的失敗點是 `apply`，而 `apply` 一樣在載入期。
 *
 * **YAML 的 patch 是整份替換 `config`，這一層卻是逐欄補預設**。兩者不打架，因為合併的
 * 底盤兩邊都是預設值：`config: { thresholdChars: 4096 }` 之後其餘兩格拿到的還是
 * {@link DEFAULT_TOOL_RESULT_PRUNE} 的值，跟 `resolveToolResultPruneConfig({ thresholdChars: 4096 })`
 * 的結果逐格相同。
 */
export const toolResultPrunerConfigSchema = z.strictObject({
  /** 見 {@link ToolResultPruneConfig.thresholdChars}。 */
  thresholdChars: z.number().default(DEFAULT_TOOL_RESULT_PRUNE.thresholdChars),
  /** 見 {@link ToolResultPruneConfig.headChars}。 */
  headChars: z.number().default(DEFAULT_TOOL_RESULT_PRUNE.headChars),
  /** 見 {@link ToolResultPruneConfig.tailChars}。 */
  tailChars: z.number().default(DEFAULT_TOOL_RESULT_PRUNE.tailChars),
});

/** {@link toolResultPrunerConfigSchema} 驗完的形狀。 */
export type ToolResultPrunerConfig = z.infer<typeof toolResultPrunerConfigSchema>;

/**
 * 工具結果剪刀的**設定條目**（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。
 *
 * 它只做一件事：把驗過的預算提供成 {@link TOOL_RESULT_PRUNE_SERVICE} 服務。
 * **剪刀不在這裡包**——它由 {@link ./fold.ts | foldRegistry} 包在摘要器外面，而且只在摘要
 * 開著時有作用（dsh 的 pruner 唯一的消費者是 compaction）。
 *
 * **這是登記過的偏離**，同 {@link ./repeat-reminder.ts | repeatReminderPlugin}：dsh 那側
 * `tool-result-pruner` 是 base 的一個獨立套件；我們表達不出來的是「包在摘要器外面、逐個
 * agent 跟著摘要器一起建」。偏的是載體，設定的語意沒有偏。
 */
export const toolResultPrunerPlugin: NexusPlugin<ToolResultPrunerConfig> = {
  name: TOOL_RESULT_PRUNER_PLUGIN_NAME,
  Config: toolResultPrunerConfigSchema,
  apply(registry: PluginRegistry, config: ToolResultPrunerConfig) {
    // **驗在這裡、只驗一次。** 跨欄位規則住在 assert 裡，所以提供出去的是已經驗過的
    // 預算，fold 拿到就直接用。
    registry.services.provide(TOOL_RESULT_PRUNE_SERVICE, assertToolResultPruneConfig(config));
  },
};

export default toolResultPrunerPlugin;
