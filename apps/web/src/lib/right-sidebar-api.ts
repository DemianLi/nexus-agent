/**
 * 右側欄的契約型別：內容從哪讀（`RightSidebarSources`）、卡片用得到的那一半（`RightSidebarApi`）、面板內容拿到的東西
 * （`PanelBodyProps`）、「顯示某一輪」的請求（`TurnReveal`）。全是型別，沒有執行期內容。
 *
 * 放在 `lib/` 而不是 `components/sidebar/`：側欄是樞紐，面板與卡片都要用這幾個型別，型別若住在側欄元件裡，
 * 它們就得 import 回側欄（#1127）。
 */

import type { ChangesStores } from '@/lib/changes-diff';
import type { ConversationStore } from '@/lib/conversation-store';
import type { DeliverableDownloader } from '@/lib/deliverable-download';
import type { DeliverableFileStore } from '@/lib/deliverable-file';
import type { LocatedFile } from '@/lib/deliverables-view';
import type { PlanDocument } from '@/lib/plan-review';
import type { PanelKind } from '@/lib/right-sidebar';
import type { SubagentUsageLoader } from '@/lib/subagent-usage';
import type { TrajectoryPuller } from '@/lib/trajectory-pull';

/** 內容從哪裡讀：跟著這條會話的畫面走（`App.tsx` 建）。 */
export interface RightSidebarSources {
  readonly changes?: ChangesStores | undefined;
  readonly deliverableFiles?: DeliverableFileStore | undefined;
  readonly deliverableDownload?: DeliverableDownloader | undefined;
  /** 對話裡的計劃，以 {@link SidebarTab} 的 `plan` id 為鍵（#654）。 */
  readonly plans?: ReadonlyMap<string, PlanDocument> | undefined;
  /**
   * 對話狀態的可訂閱 store（#1033），觀測分頁讀它。**放的是 store 不是 `ConversationState`**：`sources` 一變身分，
   * `RightSidebarPanel` 的 `memo` 就擋不住（見該元件的註解）。沒給就是沒有對話可看（觀測分頁畫「尚無資料」）。
   */
  readonly conversation?: ConversationStore | undefined;
  /**
   * 讀一個背景子代理自己的總帳（#1032，成本分頁的子代理分列）。**身分要穩定**（`App` 以 `[client, threadId]` 建），理由同
   * {@link RightSidebarSources.conversation}。沒給就不畫子代理那一段。
   */
  readonly subagentUsage?: SubagentUsageLoader | undefined;
  /**
   * 軌跡細節的按需拉取（#1083，觀測分頁）：快取與進行中的請求放在這裡，**身分要穩定**（`App` 以 `[client, threadId]` 建）——
   * 分頁切走再回來、面板重掛，已經拉到的不必再拉。沒給就只有推送的那幾輪細節、更早的輪只有摘要。
   */
  readonly trajectoryPull?: TrajectoryPuller | undefined;
}

/** 卡片用得到的那一半。 */
export interface RightSidebarApi {
  openChanges(seq: number, index: number): void;
  /** 沒有讀檔的 store 時是 `undefined`：交付卡就不畫預覽鈕。 */
  readonly openDeliverable: ((file: LocatedFile) => void) | undefined;
  /**
   * 人按「查看全文」（#654）：打開那份計劃的分頁、焦點進分頁。`from` 是按下去的那顆鈕，停靠時收起鈕把焦點交回它
   * （覆蓋那一種由 Sheet 自己還）。
   */
  openPlan(id: string, from?: HTMLElement | null): void;
  /**
   * 待審時自動打開一次（#654 二-Q4）：只有停靠的寬度才開，焦點不動。回傳有沒有開；沒開的話呼叫端不該記成開過。
   */
  autoOpenPlan(id: string): boolean;
  /**
   * 打開單例面板（觀測、成本，#1031）：已經開著就只是選中。焦點進分頁；`from` 是按下去的那顆鈕，停靠時收起鈕把焦點交回它
   * （同 {@link RightSidebarApi.openPlan}）。
   */
  openPanel(kind: PanelKind, from?: HTMLElement | null): void;
  /**
   * 捲到對話區的那一則（#1033，觀測分頁的「在對話裡定位」）。找不到那一格（沒載入、或那一則畫不出來）回 `false`，什麼都不動。
   * 1024 以下右側欄是蓋住整個對話的抽屜：先收掉它，抽屜關掉時焦點交給那一則；停靠時焦點留在面板，不搬（spec §8「只在焦點本來會丟掉時才搬」）。
   */
  locate(entryId: string): boolean;
  /**
   * 打開觀測分頁、捲到那一輪並標示（#1034，成本分頁的「看這一輪」）。`seq` 是開那一輪的 `turn/start` 的位置
   * （`TokenMeterTurn.seq`）。觀測分頁還有沒有那一輪的資料它自己判斷：沒有就在分頁裡講，不跳錯地方。
   * 兩個分頁在 1024 以下同在一個抽屜裡，所以不收抽屜；焦點交給那一輪的標題。
   */
  revealTurn(seq: number): void;
  /**
   * 打開觀測分頁、捲到這一則回覆所在的那一輪並標示（#1034，回覆底下的「這一輪的過程」）。`messageId` 是對話裡那則回覆的訊息 id。
   * 那一輪在哪由觀測分頁自己判斷：落在軌跡窗口之外（只剩摘要或根本沒有）就在分頁裡講，不跳錯地方。
   * `from` 是按下的那顆鈕：1024 以下抽屜關掉時焦點交回它；抽屜開著時焦點交給那一輪的標題。
   */
  revealReply(messageId: string, from?: HTMLElement | null): void;
}

/** 面板內容拿到的東西，由 `right-sidebar.tsx` 的 `TabBody` 給。 */
export interface PanelBodyProps {
  /**
   * 現在看得見嗎：右側欄開著、而且是選中的這一個分頁。分頁藏起來時不卸載（保住捲動位置），所以內容要靠它判斷
   * 要不要訂閱資料（`useVisibleSnapshot`）。
   */
  readonly visible: boolean;
  readonly sources: RightSidebarSources;
  /** 捲到對話區的那一則；找得到回 `true`。1024 以下它會先收掉抽屜。 */
  readonly locate: (entryId: string) => boolean;
  /**
   * 有人從別的分頁要求顯示觀測分頁的某一輪（#1034，成本分頁的「看這一輪」）；只有觀測分頁收到。沒有人要求時是 `undefined`。
   * 用完回報 {@link PanelBodyProps.onRevealed}，右側欄才清掉：分頁沒掛上或藏著時請求留著，等它看得見再消費。
   */
  readonly reveal?: TurnReveal | undefined;
  readonly onRevealed?: ((nonce: number) => void) | undefined;
}

/**
 * 請求顯示觀測分頁的某一輪，`nonce` 讓同一輪連按兩次也算兩次請求。要哪一輪有兩種說法：
 * `seq` 是開那一輪的 `turn/start` 的位置（成本分頁的「看這一輪」）；`messageId` 是對話裡某一則回覆的訊息 id，
 * 觀測分頁自己查它落在哪一輪（回覆底下的「這一輪的過程」，#1034）。
 */
export type TurnReveal = { readonly nonce: number } & (
  | { readonly seq: number; readonly messageId?: undefined }
  | { readonly messageId: string; readonly seq?: undefined }
);
