/**
 * 會話的釘選、封存與改名上線的形狀（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）。
 *
 * **這一份只是契約**：型別、method 名字、client 方法。server 端還沒實作，五支 method 一律回 `not_supported`，
 * web 據那個碼把這幾個動作藏起來（或退回瀏覽器本地）；實作落地時這裡的形狀盡量不動。
 *
 * 照 dsh 的 `workspace-controller` 與 `session-controller`（`packages/api/workspace-controller/src/{commands,types}.ts`、
 * `packages/api/session-controller/src/{commands,types}.ts`，`5badb150`）：
 *
 * - **釘選與封存是兩個全域集合**，不是會話身上的旗標。每次變更**回完整的集合**（`WorkspacePinValue`、`WorkspaceArchiveValue`），
 *   呼叫端拿它整份取代本地的；釘選集合**最近釘的在前**。
 * - **取消是冪等的**：`unpin`／`unarchive` 對不在集合裡的 id（甚至不存在的會話）不是錯誤，輸掉與別的分頁的賽跑就是 no-op（dsh 原文）。
 * - **封存的會話不能釘**（dsh `WorkspaceArchivedSessionPinError`）。
 * - **封存撞上正在跑的會話：拒絕**（dsh `workspace/session-active`），除非帶 `stopActivity`，那就先停掉它的工作再封存；停是發出去就算，
 *   不等停穩，回應在封存集合落定時回。
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

/** 封存失敗的原因：沒有這條會話，或它還在跑而且沒帶 `stopActivity`（dsh `workspace/session-active`）。 */
export type ThreadArchiveError = ThreadNotFound | { readonly code: 'thread_active' };

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
