/**
 * 會話的釘選、封存與改名上線的形狀（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）。
 *
 * **契約**：型別、method 名字、client 方法。**釘選與封存四支 server 端已實作**（#633 第一張）；`thread.rename` 還沒（第二張），
 * 沒實作的、或沒接落盤的 server 回 `not_supported`，web 據那個碼把這幾個動作藏起來（或退回瀏覽器本地）。
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
 *   `ArchivedSessionGate`）：之後喚醒它的任何輸入（人送的、排著的、目標續行、子代理結算）都不開那一輪，直到取消封存。
 * - **改名**把使用者的標題追加成日誌事件，回受理後的標題與事件的 `seq`（dsh `SessionRenameValue { title, seq }`）。標題不合法
 *   （dsh `session/title-invalid`）：回 `title_invalid`，標題不變。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **method 掛在 thread 底下**（`/threads/:id/commands/:method`），**:id 就是被動的那條會話**；集合是整台共用的、與走哪條 thread 的路徑無關。
 *    dsh 的請求把 `sessionId` 放在 params，我們的命令路徑已經帶了 thread id，不重複。
 * 2. **集合也跟著列表走**：`GET /threads` 的結果多兩個選填集合（{@link ThreadListSets}），開頁面就拿得到，不必為了畫側欄先打五支 RPC。
 *    dsh 的對應物是 `WorkspaceBaseline`（重連時的完整基線，同樣帶 `archivedSessionIds` 與 `pinnedSessionIds`）。沒有實作的 server 不送這兩格。
 * 3. **還沒有推送**：dsh 的 workspace feed 會把變更推給所有分頁。這一版只有 RPC 回應與列表；要多分頁即時同步時再加（向後相容）。
 *
 * 回應都是 `{ ok: true, value }`／`{ ok: false, error: { code } }`，業務失敗走成功回應，`ErrorResponse` 只給「這條線收不了」
 * （含 `not_supported`），同 {@link ../model-selection.ts | 模型選擇} 與回饋那四支。
 *
 * @module
 */

/** 這個檔定義的五支 method。 */
export const THREAD_MANAGEMENT_METHODS = [
  'thread.pin',
  'thread.unpin',
  'thread.archive',
  'thread.unarchive',
  'thread.rename',
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

export type ThreadManagementCommand =
  | ThreadPinCommand
  | ThreadUnpinCommand
  | ThreadArchiveCommand
  | ThreadUnarchiveCommand
  | ThreadRenameCommand;

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
