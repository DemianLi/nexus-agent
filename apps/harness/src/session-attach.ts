/**
 * 把一條 thread 的會話註冊表接上三個消費者的單一口（[#668](https://github.com/DemianLi/nexus-agent/issues/668)）。
 *
 * 遙測、不變量配套入口、`sessions` 通道的參與者，三個接線口各自活在 {@link NexusAgentHandle} 上（理由見
 * `agent-factory.ts`：接線需要同時看得到註冊表與組裝）。**呼叫端不該自己挑要接哪幾個**：以前 `serve.ts`
 * 逐個轉交、`runCli` 逐個呼叫，少抄任何一個都不報錯（口是選配、呼叫用 `?.()`），也沒有測試會紅，後果卻是 web 上
 * 每條 thread 的不變量檢查整個消失，或遙測一筆都不送，CLI 照常所以本機看不出來。這個檔把「接什麼、什麼順序、
 * 怎麼收」定成一個函式，兩個入口與測試共用同一份。
 *
 * **不收進 `createNexusAgent`**：eval 走它而且刻意不接註冊表（`eval/session-absence.test.ts`）。這裡只是組合
 * 三個口的純函式，不碰註冊表，所以 eval 的決定不受影響。
 */

import type { SessionRegistry } from '@nexus/core';

import type { BackgroundParentPort, BackgroundSubagentControl } from './background-subagents.js';

/** {@link AttachSessions} 接上之後的把手。 */
export interface SessionsAttachment {
  /**
   * 背景子代理的控制面：對單一背景子代理傳話、單獨停（[#865](https://github.com/DemianLi/nexus-agent/issues/865)）。
   * 這次組裝沒有背景派出時缺席。
   */
  readonly background?: BackgroundSubagentControl;
  /** 收掉這次接線；先參與者、再不變量、最後遙測。可以不收——`dispose()` 會把還接著的協調器一起收掉。 */
  detach(): Promise<void>;
}

/**
 * 把一條 thread 的會話註冊表接上遙測、不變量與參與者。
 *
 * **接上的順序不承重。** 三個消費者接上時都會先處理註冊表裡已有的事件（`SessionRegistry.observe` 先掃既有日誌，
 * 不變量 runner 重播 `log.events`，遙測協調器建構時補送），所以參與者在安裝期寫的第一批事件，不管排在檢查前面
 * 還是後面都會被檢查看到。保證的是「參與者有接上，它寫的東西會被檢查看到」，靠的是重播，不是順序。
 *
 * @param sessions - 這條 thread 的會話註冊表。CLI 傳 `createCliAgent` 回傳的那一份；serve 傳 pump 建的那一份。
 * @param backgroundPort - 背景子代理往這條 thread 的主對話這個方向的出口：結算通知（#840）與寫來的話（#849）。
 *   **省略即沒有人被通知、子代理也寄不出去**（cli 的 REPL 一行一輪）；serve 傳 pump 的 `notifySettled` 與 `receiveAgentMessage`。
 */
export type AttachSessions = (
  sessions: SessionRegistry,
  backgroundPort?: BackgroundParentPort,
) => SessionsAttachment;

/** {@link composeAttachSessions} 要的三個口，就是 `NexusAgentHandle` 上的那三個。 */
export interface SessionAttachers {
  attachTelemetry(sessions: SessionRegistry): (() => Promise<void>) | undefined;
  attachInvariants(sessions: SessionRegistry): (() => void) | undefined;
  attachSession(
    sessions: SessionRegistry,
    backgroundPort?: BackgroundParentPort,
  ): (() => void) & { readonly background?: BackgroundSubagentControl };
}

/** 把三個口組成 {@link AttachSessions}。順序：遙測、不變量、參與者；收的時候倒過來。 */
export function composeAttachSessions(attachers: SessionAttachers): AttachSessions {
  const { attachTelemetry, attachInvariants, attachSession } = attachers;
  return (sessions, backgroundPort) => {
    const detachTelemetry = attachTelemetry(sessions);
    const detachInvariants = attachInvariants(sessions);
    const detachSession = attachSession(sessions, backgroundPort);
    return {
      background: detachSession.background,
      detach: async () => {
        // **參與者先收，比不變量還早**：它是唯一寫得動日誌的那一個，先讓它停手，檢查才還在看著它最後
        // 那幾筆。反過來收的話，關機途中寫進去的東西沒人檢。
        detachSession();
        // 不變量再退訂：它只是一個訂閱，退掉不會有東西要排空。
        detachInvariants?.();
        // 遙測最後收，理由同 `agent-factory.ts`：後端可能是某個 plugin 開的。
        await detachTelemetry?.();
      },
    };
  };
}
