/**
 * 會話的釘選、封存、改名與分叉上線的形狀（[#633](https://github.com/DemianLi/nexus-agent/issues/633)、[#1580](https://github.com/DemianLi/nexus-agent/issues/1580)）。
 *
 * **契約**：型別、method 名字、client 方法。**前五支 server 端都已實作**（#633：釘選與封存是第一張，改名是第二張）。釘選與封存要整理檔，沒接落盤的
 * server 回 `not_supported`，web 據那個碼把這幾個動作藏起來（或退回瀏覽器本地）；改名寫在會話日誌上，不依賴整理檔。
 * **分叉（`thread.fork`）只有契約**：#1580 刀 1 先合，server 一律回 `not_supported`，刀 2 接上實作。
 *
 * 照 dsh 的 `workspace-controller` 與 `session-controller`（`packages/api/workspace-controller/src/{commands,types}.ts`、
 * `packages/api/session-controller/src/{commands,types}.ts`，`5badb150`）：
 *
 * - **釘選與封存是兩個全域集合**，不是會話身上的旗標。每次變更**回完整的集合**（`WorkspacePinValue`、`WorkspaceArchiveValue`），
 *   呼叫端拿它整份取代本地的；釘選集合**最近釘的在前**。
 * - **取消是冪等的**：`unpin`／`unarchive` 對不在集合裡的 id（甚至不存在的會話）不是錯誤，輸掉與別的分頁的賽跑就是 no-op（dsh 原文）。
 * - **封存的會話不能釘**（dsh `WorkspaceArchivedSessionPinError`）。
 * - **封存撞上正在跑的會話：拒絕**（dsh `workspace/session-active`，帶著 `activity`：哪幾類工作還在跑），除非帶 `stopActivity`——
 *   那就**先**把封存寫下去、**再**去停它的工作；停是發出去就算，不等停穩，回應在封存集合落定時回。封存的會話不跑模型（dsh 的
 *   `ArchivedSessionGate`）：之後喚醒它的任何輸入（人送的、排著的、目標續行、子代理結算）仍會開一輪，但以 `blocked` 收、一個模型請求都不發，直到取消封存。
 * - **改名**把使用者的標題追加成日誌事件，回受理後的標題與事件的 `seq`（dsh `SessionRenameValue { title, seq }`）。標題不合法
 *   （dsh `session/title-invalid`）：回 `title_invalid`，標題不變。標題是正規化後的（去控制字元、空白收成一格、截到 `maxTitleBytes`），
 *   **釘住**：之後的自動標題不會蓋過它。
 * - **分叉**照 dsh `session.fork`（`packages/api/session-controller/src/commands.ts:220-310`、`types.ts:329-341`，`687f282e`）：
 *   把指名那一輪（含）之前的對話複製成一條新 thread，回新 thread 的 id（dsh `SessionForkValue { sessionId }`）；新 id 一律由 server
 *   產生，請求不能指定。分出來之後兩條各走各的，列表上新的那條帶 `parentThreadId`（`protocol.ts` 的 `ThreadSummary`）。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **method 掛在 thread 底下**（`/threads/:id/commands/:method`），**:id 就是被動的那條會話**；集合是整台共用的、與走哪條 thread 的路徑無關。
 *    dsh 的請求把 `sessionId` 放在 params，我們的命令路徑已經帶了 thread id，不重複。
 * 2. **集合也跟著列表走**：`GET /threads` 的結果多兩個選填集合（{@link ThreadListSets}），開頁面就拿得到，不必為了畫側欄先打五支 RPC。
 *    dsh 的對應物是 `WorkspaceBaseline`（重連時的完整基線，同樣帶 `archivedSessionIds` 與 `pinnedSessionIds`）。沒有實作的 server 不送這兩格。
 * 3. **還沒有推送**：dsh 的 workspace feed 會把變更推給所有分頁。這一版只有 RPC 回應與列表；要多分頁即時同步時再加（向後相容）。
 * 4. **分叉用 `messageId` 指名切點，不用 `atSeq`**（理由 1：wire 表達不出來）。wire 刻意不帶耐久 seq（`protocol.ts` 的歷史
 *    `Event`、[#89](https://github.com/DemianLi/nexus-agent/issues/89)），web 拿不到 dsh 按鈕送的那顆 `turn/end` 的 seq。退到：指名那一輪
 *    root 回覆的 `messageId`（即時與歷史都穩定，評分指名的也是它），由 server 換算成同一輪的 `turn/end`——換算之後切點與 dsh 的 web
 *    入口相同。代價是沒有切在一輪中間的分叉。**不收「省略切點」**（dsh 由 Host 取最新完成那一輪）：範圍沒做，不是形狀不同。
 *    **失敗收尾的那一輪由 server 拒**（`fork_unavailable`），這一點也是 `messageId` 帶出來的：dsh 的 server 只看 `atSeq` 在不在
 *    （`commands.ts:251-260`），不給失敗的輪分支是 UI 的判斷（`turn-tail.ts:76-98` 的 `branchUnavailable`，範圍也更廣）；我們由 server
 *    換算切點，所以由 server 判。
 * 5. **分叉的業務失敗走成功回應**，同這一族其他幾支；dsh 的 `session/not-found`、`session/fork-unavailable` 都是拋出的錯誤。
 *    名額滿了不在這裡，**dsh 也沒有這個碼**：dsh 的 fork 不檢查名額，名額是 nexus 的 thread 數上限（#1476，偏離登記在
 *    `wire-handler.ts` 的 `threadFor`，理由 2）。所以沿用那道上限整條線共用的 `thread_at_capacity`（`protocol.ts` 的
 *    `THREAD_AT_CAPACITY`，`ErrorResponse`），任何會新建 thread 的路滿了都回它。
 *
 * 回應都是 `{ ok: true, value }`／`{ ok: false, error: { code } }`，業務失敗走成功回應，`ErrorResponse` 只給「這條線收不了」
 * （含 `not_supported`），同 {@link ../model-selection.ts | 模型選擇} 與回饋那四支。
 *
 * @module
 */

/** 這個檔定義的六支 method。 */
export const THREAD_MANAGEMENT_METHODS = [
  'thread.pin',
  'thread.unpin',
  'thread.archive',
  'thread.unarchive',
  'thread.rename',
  'thread.fork',
] as const;

export type ThreadManagementMethod = (typeof THREAD_MANAGEMENT_METHODS)[number];

export function isThreadManagementMethod(value: unknown): value is ThreadManagementMethod {
  return (
    typeof value === 'string' && (THREAD_MANAGEMENT_METHODS as readonly string[]).includes(value)
  );
}

/**
 * 釘選與封存兩個全域集合，同 dsh 的 `WorkspaceBaseline` 裡的兩格。
 * 兩格都是整份：呼叫端不要自己增減，拿到就取代。
 */
export interface ThreadListSets {
  /** 釘選的 thread，**最近釘的在前**。 */
  readonly pinnedThreadIds: readonly string[];
  /** 封存的 thread，順序不承載語意。 */
  readonly archivedThreadIds: readonly string[];
}

export interface ThreadPinCommand {
  readonly id: number;
  readonly method: 'thread.pin';
  readonly params: Record<string, never>;
}

export interface ThreadUnpinCommand {
  readonly id: number;
  readonly method: 'thread.unpin';
  readonly params: Record<string, never>;
}

export interface ThreadArchiveCommand {
  readonly id: number;
  readonly method: 'thread.archive';
  readonly params: {
    /**
     * 先停掉它跑著的工作（這一輪、子代理、背景工作）再封存，而不是以 `thread_active` 拒絕。照 dsh `stopActivity`：
     * 停是發出去就算，不等停穩。
     */
    readonly stopActivity?: boolean;
  };
}

export interface ThreadUnarchiveCommand {
  readonly id: number;
  readonly method: 'thread.unarchive';
  readonly params: Record<string, never>;
}

export interface ThreadRenameCommand {
  readonly id: number;
  readonly method: 'thread.rename';
  /** 使用者打的標題；怎麼正規化與驗證由 server 定（dsh 用 `session-title`）。 */
  readonly params: { readonly title: string };
}

export interface ThreadForkCommand {
  readonly id: number;
  readonly method: 'thread.fork';
  /**
   * 切點：那一輪 root 回覆的 `messageId`（`AiEntry.messageId`）。server 換算成同一輪的 `turn/end`，那一輪（含）之前的都帶過去；
   * 同一輪的哪一則回覆都換算到同一顆。
   */
  readonly params: { readonly messageId: string };
}

export type ThreadManagementCommand =
  | ThreadPinCommand
  | ThreadUnpinCommand
  | ThreadArchiveCommand
  | ThreadUnarchiveCommand
  | ThreadRenameCommand
  | ThreadForkCommand;

/** 沒有這條會話（dsh `session/not-found`）。 */
export type ThreadNotFound = { readonly code: 'thread_not_found' };

/** 釘選失敗的原因：沒有這條會話，或它已經封存（封存的會話不能釘）。 */
export type ThreadPinError = ThreadNotFound | { readonly code: 'thread_archived' };

/**
 * 一條會話還有哪幾類工作在跑（dsh `SessionActivity` 的四個擁有者是 turn／job／subagent／schedule，我們對得上的是兩類）：
 *
 * - `turn`：有一輪在跑或排著，**含停在等人回答**（核准、提問發生在一輪的工具執行當中，照 dsh 算在跑）。送出佇列裡排著而沒被
 *   「停止」停住的輸入——人送的、目標續行的預約、子代理結算或寫來的話——都是一件待開的輪，歸這一類；
 * - `subagent`：背景子代理還在跑。
 *
 * dsh 的 `job`（背景工作）與 `schedule`（排程）我們沒有對應物，有了再加成員。
 */
export const THREAD_ACTIVITY_KINDS = ['turn', 'subagent'] as const;

export type ThreadActivityKind = (typeof THREAD_ACTIVITY_KINDS)[number];

/**
 * 封存失敗的原因：沒有這條會話，或它還在跑而且沒帶 `stopActivity`（dsh `workspace/session-active`）。
 * `activity` 照 dsh：它的 `session-active` 錯誤也帶著各 provider 回報的 activity，這裡同樣帶，讓畫面講得出「為什麼不能封存」。選填：舊的 server 沒有。
 */
export type ThreadArchiveError =
  | ThreadNotFound
  | { readonly code: 'thread_active'; readonly activity?: readonly ThreadActivityKind[] };

/** 改名失敗的原因：沒有這條會話，或標題不合法（dsh `session/title-invalid`）。 */
export type ThreadRenameError =
  ThreadNotFound | { readonly code: 'title_invalid'; readonly message?: string };

/** 釘選／取消釘選的結果：整個釘選集合。取消對不在集合裡的 id 也是 `ok`（冪等）。 */
export type ThreadPinResult =
  | { readonly ok: true; readonly value: Pick<ThreadListSets, 'pinnedThreadIds'> }
  | { readonly ok: false; readonly error: ThreadPinError };

/** 取消釘選**不會失敗**：不在集合裡、甚至沒有這條會話都是 no-op（dsh `unpinSession` 不檢查）。 */
export type ThreadUnpinResult = {
  readonly ok: true;
  readonly value: Pick<ThreadListSets, 'pinnedThreadIds'>;
};

/** 封存的結果：整個封存集合。 */
export type ThreadArchiveResult =
  | { readonly ok: true; readonly value: Pick<ThreadListSets, 'archivedThreadIds'> }
  | { readonly ok: false; readonly error: ThreadArchiveError };

/** 取消封存的結果：整個封存集合。**不會失敗**，冪等（dsh `unarchiveSession` 不檢查）。 */
export type ThreadUnarchiveResult = {
  readonly ok: true;
  readonly value: Pick<ThreadListSets, 'archivedThreadIds'>;
};

/** 改名的結果：受理後的標題與記下它的那顆事件的 `seq`。 */
export type ThreadRenameResult =
  | { readonly ok: true; readonly value: { readonly title: string; readonly seq: number } }
  | { readonly ok: false; readonly error: ThreadRenameError };

/**
 * 分叉失敗的原因：沒有這條會話，或指名的那一則分不出去（dsh `session/fork-unavailable`）——它不是這條 thread 的 root 回覆
 * （使用者的話、子代理的回覆、找不到這個 `messageId`）、它那一輪還沒收尾，或那一輪是失敗收尾的（dsh 的分支鈕對失敗收尾的輪不給，
 * `turn-tail.ts` 的 `branchUnavailable`）。
 */
export type ThreadForkError = ThreadNotFound | { readonly code: 'fork_unavailable' };

/** 分叉的結果：新 thread 的 id（server 產生）。 */
export type ThreadForkResult =
  | { readonly ok: true; readonly value: { readonly threadId: string } }
  | { readonly ok: false; readonly error: ThreadForkError };
