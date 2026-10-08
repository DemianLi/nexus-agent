/**
 * 續接時把「當掉那一輪」的收尾**寫回日誌**（[#721](https://github.com/DemianLi/nexus-agent/issues/721)）。
 *
 * ## 缺的是什麼
 *
 * 行程在一輪中間死掉，日誌停在一輪開著：有 `turn/start`，可能有 `tool/call` 沒 `tool/result`，沒有 `turn/end`。
 * 以前續接只補一顆 `session/end-seed`，檔上那一輪永遠開著；模型那一側靠 {@link ./conversation-replay.ts} 在記憶體裡
 * 補結果，每次續接重算。每個讀方還得自己認得「end-seed 前那一輪死了」，漏認的就當它還在跑；web 歷史也分不出
 * 「當掉收的」與「正常完成」。
 *
 * ## 照 dsh：續接時算補結、寫回、再當 seed
 *
 * dsh 在續接時拿到寫所有權、冷讀，`interruptedTurnClosers(persisted)` 算補結，`handle.append(closers)` 寫回，
 * 再以 `persisted + closers` 當 seed（`packages/core/agent-loop/src/index.ts:848-863`，`477b4f4`）。補結是最後那一輪
 * 沒配到的呼叫各一顆錯誤 `tool/result`，有開著的步補 `step/end`，最後補 `turn/end {kind:'interrupted'}`
 * （`packages/core/session/src/repair.ts:159-162`）。語意修復歸 agent 層、不歸存放層，所以這裡是一個獨立的 helper，
 * 不放進 `SessionStore.resume`。
 *
 * ## 補哪些（卡上三題 PM 2026-10-08 拍板，一律照 dsh）
 *
 * - **沒配到結果的呼叫都補**：記過 `tool/call` 的說結果不明，回覆裡要了、還沒記到 `tool/call` 的說還沒開始
 *   （dsh 的 `ToolCallRecovery`：呼叫由回覆登記，`tool/call` 只標「開始了」）。不變量對合成的「還沒開始」結果明文放行
 *   （dsh `packages/core/session/src/invariant.ts:142-145`，我們的 `invariant.ts` 同）。
 * - **開著的 `model/start` 補 `model/end`**，對應 dsh 補 `step/end`。這一對不是 dsh 的 step（`session-log.ts` 的 `model/start`），
 *   但「每一個進入的呼叫恰好一顆結尾」同一條規則（`model/end` 的檔頭）。`outcome` 用 `'error'`（#1022 的詞彙裡表示失敗的那一格；
 *   行程死了不是使用者按的停止，所以不是 `'aborted'`），`modelCall` 指回那顆 `model/start`。
 * - **掃描遇到 `session/end-seed` 不重設**（dsh `repair.ts:107-109`）。dsh 的日誌**會**有「開著的輪後面接 end-seed」
 *   （fork seed 先接 end-seed、再接補結，`fork.ts:21-29`），不變量對 end-seed 不設限（`invariant.ts:155-156`）。我們的舊檔
 *   「開著的輪＋end-seed、之後沒有新輪」（#934 之前續接過、又沒有新輪就停了）因此會補，補結接在 end-seed **後面**；
 *   新檔的補結一律在 end-seed 前面（續接當下先補、再接 seed）。舊檔「開著的輪＋end-seed＋新 `turn/start` …」的新一輪
 *   自己收了尾，掃描由那顆 `turn/start` 重設，所以不補。「只掃最後一顆 end-seed 之後」那條沒有採：理由是舊檔的形狀，
 *   不是基礎建設表達不出來。
 *
 * @module
 */

import { fromLoggedMessage, toLoggedMessage } from './logged-message.js';
import { closer, requestedCalls } from './conversation-replay.js';
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from './tool-events.js';
import type { SessionEvent } from './session-log.js';
import type { ResumedStoredSession, SessionStore } from './session-store.js';

/**
 * 一份已存日誌的尾巴如果停在一輪開著，算出補結：**沒配到結果的呼叫**各一顆錯誤 `tool/result`（記過 `tool/call` 的說
 * 結果不明，還沒記到的說還沒開始，字逐字照 dsh）、**開著的 `model/start`** 各一顆 `model/end {outcome:'error'}`，最後一顆
 * `turn/end {reason:{kind:'interrupted'}}`。順序照 dsh：結果、步的收尾、輪的收尾。
 *
 * 掃描照 dsh：`turn/start`、`turn/end` 重設（我們的 `turn/failed` 也是收工）；**`session/end-seed` 不重設**，見檔頭。
 * `seq` 接在最後一顆後面、`time` 沿用最後一顆真事件的，所以補結不會捏造一個晚於崩潰的時刻。
 *
 * @param events - 讀回來的全部事件，照 `seq` 排。
 * @returns 要接在後面的補結；已平衡（沒有開著的輪）就是空陣列。
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  let open = false;
  /** 這一輪的回覆要過、還沒配到結果的呼叫，照要的順序（dsh 的 `ToolCallRecovery.pendingCalls`）。 */
  const unanswered = new Map<string, string>();
  /** 其中記過 `tool/call` 的：決定補哪一句。 */
  const started = new Set<string>();
  /** 還開著的 `model/start` 的 `seq`，照開的順序。 */
  const openModelStarts: number[] = [];
  const reset = (): void => {
    unanswered.clear();
    started.clear();
    openModelStarts.length = 0;
  };
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        open = true;
        reset();
        break;
      case 'turn/end':
      case 'turn/failed':
        open = false;
        reset();
        break;
      case 'model/start':
        if (open) {
          // 新一次模型呼叫開始，代表上一批已經結清（或被基座在記憶體裡補掉了）：同 dsh 的 `step/end` 清掉待結的呼叫。
          unanswered.clear();
          started.clear();
          openModelStarts.push(event.seq);
        }
        break;
      case 'model/end': {
        if (!open) break;
        const at =
          event.data.modelCall === undefined
            ? openModelStarts.length - 1
            : openModelStarts.indexOf(event.data.modelCall);
        if (at >= 0) openModelStarts.splice(at, 1);
        break;
      }
      case 'assistant/message':
        if (open) {
          for (const call of requestedCalls(fromLoggedMessage(event.data.message))) {
            unanswered.set(call.id, call.name);
          }
        }
        break;
      case 'tool/call':
        if (open) {
          started.add(event.data.callId);
          // 舊格式沒有 `assistant/message`：只看得到 `tool/call` 的呼叫也要補。
          if (!unanswered.has(event.data.callId))
            unanswered.set(event.data.callId, event.data.name);
        }
        break;
      case 'tool/result':
        unanswered.delete(event.data.callId);
        started.delete(event.data.callId);
        break;
      default:
        break;
    }
  }
  const last = events.at(-1);
  if (!open || last === undefined) return [];

  let seq = last.seq + 1;
  const closers: SessionEvent[] = [];
  for (const [callId, name] of unanswered) {
    const wasStarted = started.has(callId);
    closers.push({
      type: 'tool/result',
      seq: seq++,
      time: last.time,
      data: {
        callId,
        isError: true,
        error: wasStarted
          ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
          : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
        message: toLoggedMessage(closer({ id: callId, name }, wasStarted)),
      },
    });
  }
  for (const modelCall of openModelStarts) {
    closers.push({
      type: 'model/end',
      seq: seq++,
      time: last.time,
      data: { modelCall, outcome: 'error' },
    });
  }
  closers.push({
    type: 'turn/end',
    seq: seq++,
    time: last.time,
    data: { reason: { kind: 'interrupted' } },
  });
  return closers;
}

/**
 * {@link SessionStore.resume}，加上把當掉那一輪的收尾寫回檔上：讀回來之後算補結、`append` 進同一個把手，
 * 交回去的 `events` 已經包含補結——呼叫端拿它當 seed、`storedCount` 取它的長度，就不會再把補結寫第二次。
 *
 * **冪等**：補結寫下之後那一輪是收掉的，同一份檔再續接一次算不出補結。寫回失敗就放掉把手再拋，不留租約。
 *
 * @param store - 存放處。
 * @param id - 要續接的會話 id。
 * @returns 同 {@link SessionStore.resume}，`events` 多了補結。
 * @throws `store.resume` 拋的，或補結寫不進去。
 */
export async function resumeClosingInterruptedTurn(
  store: SessionStore,
  id: string,
): Promise<ResumedStoredSession> {
  const resumed = await store.resume(id);
  const closers = interruptedTurnClosers(resumed.events);
  if (closers.length === 0) return resumed;
  try {
    await resumed.stored.append(closers);
  } catch (error: unknown) {
    await resumed.stored.close().catch(() => undefined);
    throw error;
  }
  return { ...resumed, events: [...resumed.events, ...closers] };
}
