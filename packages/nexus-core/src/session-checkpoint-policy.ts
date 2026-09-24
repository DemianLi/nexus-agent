/**
 * 一輪之中的**耐久檢查點**：模型請求之前、頂層工具動手之前，先把這次呼叫所屬的那一份
 * 會話日誌排空到耐久（[#599](https://github.com/DemianLi/nexus-agent/issues/599)）。
 *
 * ## 照 dsh
 *
 * `@deepseek-ai/dsh-session-checkpoint-policy`（`packages/session/session-checkpoint-policy/src/index.ts`，
 * `477b4f4`），掛在 base bundle 上——cli、web-app、headless、sdk-app、acp-app 都疊在 base 上，
 * 所以都有；只有自成一棵的 `sdk-minimal` 沒有。三個點：
 *
 * 1. **`llm/stream`**：模型請求建起來之前，把記好的請求前綴排空。root 與子代理都是。
 * 2. **`tools/execute`**：只管頂層（`exec.parent === undefined`）的呼叫，排空之後若這一輪已經
 *    中止，就回「還沒動手就被中止」，不叫工具本體。
 * 3. **`agent/pre-step`**：每一步之前，把上一步的回覆與工具結果排空。
 *
 * 排空被拒時**下游不動手**（fail-closed）：模型不被叫、工具本體不跑。錯誤照常往外拋——模型那一側
 * 讓這一輪失敗；工具那一側被最外層的圍堵收成一則錯誤結果交給模型（{@link ./containment.ts}）。
 *
 * ## 為什麼要有它
 *
 * 持久化的寫回窗口（{@link ./session-persistence.ts}，10ms）只限制「有意的批次等待」，不限制
 * 事件迴圈排不排得到它。實測（#599）：腳本模型一整輪都是 microtask，窗口到一輪結束都沒觸發過；
 * 行程第一條 thread 還有約 240ms 的同步工作。所以畫面回到就緒的那一刻，**整輪還只在記憶體
 * 裡**，這時一個強制結束（收尾中的第二次 Ctrl-C、`kill -9`、當機）會讓整輪連檔案都不見。
 * 有了它，使用者那句話與之前每一步都在模型被叫之前落地，強制結束最多丟最後一步的尾巴——
 * 同 dsh（它也沒有「一輪結束、回報閒置之前」那一點）。
 *
 * ## 偏離
 *
 * 1. **三個點併成兩個掛點。** dsh 的 `llm/stream` 與 `agent/pre-step` 在我們這裡是同一個時刻：
 *    一步就是一次模型呼叫，`wrapModelCall` 在它之前。所以一顆 `wrapModelCall` 兩件都做——排空的
 *    是這一步之前所有已記的事件，包含 {@link ./model-calls.ts | 起訖紀錄器} 剛寫的 `model/start`
 *    （它排在這一顆外層）。
 * 2. **摘要那次呼叫之前不排空。** dsh 的摘要走 `llm/stream`，所以也會先排空；我們的摘要器在
 *    自己的 `wrapModelCall` 裡直接 `request.model.invoke`（{@link ./summarization.ts}），不經過
 *    這一顆。緊接著的那次主呼叫仍會先排空，摘要寫下的事件在那時一起落地。
 * 3. **「頂層」由日誌位址判斷**：子代理裡的工具呼叫位址是 `subagent`，同
 *    `@nexus/plugin-workspace-changes` 認 root 的做法。`task` 這顆工具本身是 root 的呼叫，所以
 *    派子代理之前會排空。
 * 4. **載體是 `@nexus/core` 的子路徑**，不是獨立套件；建構與排位由 fold 決定，這個條目只負責
 *    「在場、可以被 disabled」，同 {@link ./model-usage.ts | modelUsagePlugin}。
 *
 * ## 副作用：工具卡多半收到兩顆 `tool-finished`
 *
 * 工具那一側多一層 `async` 包在本體外面，本體回來之後，圍堵記 `tool/result` 會晚幾個 microtask；
 * 而基座那顆 `tool-finished` 是在本體裡發的。所以 `apps/harness` 的 pump 多半先轉發基座那顆、
 * 日誌判定後到，於是補發一顆同 id 的更正（`thread-pump.ts` 的 `#noteVerdict`，#296）。兩種先後
 * pump 本來就都處理，卡的終態不變；變的是線上多一顆 frame、卡上的文字晚一拍。實測（#599，腳本
 * 模型一輪兩次 echo）：關掉這一顆時兩次呼叫分別走「pump 自己收卡」與「判定先到」，開著時兩次都
 * 走「補發更正」。
 *
 * ## 代價
 *
 * 每次模型呼叫與每次頂層工具呼叫多一次排空，而我們的排空帶一次 `datasync`
 * （{@link ./session-persistence.ts | SessionPersistenceCoordinator.flush}）。dsh 那側每一批
 * append 都 fsync，量級相同。沒接持久化時（沒開 `--session-log`、測試的組裝）排空者一位都沒有，
 * 立刻 resolve。
 *
 * @module
 */

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import type { NexusPlugin } from './plugin.js';
import type { SessionLookup } from './registry.js';
import type { SessionLog } from './session-log.js';
import { abortedBeforeDispatch, toolCallAborted } from './turn-cancel.js';

/** middleware 的名字。不撞基座任何一個。 */
export const SESSION_CHECKPOINT_MIDDLEWARE_NAME = 'nexusSessionCheckpoint';

/**
 * 這個條目的 plugin 名，照 dsh 的 plugin 名。
 *
 * **承重的常數**：{@link ./fold.ts | foldRegistry} 拿它去問
 * {@link ./registry.ts | DisabledEntryView}，同 {@link ./model-usage.ts | MODEL_USAGE_PLUGIN_NAME}。
 */
export const SESSION_CHECKPOINT_PLUGIN_NAME = 'session-checkpoint-policy';

/** 檢查點要的兩件事：問「這次呼叫屬於哪一份」，與把那一份排空。就是註冊表的 `sessions` 通道。 */
export interface CheckpointSessions {
  forCall(config: unknown): SessionLookup;
  flush(log: SessionLog): Promise<void>;
}

/** 從 middleware 拿到的 request 上讀 `configurable`，包一層給 `forCall`（同 `model-usage.ts`）。 */
function callConfigOf(request: unknown): { configurable: unknown } {
  return {
    configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
  };
}

/**
 * 建那顆 middleware。**無狀態，一份實例走遍 root 與每個子代理**：日誌每次從執行期的
 * `configurable` 現算，同 {@link ./model-calls.ts | createModelCallRecorder}。
 *
 * 找不到日誌（`forCall` 不是 `ok`）就不排空、照常放行：那次呼叫本來就沒有日誌可以寫，
 * 同其他掛在 `forCall` 上的 middleware。
 *
 * @param sessions - 註冊表的 `sessions` 通道。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createSessionCheckpointMiddleware(sessions: CheckpointSessions): AgentMiddleware {
  return createMiddleware({
    name: SESSION_CHECKPOINT_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const found = sessions.forCall(callConfigOf(request));
      if (found.kind === 'ok') await sessions.flush(found.log);
      return handler(request);
    },
    wrapToolCall: async (request, handler) => {
      const found = sessions.forCall(callConfigOf(request));
      if (found.kind !== 'ok' || found.address.kind !== 'root') return handler(request);
      await sessions.flush(found.log);
      // 排空要時間，那段時間裡使用者可能按了停止：dsh 在這裡再問一次，中止了就不叫工具本體。
      // 外層的 guard 只在動手前與動手後問，擋不到這一段。
      if (toolCallAborted(request)) return abortedBeforeDispatch(request);
      return handler(request);
    },
  }) as unknown as AgentMiddleware;
}

/**
 * 耐久檢查點的**設定條目**。
 *
 * **一顆服務都不註冊，`apply` 是空的**，形狀同 {@link ./model-usage.ts | modelUsagePlugin}：
 * 沒有設定，而且組裝點也沒有旗標，所以只有兩態——條目被明著關掉、或照預設掛著。這一列
 * 因此**不可以帶 `config`**（`parseEntryConfig` 對「沒有 schema 卻給了 config」當場拋）。
 *
 * **關掉它之後**：日誌只在寫回窗口到期與收尾時落地。正常收尾一樣完整，但收尾被打斷時，
 * 丟的可能是整輪（見檔頭「為什麼要有它」）。沒有任何測試會因此紅——那正是要寫下來的理由。
 */
export const sessionCheckpointPlugin: NexusPlugin = {
  name: SESSION_CHECKPOINT_PLUGIN_NAME,
  apply() {
    // 空的，而且是承重的空：這一顆唯一的作用是「在場、可以被 disabled」。
  },
};

export default sessionCheckpointPlugin;
