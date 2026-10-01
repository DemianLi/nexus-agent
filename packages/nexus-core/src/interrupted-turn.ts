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
 * 沒配到的呼叫各一顆錯誤 `tool/result`，最後補 `turn/end {kind:'interrupted'}`（`packages/core/session/src/repair.ts:159-162`）。
 * 語意修復歸 agent 層、不歸存放層，所以這裡是一個獨立的 helper，不放進 `SessionStore.resume`。
 *
 * ## 只補**記過 `tool/call`** 的那種
 *
 * 回覆要了、還沒記到 `tool/call` 的那次，一顆 `tool/result` 在我們的配對不變量上是違規（`invariant.ts`），
 * 那條偏離（{@link ./conversation-replay.ts}）不動：它們維持在記憶體裡補。dsh 對合成的「還沒開始」結果明文放行
 * 配對檢查（`packages/core/session/src/invariant.ts:142-145`），要不要一併寫回是卡上交給 demian 的另一題。
 *
 * ## 還沒決定的三件事（卡上交給 demian，這裡**沒有替他定**）
 *
 * - **`session/end-seed` 之後才補。** dsh 的掃描遇到 end-seed 不重設（`repair.ts:107-109`），舊檔「開著的輪＋end-seed、
 *   之後沒有新輪」的尾巴會補在 end-seed 之後，撞上我們不變量在 end-seed 的重設。這一版**照現有不變量，在 end-seed
 *   重設**：那種舊檔尾巴不補（新檔不會有這個形狀，補結一律排在 end-seed 前面）。
 * - **開著的 `model/start` 不補 `model/end`。** dsh 補 `step/end`，但這一對不是 dsh 的 step。
 * - **「還沒開始」那條偏離**，見上。
 *
 * @module
 */

import { toLoggedMessage } from './logged-message.js';
import { closer } from './conversation-replay.js';
import { TOOL_OUTCOME_UNKNOWN } from './tool-events.js';
import type { SessionEvent } from './session-log.js';
import type { ResumedStoredSession, SessionStore } from './session-store.js';

/**
 * 一份已存日誌的尾巴如果停在一輪開著，算出補結：**記過 `tool/call` 沒配到結果**的各一顆錯誤 `tool/result`
 * （說結果不明，字逐字照 dsh），最後一顆 `turn/end {reason:{kind:'interrupted'}}`。
 *
 * 掃描照 dsh：`turn/start`、`turn/end` 重設（我們的 `turn/failed` 也是收工）；`session/end-seed` 在這一版也重設，
 * 見檔頭。`seq` 接在最後一顆後面、`time` 沿用最後一顆真事件的，所以補結不會捏造一個晚於崩潰的時刻。
 *
 * @param events - 讀回來的全部事件，照 `seq` 排。
 * @returns 要接在後面的補結；已平衡（沒有開著的輪）就是空陣列。
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  let open = false;
  /** 記過 `tool/call`、還沒配到結果的呼叫，照記下的順序。 */
  const pending = new Map<string, string>();
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        open = true;
        pending.clear();
        break;
      case 'turn/end':
      case 'turn/failed':
      case 'session/end-seed':
        open = false;
        pending.clear();
        break;
      case 'tool/call':
        if (open) pending.set(event.data.callId, event.data.name);
        break;
      case 'tool/result':
        pending.delete(event.data.callId);
        break;
      default:
        break;
    }
  }
  const last = events.at(-1);
  if (!open || last === undefined) return [];

  let seq = last.seq + 1;
  const closers: SessionEvent[] = [];
  for (const [callId, name] of pending) {
    const message = closer({ id: callId, name }, true);
    closers.push({
      type: 'tool/result',
      seq: seq++,
      time: last.time,
      data: {
        callId,
        isError: true,
        error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
        message: toLoggedMessage(message),
      },
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
