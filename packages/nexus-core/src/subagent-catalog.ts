/**
 * 子代理的**父端目錄**：父會話日誌上的 `subagent/catalog`，一顆指一份子會話日誌，並指回派它的那一顆 `tool/call`
 * （[#1023](https://github.com/DemianLi/nexus-agent/issues/1023)，地圖 [#1015](https://github.com/DemianLi/nexus-agent/issues/1015)）。
 *
 * ## 照 dsh 的那一半
 *
 * dsh 的子代理連結分在兩頭（`packages/subagent/subagent/src/catalog.ts`、`descriptor.ts`，`5badb15`）：
 *
 * - **父 → 子**：父會話自己的 required 事件 `subagent/catalog { version, childId, childCreatedAt, mode, label }`，
 *   是直接子代理的持久權威（Agent Note `2026-09-01-parent-owned-subagent-catalog`）。只發布**成功的事實**：一次性的
 *   子代理在 provider 交出本地子會話之後、run 回到呼叫端之前寫；continuable 先接受第一句話、再寫目錄、最後回 id。
 * - **子 → 父**：子會話的 header `parentSession`。子日誌裡的 `subagent/descriptor` 記身分與組成，不指回呼叫。
 *
 * 這裡照抄事件名、寫在父那一份、只發布成功的事實；子 → 父照舊靠 header 的 `parentSession`。
 *
 * ## 多一格 `callId`：標準沒有這個功能，不是表達不出來
 *
 * dsh 的目錄**不指呼叫**。它的子代理工具標成可併發（`tool-subagent` 的 `isConcurrencySafe: () => true`），同一步派兩個時
 * 兩顆 catalog 的先後對不回各自的呼叫；前景 run 的結果值帶著子會話 id（`{ kind: 'foreground', runId }`），但那是工具的
 * `value`，不落盤。#1023 要從子日誌找得到派它的那一輪與那一顆 `tool/call`，所以多記 `callId`。**這不是偏離規則說的
 * 「基礎建設表達不出來」**，是標準沒有、卡上要的功能，射程只有這一格。
 *
 * ## 沒抄的三格
 *
 * - `version`：dsh 的 catalog 自帶載荷版本，因為它的折疊對每一種載荷嚴格驗；我們的詞彙版本是整份日誌一個
 *   （`SESSION_LOG_FORMAT_VERSION`），同其餘每一種事件。
 * - `childCreatedAt`：子會話的 header 在持久化那一側自己蓋 `createdAt`（`attachSessionPersistence`），寫目錄的一方
 *   拿不到同一個值；這顆事件自己的 `time` 就是子會話出生的那一刻。
 * - `label`：dsh 的 `label` 是委派的短描述；我們的 `task`／`subagent` 只有 `description`，**那是整段任務**，不是標籤，
 *   抄進來等於把任務全文複製一份到目錄。
 *
 * ## 「那一輪」從位置讀，不另記
 *
 * 我們的 `tool/call` 沒有 `turn`（見 `session-log.ts` 的 `tool/call`）。root 那份以落在哪一對 `turn/start`／`turn/end`
 * 之間定輪，所以 {@link subagentLinks} 從 catalog 那顆往回找：最近一顆同 `callId` 的 `tool/call` 與最近一顆 `turn/start`。
 * **不全檔搜 `callId`**：被核准閘門中斷的呼叫 resume 之後以同一個 `callId` 再記一顆（`session-log.ts` 的 `tool/call`），
 * 供應商的 id 也不保證全域不重複；往回找到的那一顆一定是同一輪裡最近的那一次派出。
 *
 * @module
 */

import type { SessionLog, SessionEvent } from './session-log.js';

/** 子代理的生命週期：前景跑完就結束（`one-shot`），背景的收得到後續的話（`continuable`）。同 dsh 的 `mode`。 */
export type SubagentCatalogMode = 'one-shot' | 'continuable';

/** `subagent/catalog` 的載荷。 */
export interface SubagentCatalogData {
  /** 子會話的 id（`<root>/<runId>`，見 `SessionRegistry`），就是子日誌 header 的 `id`。 */
  readonly childId: string;
  /** 派它的那一顆 `tool/call` 的 `callId`。dsh 沒有這一格，見檔頭。 */
  readonly callId: string;
  readonly mode: SubagentCatalogMode;
}

/**
 * 在父那一份記一顆 `subagent/catalog`。**記不進去不能反過來殺掉派出那一步**，同圍堵記工具事件：`append` 拋的一律吃掉，
 * 回 `false`。少一顆目錄的代價是那一份子日誌只剩 header 的 `parentSession` 指得回去，不是派出失敗。
 *
 * @param parent - 派它的那一份（今天一律是 root：子代理不再派子代理）。
 * @param data - 那一顆的載荷。
 * @returns 寫進去了沒有。
 */
export function appendSubagentCatalog(parent: SessionLog, data: SubagentCatalogData): boolean {
  try {
    parent.append('subagent/catalog', data);
    return true;
  } catch {
    return false;
  }
}

/** 一顆目錄解出來的連結。 */
export interface SubagentLink extends SubagentCatalogData {
  /** 那顆 `subagent/catalog` 在父日誌上的 `seq`。 */
  readonly catalogSeq: number;
  /** 派它的那顆 `tool/call` 的 `seq`；往回找不到（日誌被截過）就沒有。 */
  readonly callSeq?: number;
  /** 那一輪起頭那顆 `turn/start` 的 `seq`，同 `ratingsByTurn` 對「輪」的鍵；往回找不到就沒有。 */
  readonly turnSeq?: number;
}

/**
 * 父日誌上每一顆 `subagent/catalog` 解成連結，照日誌順序。**一顆都沒有就是空的**——30 以前的日誌、或沒派過子代理，
 * 讀的人照「沒記」表態（「—」），不推論成沒有子代理。
 *
 * @param events - 父那一份日誌的全部事件。
 * @returns 每一顆的連結。
 */
export function subagentLinks(events: readonly SessionEvent[]): readonly SubagentLink[] {
  const links: SubagentLink[] = [];
  for (let at = 0; at < events.length; at += 1) {
    const event = events[at]!;
    if (event.type !== 'subagent/catalog') continue;
    const data = event.data;
    let callSeq: number | undefined;
    let turnSeq: number | undefined;
    for (let back = at - 1; back >= 0 && turnSeq === undefined; back -= 1) {
      const earlier = events[back]!;
      if (
        callSeq === undefined &&
        earlier.type === 'tool/call' &&
        earlier.data.callId === data.callId
      ) {
        callSeq = earlier.seq;
      } else if (earlier.type === 'turn/start') {
        turnSeq = earlier.seq;
      }
    }
    links.push({
      childId: data.childId,
      callId: data.callId,
      mode: data.mode,
      catalogSeq: event.seq,
      ...(callSeq !== undefined && { callSeq }),
      ...(turnSeq !== undefined && { turnSeq }),
    });
  }
  return links;
}

/**
 * 從子會話這一頭找回派它的地方：拿子日誌 header 的 `parentSession` 打開父日誌，再交給這裡。
 *
 * @param parentEvents - 父那一份日誌的全部事件。
 * @param childId - 子會話的 id（它的 header `id`）。
 * @returns 那一顆連結；父日誌上沒有這個子代理的目錄（舊日誌、或派出那一刻沒記成）就是 `undefined`。
 */
export function subagentLinkOf(
  parentEvents: readonly SessionEvent[],
  childId: string,
): SubagentLink | undefined {
  return subagentLinks(parentEvents).find((link) => link.childId === childId);
}
