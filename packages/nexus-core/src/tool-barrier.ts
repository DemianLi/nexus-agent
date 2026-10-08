/**
 * 同一步多顆工具呼叫的**獨佔屏障**（[#711](https://github.com/DemianLi/nexus-agent/issues/711) 第 2 步）：
 * 沒宣告「可以重疊」的工具呼叫單獨跑，同時也是順序屏障——前面的跑完它才開始，它跑完後面的才開始。
 *
 * ## 照 dsh 的哪一段
 *
 * dsh 的 agent-loop 每顆呼叫先分類（`packages/core/agent-loop/src/tool-calls.ts:89-90`）：沒宣告 `isConcurrencySafe`
 * 就是 exclusive（fail-closed，`packages/core/tools/src/index.ts:1305-1308`，回傳剛好是 `true` 才算 parallel）；
 * exclusive 單獨跑，也是順序屏障——pool 碰到非 parallel 就停止往下開（`tool-calls.ts:204-205`）。出廠只有 8 處宣告 parallel
 * （讀檔、讀圖、web 搜尋與抓取、session-query 三顆、subagent），其餘包含 `grep`、`glob`、`write`、`edit`、`bash`、外掛工具都是 exclusive。
 * 我們對應的 parallel 是 `read_file` 與子代理委派（{@link DEFAULT_PARALLEL_SAFE_TOOLS}）；`ls` dsh 沒有對應工具，維持 exclusive。
 *
 * ## 規則
 *
 * 同一步的呼叫依模型給的順序編號。呼叫 `i` 要等前面的 `j`（`j < i`）**落定**，當 `i` 或 `j` 至少一個是 exclusive；
 * 兩個都是 parallel 就不等，照 {@link https://github.com/DemianLi/nexus-agent/issues/936 | 第 1 步} 的上限重疊。
 *
 * ## 載體與偏離（登記）
 *
 * - **宣告的載體是工具的 `metadata.concurrencySafe === true`**（{@link CONCURRENCY_SAFE_METADATA_KEY}），plugin 自己的工具在
 *   註冊時帶；基座的工具（`read_file`、`task`）我們改不到 metadata，退到一張名字表（{@link DEFAULT_PARALLEL_SAFE_TOOLS}）。
 * - **屏障用 `wrapToolCall` 表達，排在圍堵外面一格**——這是本檔最重要的位置約束：等待的呼叫在通過屏障之前**什麼都不做**，
 *   不能先被圍堵記一顆 `tool/call`（resume 重跑會記第二顆）。它自己只會拋一種東西——不帶酬載的 `GraphInterrupt`，是控制流，
 *   不需要圍堵接。圍堵「必須是第 0 格」那條約束管的是工具失敗不能殺掉整場 run，屏障沒有失敗路徑。
 * - **核准中斷是偏離 dsh 的新設計**（PM 2026-10-08 在 #711 拍板的第 3 條）：dsh 的核准在 `prepare` 裡、照模型順序逐顆 await；我們的核准是
 *   工具呼叫裡的 `interrupt()`，LangGraph 的語意是那一顆拋出之後整個 superstep 等其他 task 收完才交出中斷。屏障上等待的呼叫若
 *   一直等前面那顆 exclusive「跑完」，superstep 收不完、中斷交不出去，死鎖；若等它「結束（含中斷）」就往下跑，順序被打破。
 *   所以前面那顆**中斷**時，等它的呼叫**一起退出**——拋一顆空的 `GraphInterrupt`。實測（`apps/harness/src/tool-barrier.test.ts`）：它沒有寫 `INTERRUPT`
 *   也沒有任何寫入，resume 時被當成沒跑過的 task 重跑；沒有卡、不要求回答、不再次中斷、`tool/call` 只記真的開跑那一次。
 *   dsh 沒有對應物，因為它的核准不在圖裡。
 *
 * ## 狀態與生命期
 *
 * 一個 agent 一份（{@link createToolBarrierMiddleware} 回的實例各自帶一張表）。一步一筆紀錄，鑰匙是那則 AI 訊息的 id（沒有 id 就用
 * 呼叫 id 串起來）：呼叫都落定就刪。**中斷後的紀錄要留到 resume**：已經跑完的呼叫在 resume 時不會重跑（它們的寫入已進存檔點），
 * 等它們的呼叫得靠紀錄知道「它早就完成了」。一個 attempt 結束（沒有呼叫還在等或在跑）時，中斷的位置重置成待命，等下一個 attempt。
 * 行程重啟會丟掉紀錄，但存檔點也在記憶體裡，兩者同生共死。
 *
 * @module
 */

import { isGraphBubbleUp, GraphInterrupt } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { turnCancelSignalOf } from './turn-cancel.js';

/** 工具 `metadata` 上宣告「同一步可以跟別顆重疊」的鍵。只有剛好是 `true` 才算（fail-closed，同 dsh）。 */
export const CONCURRENCY_SAFE_METADATA_KEY = 'concurrencySafe';

/**
 * 基座工具改不到 metadata，用名字宣告可以重疊的那幾顆：`read_file`（dsh 的 read）與子代理委派（dsh 的 subagent 對應我們的
 * `task`，以及選配的 `subagent`）。**其餘一律獨佔**，包含 `grep`、`glob`、`ls`、`write_file`、`edit_file`、`execute`。
 */
export const DEFAULT_PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'task',
  'subagent',
]);

/** {@link createToolBarrierMiddleware} 的名字，診斷與索引用。 */
export const TOOL_BARRIER_MIDDLEWARE_NAME = 'nexusToolBarrier';

/** 工具能不能跟別顆重疊。 */
export function isConcurrencySafe(
  tool: { readonly name?: string; readonly metadata?: unknown } | undefined,
  name: string,
  safeNames: ReadonlySet<string> = DEFAULT_PARALLEL_SAFE_TOOLS,
): boolean {
  const declared = (tool?.metadata as Record<string, unknown> | undefined)?.[
    CONCURRENCY_SAFE_METADATA_KEY
  ];
  return declared === true || safeNames.has(name);
}

type Outcome = 'complete' | 'interrupted';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 一步裡的一個位置。 */
interface Slot {
  /** `pending`：這個 attempt 還沒進來；`running`；`complete`：跑完（跨 attempt 保留）；`interrupted`：這個 attempt 退出了。 */
  status: 'pending' | 'running' | 'complete' | 'interrupted';
  /** 進來之後才知道是不是 parallel。 */
  safe: boolean | undefined;
  entered: Deferred<void>;
  settled: Deferred<Outcome>;
}

interface StepRecord {
  readonly ids: readonly string[];
  readonly slots: Slot[];
}

function freshSlot(): Slot {
  return { status: 'pending', safe: undefined, entered: deferred(), settled: deferred() };
}

/** 保留的步數上限：被放棄的步（中斷之後沒人 resume）不會無限累積。 */
const MAX_RECORDS = 256;

interface ToolBarrierRequest {
  readonly toolCall: { readonly id?: string; readonly name: string };
  readonly tool?: { readonly name?: string; readonly metadata?: unknown } | undefined;
  readonly state?: unknown;
  readonly runtime?: { readonly configurable?: unknown };
}

/** 找出這顆呼叫屬於的那則 AI 訊息：倒著找帶這個呼叫 id 的。 */
function owningMessage(
  request: ToolBarrierRequest,
): { readonly key: string; readonly ids: string[] } | undefined {
  const callId = request.toolCall.id;
  if (callId === undefined || callId === '') return undefined;
  const messages = (request.state as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as
      { id?: string; tool_calls?: readonly { id?: string }[] } | undefined;
    const calls = message?.tool_calls ?? [];
    if (!calls.some((call) => call.id === callId)) continue;
    const ids = calls.map((call) => call.id ?? '');
    return { key: message?.id ?? ids.join('|'), ids };
  }
  return undefined;
}

/**
 * 造屏障 middleware。**一個 agent 一份**：紀錄在閉包裡。
 *
 * @param safeNames - 用名字宣告可以重疊的工具；省略即 {@link DEFAULT_PARALLEL_SAFE_TOOLS}。
 * @returns 可以放進 middleware 陣列、排在圍堵外面的實例。
 */
export function createToolBarrierMiddleware(
  safeNames: ReadonlySet<string> = DEFAULT_PARALLEL_SAFE_TOOLS,
): AgentMiddleware {
  const steps = new Map<string, StepRecord>();

  const recordOf = (key: string, ids: readonly string[]): StepRecord => {
    let record = steps.get(key);
    if (record === undefined) {
      record = { ids, slots: ids.map(freshSlot) };
      steps.set(key, record);
      if (steps.size > MAX_RECORDS) {
        const oldest = steps.keys().next().value;
        if (oldest !== undefined) steps.delete(oldest);
      }
    }
    return record;
  };

  /** 一個 attempt 結束：沒有位置還在等或在跑，把退出的重置成待命；全跑完就刪紀錄。 */
  const afterExit = (key: string, record: StepRecord): void => {
    if (record.slots.every((slot) => slot.status === 'complete')) {
      steps.delete(key);
      return;
    }
    if (record.slots.some((slot) => slot.status === 'pending' || slot.status === 'running')) return;
    record.slots.forEach((slot, at) => {
      if (slot.status === 'interrupted') record.slots[at] = freshSlot();
    });
  };

  return createMiddleware({
    name: TOOL_BARRIER_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      const owner = owningMessage(request as unknown as ToolBarrierRequest);
      // 一步只有一顆，或認不出屬於哪一步：沒有屏障可言，原樣放行。
      if (owner === undefined || owner.ids.length < 2) return handler(request);
      const at = owner.ids.indexOf(request.toolCall.id ?? '');
      if (at < 0) return handler(request);

      const record = recordOf(owner.key, owner.ids);
      const slot = record.slots[at] as Slot;
      // 這個位置在之前的 attempt 已經跑完（resume 不會重跑它，來到這裡只可能是同一個 id 的再次呼叫）：不設屏障。
      if (slot.status === 'complete') return handler(request);

      const safe = isConcurrencySafe(
        (request as unknown as ToolBarrierRequest).tool,
        request.toolCall.name,
        safeNames,
      );
      slot.status = 'running';
      slot.safe = safe;
      slot.entered.resolve();

      const signal = turnCancelSignalOf({
        configurable: (request as unknown as ToolBarrierRequest).runtime?.configurable,
      });
      const settle = (outcome: Outcome): void => {
        slot.status = outcome;
        slot.settled.resolve(outcome);
        afterExit(owner.key, record);
      };

      try {
        for (let before = 0; before < at; before += 1) {
          const earlier = record.slots[before] as Slot;
          if (earlier.status === 'complete') continue;
          await raceAbort(earlier.entered.promise, signal);
          // 兩顆都是 parallel：不用等。
          if (safe && earlier.safe === true) continue;
          const outcome = await raceAbort(earlier.settled.promise, signal);
          if (outcome === 'interrupted') {
            // 前面那顆中斷了：一起退出，不留任何寫入，resume 時重跑（見檔頭）。
            settle('interrupted');
            throw new GraphInterrupt([]);
          }
        }
      } catch (error) {
        if (isGraphBubbleUp(error)) throw error;
        // 其他例外（只有中止會走到）：放行，讓內層照它自己的規則處理中止。
      }

      try {
        const result = await handler(request);
        settle('complete');
        return result;
      } catch (error) {
        settle(isGraphBubbleUp(error) ? 'interrupted' : 'complete');
        throw error;
      }
    },
  }) as unknown as AgentMiddleware;
}

/** 等一個 promise，但中止訊號舉起來就放棄等（拋出去，由呼叫端放行）。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
