/**
 * 模型請求的重試記進會話日誌：`llm/retry`（排定一次重試）與 `llm/retry-started`（等完、真的要重打）。
 * 見 [#712](https://github.com/DemianLi/nexus-agent/issues/712)。
 *
 * ## 為什麼要有這一層：重試不在 core 看得到的地方
 *
 * 真模型的重試在 `AsyncCaller` → `p-retry` 裡進行，包在 {@link ./model-calls.ts} 那一對 `model/start`／`model/end`
 * **裡面**。core 看不到失敗、也看不到等待，而擁有失敗分類的 adapter（`apps/harness/src/live-model.ts`）建模型的時候
 * 手上沒有日誌。這一檔是兩邊之間的**接縫**：core 在每次模型呼叫外開一個範圍（{@link runInRetryScope}），adapter
 * 在自己知道的兩個時刻回報（{@link noteFailedAttempt}、{@link noteRequestStart}）。
 *
 * 範圍用 `AsyncLocalStorage` 帶，**所以每次呼叫各有自己的計數**：同一顆模型實例被 root 與好幾個子代理同時用，
 * 計數掛在共用的 closure 上會互相混。範圍外的回報（標題那一顆、沒有日誌的路徑）一律是空操作。
 *
 * ## 寫入時機，以及跟 dsh 的差異
 *
 * 照 dsh `llm-retry`（`packages/llm/llm-retry/src/index.ts:188-190`）：**排定時先寫 `llm/retry`，等完、重打之前再
 * 寫 `llm/retry-started`**；記「排定」不記「完成」，預算用盡的那一次不排所以不寫；兩顆都不進模型。
 *
 * 退到最接近的實作，因為 `AsyncCaller` 的接縫表達不出 dsh 的形狀（見卡 #712 動工前要查第 1 條）：
 *
 * - **沒有 `delayMs`。** `onFailedAttempt` 在 `p-retry` 算退避之前就被叫，而退避含隨機，事前不可知。
 *   `llm/retry-started` 改帶**實際等了多久**（`waitedMs`），量的是排定到下一次請求開跑的牆鐘。
 * - **沒有 `turn`／`step`／`provider`／`mode`／`policyKey`。** 我們沒有 `step/*`（見 `model-calls.ts` 檔頭），
 *   關聯鍵是 `retryId`：一次模型呼叫的所有重試共用一個，落在那一次呼叫的 `model/start`／`model/end` 之間。
 *   **哪一次呼叫**由 `modelCall` 指（#1021，那次的 `model/start` 的 `seq`），不靠落在哪一對之間。第一次嘗試本身沒有事件，
 *   「第幾次嘗試」就是 `retry + 1`。
 * - **不是耐久的計數狀態。** dsh 的 `llmRetry` 投影從這顆事件折出計數、讓行程重啟之後接著數；這裡計數只活在
 *   那一次呼叫的範圍裡。卡上交給 demian 決定的範圍題，這裡只做觀測。
 *
 * ## 取消之後不再寫
 *
 * `AsyncCaller` 收到 signal 時只讓呼叫方先拿到中止，背景的 `p-retry` 迴圈照樣等完退避、再打一次。範圍在
 * `wrapModelCall` 的 `finally` 關起來，之後那一次請求的 {@link noteRequestStart} 看到範圍已關就什麼都不寫——
 * 所以已寫下的 `llm/retry` 留著，但不會有對應的 `llm/retry-started`，`turn/end` 之後也不會多一顆。
 *
 * ## 記不進去不能扳倒模型呼叫
 *
 * 同 {@link ./model-calls.ts}：`append` 自己拋就吃掉。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentModelCall, withModelCall } from './model-call-scope.js';
import type { LlmFailure, SessionLog } from './session-log.js';

interface RetryScope {
  readonly log: SessionLog;
  /** 還沒結束的這次呼叫，到現在失敗過幾次且被排了重試。 */
  retries: number;
  /** 一次呼叫的重試共用一個，同 dsh 的 `retryId`。第一次排定時才生。 */
  retryId: string | undefined;
  /** 已排定、還沒等完的那一次：等完（下一次請求開跑）時據此寫 `llm/retry-started`。 */
  pending: { readonly retry: number; readonly scheduledAt: number } | undefined;
  closed: boolean;
}

const scopes = new AsyncLocalStorage<RetryScope>();

/**
 * 在這次模型呼叫外開一個重試範圍，呼叫結束（完成、拋錯、中止）就關。
 *
 * @param log - 這次呼叫所屬的那一份會話日誌。
 * @param call - 實際的呼叫。
 */
export function runInRetryScope<T>(log: SessionLog, call: () => T | Promise<T>): Promise<T> {
  const scope: RetryScope = {
    log,
    retries: 0,
    retryId: undefined,
    pending: undefined,
    closed: false,
  };
  return scopes.run(scope, async () => {
    try {
      return await call();
    } finally {
      scope.closed = true;
    }
  });
}

function tryAppend(scope: RetryScope, write: () => void): void {
  if (scope.closed) return;
  try {
    write();
  } catch {
    // 見檔頭「記不進去不能扳倒模型呼叫」。
  }
}

/**
 * 一次請求失敗了、而且判定**不放棄**（`onFailedAttempt` 正常返回）時回報。
 *
 * `AsyncCaller` 連最後一次失敗也叫 `onFailedAttempt`，所以這裡自己對上限：第 k 次失敗只有 `k <= maxRetries`
 * 才真的會再打，超過的是預算用盡，不寫。
 *
 * @param failure - 這次失敗的穩定描述。
 * @param maxRetries - 這顆模型的重試上限（`AsyncCaller` 的 `maxRetries`）。
 */
export function noteFailedAttempt(failure: LlmFailure, maxRetries: number): void {
  const scope = scopes.getStore();
  if (scope === undefined || scope.closed) return;
  scope.retries += 1;
  if (scope.retries > maxRetries) return;
  const retryId = (scope.retryId ??= randomUUID());
  const retry = scope.retries;
  scope.pending = { retry, scheduledAt: Date.now() };
  tryAppend(scope, () => {
    scope.log.append(
      'llm/retry',
      withModelCall({ retryId, retry, maxRetries, failure }, currentModelCall(scope.log)),
    );
  });
}

/**
 * 一次請求（含重試的那幾次）**開跑**的當下回報。第一次沒有排定中的重試，什麼都不寫；之後每一次，前一次失敗
 * 排定的重試在這一刻等完了，寫 `llm/retry-started`。
 */
export function noteRequestStart(): void {
  const scope = scopes.getStore();
  if (scope === undefined) return;
  const { pending, retryId } = scope;
  if (pending === undefined || retryId === undefined) return;
  scope.pending = undefined;
  tryAppend(scope, () => {
    scope.log.append(
      'llm/retry-started',
      withModelCall(
        {
          retryId,
          retry: pending.retry,
          waitedMs: Math.max(0, Date.now() - pending.scheduledAt),
        },
        currentModelCall(scope.log),
      ),
    );
  });
}
