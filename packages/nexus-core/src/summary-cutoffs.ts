/**
 * 摘要的切點表：每次組裝一張，記「這條 thread 的這個 agent 上一次摘要切在哪」。
 *
 * ## 寫：日誌寫進去了才寫
 *
 * 切點在引擎把摘要過的請求交下去的那一刻算出來（`summarization.ts` 的 `withCompactionLog`）。有日誌時 `compaction/summary` 寫成功才算數，
 * 寫不進去這次摘要就不生效（#1702），表也不寫；沒有日誌（或這次呼叫不屬於任何一份）時，交下去就算數。表在這一步結束時落定，所以同一步
 * 裡溢出重摘的那一次讀的仍是這一步開始時的切點，最後落定的是最後一次。
 *
 * 跟日誌同一個時點，所以有日誌時表上的就是「這個生命週期日誌上最後一筆」；之後那次模型呼叫失敗也不會遺失（#1390）。
 *
 * ## 讀：這一步開始時讀一次，用請求的訊息驗過
 *
 * 摘要器最外層在這一步開始時讀一次，交給內層各層當這一步的「上一次切點」；`agent/pre-step` 在一次 invoke 開始時（第一步之前）讀，
 * 同一張表，讀到的跟摘要器在這次 invoke 第一步讀到的是同一個值。
 *
 * 座標是摘要器收到的 `request.messages`（同基座 `getEffectiveMessages(request.messages, …)`）。排在摘要器外層的幾顆換訊息物件時保留
 * id 與位置，所以它跟 state 的訊息串同一個座標；pre-step 拿 state 的來問，對到的是同一格。
 *
 * 條目記著切點前最後一則訊息（`messages[cutoffIndex - 1]`）的 id。讀的時候訊息串在同一格不是那一則，這個條目就不是這份
 * state 的：沒有 checkpointer 的 langgraph 組裝每次 invoke 從新的訊息串起跑，續接灌回的是「摘要＋之後」，都對不上，等於沒有切點。
 * 所以**切點的效力**跟著訊息 state 走；條目本身留到組裝丟掉為止（見〈清理〉），每個前景委派的 runId 各佔一格，不另設數量上限。
 *
 * ## 鍵
 *
 * `thread_id` 加上這次呼叫的身分（`session-address.ts` 的 {@link toolCallSessionAddress}：root、前景子代理的 runId、背景子代理的
 * 背景 id），同 `sessions.forCall` 認日誌用的那一把。摘要器的歷史檔會話名也用這一把（{@link summaryCallKey}），每把鍵一個。
 *
 * ## 清理
 *
 * 表掛在組裝上（{@link summaryCutoffsOf}），組裝丟掉表就跟著丟。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentMiddleware } from './base-types.js';
import { callThreadId, sessionAddressKey, toolCallSessionAddress } from './session-address.js';

/** 一次摘要的結果：切點（state 訊息串的座標）、換上去的摘要訊息、歷史檔路徑（寫失敗是 `null`，#66）。 */
export interface SummaryCutoff {
  readonly cutoffIndex: number;
  readonly summaryMessage: BaseMessage;
  readonly filePath: string | null;
}

interface Entry {
  readonly cutoff: SummaryCutoff;
  /** 切點前最後一則訊息的 id；沒有 id 時比物件本身。 */
  readonly anchorId: string | undefined;
  readonly anchor: WeakRef<BaseMessage> | undefined;
}

/** 摘要的切點表，見檔頭。 */
export class SummaryCutoffTable {
  readonly #entries = new Map<string, Entry>();

  /**
   * 這次呼叫的上一次切點。
   *
   * @param config - `{ configurable }`，同 `sessions.forCall`。
   * @param messages - 這一步的訊息串（摘要器的 `request.messages`，或 pre-step 的 state；同一個座標）。
   * @returns 切點；沒有、或條目不是這份 state 的，回 `undefined`。
   */
  lookup(config: unknown, messages: readonly BaseMessage[]): SummaryCutoff | undefined {
    const key = summaryCallKey(config);
    if (key === undefined) return undefined;
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    const { cutoffIndex } = entry.cutoff;
    if (cutoffIndex > messages.length) return undefined;
    if (cutoffIndex < 1) return entry.cutoff;
    const at = messages[cutoffIndex - 1];
    const same =
      entry.anchorId !== undefined
        ? at?.id === entry.anchorId
        : at !== undefined && at === entry.anchor?.deref();
    return same ? entry.cutoff : undefined;
  }

  /**
   * 記下這次呼叫的切點，蓋掉舊的。
   *
   * @param config - `{ configurable }`。
   * @param messages - 算出這個切點的那一步，摘要器收到的 `request.messages`。
   * @param cutoff - 切點。
   */
  record(config: unknown, messages: readonly BaseMessage[], cutoff: SummaryCutoff): void {
    const key = summaryCallKey(config);
    if (key === undefined) return;
    const anchor = cutoff.cutoffIndex >= 1 ? messages[cutoff.cutoffIndex - 1] : undefined;
    this.#entries.set(key, {
      cutoff,
      anchorId: typeof anchor?.id === 'string' ? anchor.id : undefined,
      anchor: anchor === undefined ? undefined : new WeakRef(anchor),
    });
  }
}

/**
 * 這次呼叫在切點表上的鍵：`thread_id` 加上呼叫身分，見檔頭〈鍵〉。
 *
 * @param config - `{ configurable }`，同 `sessions.forCall`。
 * @returns 鍵；認不出身分（不在圖裡）回 `undefined`。沒有 `thread_id` 的呼叫共用空字串那一格。
 */
export function summaryCallKey(config: unknown): string | undefined {
  const address = toolCallSessionAddress(config);
  if (address === undefined) return undefined;
  return `${callThreadId(config) ?? ''}\u0000${sessionAddressKey(address)}`;
}

const tables = new WeakMap<object, SummaryCutoffTable>();

/**
 * 這次組裝的切點表。摘要器（`fold.ts`）與 `agent/pre-step`（宿主）各自拿同一張註冊表來問，拿到的是同一張表。
 *
 * @param assembly - 這次組裝的註冊表。
 * @returns 這次組裝的那一張，第一次問時建。
 */
export function summaryCutoffsOf(assembly: object): SummaryCutoffTable {
  let table = tables.get(assembly);
  if (table === undefined) tables.set(assembly, (table = new SummaryCutoffTable()));
  return table;
}

/**
 * 摘要過的有效訊息串：`[摘要, ...messages.slice(cutoffIndex)]`，同基座的 `getEffectiveMessages`。
 *
 * @param messages - state 的訊息串。
 * @param cutoff - 上一次切點；沒有就原樣回。
 * @returns 模型看得到的那一串。
 */
export function applySummaryCutoff(
  messages: readonly BaseMessage[],
  cutoff: SummaryCutoff | undefined,
): readonly BaseMessage[] {
  return cutoff === undefined
    ? messages
    : [cutoff.summaryMessage, ...messages.slice(cutoff.cutoffIndex)];
}

/**
 * 摘要過的請求交下去時，這次的切點（state 訊息串的座標）。同基座 `summarizeMessages` 的 `stateCutoffIndex`：
 * 這次在有效串裡切在 `effectiveLength − (sentLength − 1)`，有上一次切點時再減去它換掉的那一格（`previous + local − 1`）。
 *
 * @param previous - 這一步開始時的上一次切點。
 * @param effectiveLength - 這一步的有效串長度（{@link applySummaryCutoff}）。
 * @param sentLength - 交下去的那份長度（摘要一則加上留下的尾巴）。
 * @returns 切點。
 */
export function summaryCutoffIndex(
  previous: number | undefined,
  effectiveLength: number,
  sentLength: number,
): number {
  const local = effectiveLength - (sentLength - 1);
  return previous === undefined ? local : previous + local - 1;
}

/** 這一步的切點：開始時查到的上一次（整步不變），與這一步生效的最後一個（最外層在這一步結束時落表）。 */
interface CutoffCell {
  readonly previous: SummaryCutoff | undefined;
  latest: SummaryCutoff | undefined;
}
const cutoffCells = new AsyncLocalStorage<CutoffCell>();

/**
 * 這一步的上一次切點：最外層在這一步開始時查表定下，同一步裡溢出重摘、退到 retain 0、照原請求重走讀到的都是這一個。
 *
 * @returns 上一次切點；沒有、或不在摘要器的一步裡，回 `undefined`。
 */
export function previousSummaryCutoff(): SummaryCutoff | undefined {
  return cutoffCells.getStore()?.previous;
}

/**
 * 這一步到目前為止生效的最後一個切點（{@link noteSummaryCutoff} 寫的）。
 *
 * @returns 切點；這一步還沒有、或不在摘要器的一步裡，回 `undefined`。
 */
export function latestSummaryCutoff(): SummaryCutoff | undefined {
  return cutoffCells.getStore()?.latest;
}

/**
 * 這一步算出一個生效的切點（`withCompactionLog` 在日誌寫進去之後、沒有日誌時在交下去時叫）。
 *
 * @param cutoff - 切點。
 */
export function noteSummaryCutoff(cutoff: SummaryCutoff): void {
  const cell = cutoffCells.getStore();
  if (cell !== undefined) cell.latest = cutoff;
}

/**
 * 摘要器的最外層：這一步開始時讀表定下上一次切點（{@link previousSummaryCutoff}），這一步結束時（成功或拋錯）把這一步生效的切點落表。
 *
 * @param base - 其餘各層包好的摘要器。
 * @param table - 這次組裝的切點表。
 * @returns 同名的 middleware。
 */
export function withSummaryCutoffs(
  base: AgentMiddleware,
  table: SummaryCutoffTable,
): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 摘要器一定有 wrapModelCall；沒有的話包了也沒意義，原樣回去。 */
  if (inner === undefined) return base;
  return {
    ...base,
    wrapModelCall: async (request, handler) => {
      const config = {
        configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
      };
      // 切點用 `request.messages` 的座標，見檔頭〈讀〉。
      const messages = request.messages ?? [];
      const cell: CutoffCell = { previous: table.lookup(config, messages), latest: undefined };
      try {
        return await cutoffCells.run(cell, () => inner(request, handler));
      } finally {
        if (cell.latest !== undefined) table.record(config, messages, cell.latest);
      }
    },
  } as AgentMiddleware;
}
