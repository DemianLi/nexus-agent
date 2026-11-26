/**
 * 封存的會話不跑模型步驟：準入閘門（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）。
 *
 * ## dsh 怎麼做
 *
 * `ArchivedSessionGate`（`packages/api/session-controller/src/archived-session-gate.ts`，`5badb15009a`）掛在 `agent/pre-step`：
 * 這一步的 Agent 所屬的會話、或它往上（**只沿子代理血統**，fork 是獨立的對話）有任何一條封存了，就回 `reject`。迴圈把那一輪以
 * `turn/end { reason: { kind: 'blocked' } }` 收掉、不發請求（`agent-loop/src/agent.ts:316-319`）。**每一步都問**，不只輪頭。
 *
 * ## 我們的縫
 *
 * 我們的迴圈是基座的圖，pump 在圖外。閘門經 `configurable` 的 {@link ARCHIVE_GATE_CONFIG_KEY} 交進圖裡（同 `turn-cancel.ts` 交中止訊號、
 * `step-inbox.ts` 交收件匣的做法），由 {@link ./turn-cancel.ts | createTurnCancelGuard} 的 `wrapModelCall` 在每一次模型呼叫之前問：
 * 擋下的話 **root 拋 {@link TurnBlockedError}**（pump 靠類別認它，收成 `blocked`），**子代理那一層不拋**，回中止同一種合成的空訊息
 * 讓它的圖自然收尾（理由與中止相同：從子代理往外拋會穿過 `task` 工具的邊界，見 `turn-cancel.ts` 的 `stopHere`）。
 * 子代理那邊誰是「被擋下的那一輪」由放閘門進去的人記（背景子代理的 host 在閘門回 `true` 時記一筆，輪收尾時寫 `blocked`）。
 *
 * **血統**：閘門是放它進去的人給的函式，不是圖自己去查。pump 給的是「這條 thread 封存了沒有」，背景子代理 host 給的是「它所屬的
 * root thread 封存了沒有」——子代理的血統就是同一條 thread，所以兩邊回答同一個問題，等同 dsh 沿 `parentSession` 往上找。
 *
 * @module
 */

import { MiddlewareError } from 'langchain';

/** 進入點把準入閘門放在 `configurable` 的這個鍵上。值是 {@link ArchiveGate}。 */
export const ARCHIVE_GATE_CONFIG_KEY = 'nexus_archive_gate';

/**
 * 準入閘門：這一步要不要擋。**每一次模型呼叫之前同步問一次**；回 `true` 就是擋下（這一步不發請求）。
 * 放它進去的人可以在回 `true` 的當下順手記帳（背景子代理 host 就這樣記哪一輪被擋）。
 */
export type ArchiveGate = () => boolean;

/**
 * 這一輪被準入閘門擋下了。
 *
 * **進入點要靠類別認它，不能比對訊息**，理由同 {@link ./turn-cancel.ts | TurnCancelledError}：它決定這一輪收成 `turn/end`（帶 `blocked`）
 * 還是 `turn/failed`。
 */
export class TurnBlockedError extends Error {
  override readonly name = 'TurnBlockedError';

  constructor() {
    super('這一輪被準入閘門擋下了（會話已封存）');
  }
}

/**
 * 這是一次被擋下嗎——**沿 `MiddlewareError` 的 `cause` 拆到底再認類別**，拆法同 `isTurnCancelled`。
 *
 * @param error - `catch` 到的東西。
 * @returns 拆到底是 {@link TurnBlockedError} 就是 `true`。
 */
export function isTurnBlocked(error: unknown): boolean {
  let root = error;
  while (MiddlewareError.isInstance(root)) root = root.cause;
  return root instanceof TurnBlockedError;
}

/**
 * 從一份 config 讀準入閘門。
 *
 * @param config - 有 `configurable` 的東西。
 * @returns 閘門；這一輪沒有人放就是 `undefined`——CLI 與 eval 走的就是這條（沒有封存這回事）。
 */
export function archiveGateOf(config: unknown): ArchiveGate | undefined {
  const configurable = (config as { configurable?: Record<string, unknown> } | null | undefined)
    ?.configurable;
  const value = configurable?.[ARCHIVE_GATE_CONFIG_KEY];
  return typeof value === 'function' ? (value as ArchiveGate) : undefined;
}
