/**
 * 背景子代理的**冷復活存放處**（[#1271](https://github.com/DemianLi/nexus-agent/issues/1271)，缺口源自
 * [#737](https://github.com/DemianLi/nexus-agent/issues/737)）。
 *
 * ## 照 dsh 的形狀
 *
 * dsh 的 continuable 子代理是 durable session 加至多一個行程內的 activation：重啟之後 activation 沒了，session 還在磁碟上；
 * 收到 send／queue／steer 才把冷的接回來，**列出子代理不復活任何一個**（讀父會話自己的目錄 `subagent/catalog`），
 * 對冷的子代理 interrupt 是 no-op，名額（`ActivationPool.reserve`）在重建**之前**佔，滿了回 `ACTIVATION_LIMIT_REACHED`。
 * 身分與組成記在子代理**自己的日誌**（`subagent/descriptor`，見 `@nexus/core` 的 `subagent-descriptor.ts`），父端授權靠 header 的
 * `parentSession`。這個檔案是這三樣在我們這一側的「怎麼讀、怎麼接」：
 *
 * - {@link ColdChildStore.inspect}：唯讀冷讀（`open(id, 'read')`，不拿租約、不動檔），折出身分，回能不能復活。
 * - {@link ColdChildStore.resume}：拿寫租約、補當掉那一輪的收尾（同 root 的續接）、交出事件與續寫把手。
 * - {@link ColdChildStore.restore}：從事件把對話灌回圖的 state（`restoreConversation`）。
 *
 * ## 偏離登記
 *
 * 圖的 state 靠**日誌重播**灌回，不是還原存檔點（我們的存檔點不落盤，#1106 起 `PrunedMemorySaver` 只活在記憶體）。這跟 root 的續接
 * 是同一個既有偏離（#306），不是這一張新增的；基礎建設上落盤存檔點是表達得出來的，這裡沿用 root 已登記的退路，不另開一條。
 *
 * @module
 */

import { foldSubagentDescriptor, resumeClosingInterruptedTurn } from '@nexus/core';
import type {
  ConversationReplay,
  ResumedStoredSession,
  SessionEvent,
  SessionStore,
} from '@nexus/core';
import { SessionNotFoundError } from '@nexus/core';

import type { BackgroundAgent, ModelChoice } from './background-subagents.js';
import { restoreConversation } from './conversation-restore.js';

/** {@link ColdChildStore.inspect} 的結果。 */
export type ColdInspection =
  | {
      readonly kind: 'resumable';
      /** 子代理的種類名（規格名）。 */
      readonly subagent: string;
      /** 派出時指定的模型與推理等級；省略＝沿用主對話的。 */
      readonly choice?: ModelChoice;
    }
  | {
      readonly kind: 'unresumable';
      /** 給人看的原因（舊版寫的日誌、檔不在、讀不懂……），原樣進錯誤訊息。 */
      readonly reason: string;
    };

/** {@link ColdChildStore.resume} 交出來的：續接的結果，加上**接回來的那份事件**折出的身分（比冷讀那一刻新，以它為準）。 */
export interface ColdResumed extends ResumedStoredSession {
  readonly inspection: ColdInspection;
}

/** 冷的背景子代理從哪裡讀、怎麼接回來。host 只認這個介面，不認 `SessionStore`。 */
export interface ColdChildStore {
  /**
   * 唯讀冷讀一份子日誌，折出身分。**不拋**：讀不了的一律回 `unresumable` 加原因，由 host 決定怎麼講。
   *
   * @param childId - 子會話 id（`<root>/<runId>`）。
   * @param parentId - 派它的主對話（root）的會話 id；header 的 `parentSession` 必須是它。
   */
  inspect(childId: string, parentId: string): Promise<ColdInspection>;
  /**
   * 拿寫租約、補收尾、交出事件與續寫把手。**交出去的把手歸接上它的持久化協調器收**（`SessionRegistry.open` 的 `resume`）。
   *
   * @throws 租約被別的行程握著、日誌壞了或比這一版新、header 的 `parentSession` 對不上。拋之前已放掉租約。
   */
  resume(childId: string, parentId: string): Promise<ColdResumed>;
  /** 從事件把對話灌回圖的 state。灌不進去要拋（同 root：寧可這個子代理叫不醒，也不讓它在對話被丟掉的情況下默默繼續）。 */
  restore(
    agent: BackgroundAgent,
    threadId: string,
    events: readonly SessionEvent[],
  ): Promise<ConversationReplay>;
}

/** 一份子日誌的事件折成「叫不叫得醒」。 */
export function inspectionOf(events: readonly SessionEvent[]): ColdInspection {
  const folded = foldSubagentDescriptor(events);
  switch (folded.kind) {
    case 'absent':
      return {
        kind: 'unresumable',
        reason: '日誌上沒有 subagent/descriptor（格式 44 以前派出的，分不出它是哪一種子代理）',
      };
    case 'unsupported-version':
      return {
        kind: 'unresumable',
        reason: `subagent/descriptor 的版本是 ${String(folded.version)}，這一版認不得`,
      };
    case 'malformed':
      return { kind: 'unresumable', reason: `subagent/descriptor 壞了：${folded.message}` };
    case 'ok': {
      const { subagent, model, effort } = folded.descriptor;
      return {
        kind: 'resumable',
        subagent,
        ...(model !== undefined && { choice: { model, ...(effort !== undefined && { effort }) } }),
      };
    }
  }
}

/**
 * 以會話存放處建冷復活存放處。
 *
 * @param store - 這個專案的會話根（serve 的那一個）。
 */
export function createColdChildStore(store: SessionStore): ColdChildStore {
  return {
    async inspect(childId, parentId) {
      let events: readonly SessionEvent[];
      try {
        const stored = await store.open(childId, 'read');
        if (stored.header.parentSession !== parentId) {
          return {
            kind: 'unresumable',
            reason: `日誌 header 的 parentSession 是 ${JSON.stringify(stored.header.parentSession)}，不是這個主對話`,
          };
        }
        events = await stored.read();
      } catch (error: unknown) {
        if (error instanceof SessionNotFoundError) {
          return { kind: 'unresumable', reason: '日誌檔不在了' };
        }
        return {
          kind: 'unresumable',
          reason: `日誌讀不了：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return inspectionOf(events);
    },
    async resume(childId, parentId) {
      const resumed = await resumeClosingInterruptedTurn(store, childId);
      if (resumed.header.parentSession !== parentId) {
        await resumed.stored.close().catch(() => undefined);
        throw new Error(
          `會話 "${childId}" 的 header parentSession 是 ${JSON.stringify(resumed.header.parentSession)}，不是 "${parentId}" 派出的`,
        );
      }
      return { ...resumed, inspection: inspectionOf(resumed.events) };
    },
    restore: (agent, threadId, events) => {
      if (agent.updateState === undefined) {
        return Promise.reject(new Error('這張圖不能把對話灌回去（沒有 updateState）'));
      }
      return restoreConversation({ updateState: agent.updateState.bind(agent) }, threadId, events);
    },
  };
}
