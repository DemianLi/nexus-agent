/**
 * 摘要的切點表（[#2416](https://github.com/DemianLi/nexus-agent/issues/2416) K7c c-1）：每次組裝一張，記「這條 thread 的這個 agent
 * 上一次摘要切在哪」，取代基座放在 graph state 的私有鍵 `_summarizationEvent`。
 *
 * ## 寫：日誌寫進去了才寫
 *
 * 切點在基座把摘要過的請求交下去的那一刻算出來（`summarization.ts` 的 `withCompactionLog`）。有日誌時 `compaction/summary` 寫成功才算數，
 * 寫不進去這次摘要就不生效（#1702），表也不寫；沒有日誌（或這次呼叫不屬於任何一份）時，交下去就算數。表在這一步結束時落定，所以同一步
 * 裡溢出重摘的那一次讀的仍是這一步開始時的切點，最後落定的是最後一次。
 *
 * 跟日誌同一個時點，所以有日誌時表上的就是「這個生命週期日誌上最後一筆」；之後那次模型呼叫失敗也不會遺失（以前要靠下一步請求前從日誌補回
 * state，#1390）。
 *
 * ## 讀：這一步開始時讀一次，用 state 的訊息驗過
 *
 * 摘要器最外層在這一步開始時讀一次，交給內層各層當這一步的「上一次切點」；`agent/pre-step` 在一次 invoke 開始時讀，同一張表。
 *
 * 條目記著切點前最後一則訊息（`messages[cutoffIndex - 1]`）的 id。讀的時候 state 的訊息串在同一格不是那一則，這個條目就不是這份
 * state 的：沒有 checkpointer 的 langgraph 組裝每次 invoke 從新的訊息串起跑，續接灌回的是「摘要＋之後」，都對不上，等於沒有切點。
 * **所以條目的壽命等於訊息 state 的壽命**，不另設數量上限。
 *
 * ## 鍵
 *
 * `thread_id` 加上這次呼叫的身分（`session-address.ts` 的 {@link toolCallSessionAddress}：root、前景子代理的 runId、背景子代理的
 * 背景 id），同 `sessions.forCall` 認日誌用的那一把。歷史檔的會話名不在這裡，跟著摘要器實例走。
 *
 * ## 清理
 *
 * 表掛在組裝上（{@link summaryCutoffsOf}），組裝丟掉表就跟著丟。serve 一條 thread 一次組裝，閒置淘汰時整個組裝收掉。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { BaseMessage } from '@langchain/core/messages';
import { isCommand } from '@langchain/langgraph';
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
   * @param messages - 這一步 state 的訊息串。
   * @returns 切點；沒有、或條目不是這份 state 的，回 `undefined`。
   */
  lookup(config: unknown, messages: readonly BaseMessage[]): SummaryCutoff | undefined {
    const key = keyOf(config);
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
   * @param messages - 算出這個切點的那一步 state 的訊息串。
   * @param cutoff - 切點。
   */
  record(config: unknown, messages: readonly BaseMessage[], cutoff: SummaryCutoff): void {
    const key = keyOf(config);
    if (key === undefined) return;
    const anchor = cutoff.cutoffIndex >= 1 ? messages[cutoff.cutoffIndex - 1] : undefined;
    this.#entries.set(key, {
      cutoff,
      anchorId: typeof anchor?.id === 'string' ? anchor.id : undefined,
      anchor: anchor === undefined ? undefined : new WeakRef(anchor),
    });
  }
}

/** 認不出身分（不在圖裡）就沒有鍵：那次呼叫不讀也不寫。沒有 `thread_id` 的呼叫共用空字串那一格，靠訊息驗證分開。 */
function keyOf(config: unknown): string | undefined {
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

/** 這一步裡算出、日誌也寫進去了的最後一個切點；最外層在這一步結束時落表。 */
interface CutoffCell {
  latest: SummaryCutoff | undefined;
}
const cutoffCells = new AsyncLocalStorage<CutoffCell>();

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
 * 摘要器的最外層：這一步開始時讀表，把上一次切點以基座認得的形狀交給內層；這一步結束時（成功或拋錯）把這一步生效的切點落表。
 * 內層（基座）摘要過會回一顆帶私有鍵的 `Command`，這裡換回那一步的模型回覆，私有鍵不進 graph state。
 *
 * 回傳的 middleware 沒有 `stateSchema`：圖上沒有摘要的私有欄位。
 *
 * @param base - 其餘各層包好的摘要器。
 * @param table - 這次組裝的切點表。
 * @returns 同名、沒有 `stateSchema` 的 middleware。
 */
export function withSummaryCutoffs(
  base: AgentMiddleware,
  table: SummaryCutoffTable,
): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 摘要器一定有 wrapModelCall；沒有的話包了也沒意義，原樣回去。 */
  if (inner === undefined) return base;
  const { stateSchema: _private, ...rest } = base as AgentMiddleware & { stateSchema?: unknown };
  return {
    ...rest,
    wrapModelCall: async (request, handler) => {
      const config = {
        configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
      };
      // 基座的切點是 `request.messages` 的座標（`getEffectiveMessages(request.messages, …)`）。
      const messages = request.messages ?? [];
      const previous = table.lookup(config, messages);
      const seeded = {
        ...request,
        state: { ...(request.state as object), _summarizationEvent: previous },
      } as unknown as typeof request;
      const cell: CutoffCell = { latest: undefined };
      let reply: unknown;
      try {
        const result = await cutoffCells.run(cell, () =>
          inner(seeded, async (sent) => {
            reply = await handler(sent);
            return reply as Awaited<ReturnType<typeof handler>>;
          }),
        );
        if (!isCommand(result)) return result;
        /* v8 ignore next 2 -- 基座一定先叫過 handler 才回 Command；沒叫過就不知道要回什麼。 */
        if (reply === undefined) throw new Error('摘要器回了 Command，卻沒有交下去過任何請求。');
        return reply as typeof result;
      } finally {
        if (cell.latest !== undefined) table.record(config, messages, cell.latest);
      }
    },
  } as AgentMiddleware;
}
