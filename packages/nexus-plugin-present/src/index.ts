/**
 * `@nexus/plugin-present`——模型宣告**這一輪交付了哪些檔案**：一顆 `present` 工具，`tools/result` 說最終結果
 * 不是錯誤時寫一筆 `deliverables/presented` 進呼叫它的那一份會話日誌。
 *
 * 形狀照 dsh 的 `packages/deliverables/tool-present/`（`477b4f4`）：模型看到的描述、參數說明與
 * `Presented <path>` 的結果逐字照抄；拒絕的字句也照抄，**但不是每一句都有**——dsh 那句
 * `present requires an open turn`（沒有進行中的那一輪就拒）我們沒有，要不要補見
 * [#696](https://github.com/DemianLi/nexus-agent/issues/696) 的留言，還沒定案。每次最多
 * `maxFiles`（預設 8）個；**只記路徑與說明，不讀、不複製內容**。dsh 的 standard preset 掛它，
 * 所以它在出貨清單裡。
 *
 * ## 什麼時候寫：`tools/result` 說結果不是錯誤的那一刻
 *
 * 照 dsh：工具本體只把這次要交付什麼記在一張以呼叫為鍵的表上（`pending`），等 `tools/result`
 * 通知（post-execute 鉤子都跑完之後那一顆）說結果不是錯誤才 `append`。**不在本體裡直接寫**（`todo_write` 那條路）：
 * 那樣的話一次被外層改判成錯誤的呼叫照樣留下一筆交付，dsh 有一條測試專門擋它。表的鍵帶著呼叫者的
 * {@link SessionAddress}：這顆監聽者是 root 與每個子代理共用的一份，callId 在兩邊撞號時不能取走對方那一筆。
 *
 * **同步寫，次序同 dsh（#1286）：`tool/call → deliverables/presented → tool/result`。** `tools/result` 由圍堵在記
 * `tool/result` **之前**派發（`containment.ts` 的 `notifyToolResult`），而 dsh 的 `notifyResult` 也先於迴圈的
 * `appendToolResult`，所以交付落在配對的 `tool/result` 之前。監聽者在圍堵的呼叫堆疊上被叫、不在任何日誌發佈回呼裡，
 * 同步 `append` 不會撞 `SessionLog` 的重入防護，不需要排 microtask。（#1286 之前是訂閱自己那份日誌、等 `tool/result`
 * 發佈後排一個 microtask 才寫，所以落在它**之後**；舊日誌仍是那個次序，讀它的人與日誌不變式兩種都收。）
 *
 * **#1469 起掛在 Cordis 樹上**：監聽者經 `tools` 服務 `1.3.0` 的 `onResult` 登記，宿主（橋接列）把它折進**每條 thread 自己的**
 * `registry.events.on('tools/result', l)`，所以派發的時機與次序一個字都沒變。
 *
 * **表的鍵是最近似的，不是 dsh 的鍵。** dsh 的 `pending` 是 `WeakMap<ToolExecution, …>`，以那一次執行物件為鍵；
 * 我們的圍堵沒有 `ToolExecution` 物件，只有 `PipelineExecution` 的視圖，每次派發都是新造的，認不出同一次執行，
 * 所以退到「呼叫者位址＋`callId`」。這是 #1286 登記的鍵偏離。
 *
 * 監聽者是 `EventDispatcher.observe` 派發的：它拋或 reject 都只回報、不影響那次呼叫。
 *
 * **一個呼叫只留一筆。** 圍堵對控制流例外（中斷）是原樣往外拋、不派發 `tools/result` 也不寫 `tool/result` 的，而 resume 之後
 * 同一個 `callId` 會再進來一次；表是覆寫，所以舊的一筆不會讓結果落定時交付兩次。
 *
 * ## 交付表的壽命（#1469 Q3 (a)）：行程級，跟著閉包活，不在列卸載時清
 *
 * 上樹後 `apply` 在一個行程裡只跑一次，表是行程級的一張。**以前**組裝收掉時整張清空（`registry.lifecycle.onDispose`），**現在拿掉那一行，
 * 也不改成列卸載（`ctx.effect`）時清**：開著的 thread 手上握著快照的工具與 listener，兩者共用這個閉包；列被停用或重載時清表的話，
 * 懸著的那一次交付會寫不進日誌。表跟著閉包活，最後一條握著它的 thread 不用了才回收。
 *
 * **已知缺口（登記，不修）**：被中斷又沒有 resume 的那一筆留在表裡，條目握著那條 thread 的 `SessionLog`，thread 收掉之後整份日誌仍被引用。
 * 產品上跟以前一樣（serve 只在關機時收 thread，CLI 一個行程一條 thread，以前清表的時刻就是行程結束），等「閒置 thread 回收」那張卡
 * （#1464 的量測列為優化線索）一起處理。dsh 沒有這個問題：它的 exec 物件在工具本體與 `tools/result` 之間是同一個，可以當 `WeakMap` 的鍵；
 * 我們的 exec 每次重建，鍵的偏離已登記（#1286）。
 *
 * **這算不算「有狀態的插件」（Q3-1）：不算。** 這張表是**單次呼叫內的過渡狀態**（本體記、`tools/result` 取走刪掉），不是要跨呼叫、
 * 跨 thread 保留的東西；工具與 listener 一起被快照進同一條 thread，列卸載後仍然成對可用。
 *
 * **前提：宿主端要把 `events` 交給 `foldRegistry`**（產品路徑只有 `agent-factory.ts`，它交 `registry.dispatch`）。
 * 沒交的組裝不派發 `tools/result`，這顆工具就靜靜不交付。**提供者沒有 `onResult`（`tools` 契約低於 `1.3.0`）時 `apply` 直接拒絕起來**，
 * 不讓它靜靜不交付。
 *
 * ## 寫進哪一份：呼叫者自己那一份
 *
 * 照 dsh 的所有權規則：「交付歸調用方 Session 所有；父 Session 如需聲明交付子 Agent 創建的文件，必須
 * 自行調用 `present`」。所以它**不是 `rootOnly`**，子代理的交付留在子代理那一份。web 只收 root 那一份
 * （即時與重新整理同一條規則，見 `apps/harness` 的 pump 與 `conversation-history.ts`）。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **最後一段是符號連結擋不下來。** dsh 先 `lstat` 再 `stat`。我們的檢查走 backend，而 backend
 *    協定沒有 `lstat`：`ls` 跟著符號連結走；`read` 會 `lstat`，但它把整個檔讀進記憶體，違反「不讀
 *    內容」；繞過 backend 直接呼叫 `node:fs` 則越過 fence，也看不到 plugin 掛上去的其他 backend。退到
 *    列上一層目錄，只確認「在、而且不是目錄」。
 * 2. **「有沒有工作區」看能力，不看 header。** dsh 看會話 header 的 `cwd`；我們的 header 記的是
 *    行程的工作目錄，而且沒有工作區時組裝點照樣墊一顆 `StateBackend`。改看工作區能力（sandbox-policy 只在有圍堵時宣告它），
 *    **#1469 起經 fs 把手的 `hasWorkspace()` 讀**：fold 填 backend 的同一處把能力算進去，逐條 thread。
 * 3. **路徑在 backend 的命名空間裡解析。** dsh 的絕對路徑可以指到工作區外（例如 `/tmp`），只要
 *    Session 檔案系統讀得到；我們的 backend 是以工作區為根的虛擬路徑，`/report.md` 就是工作區根下
 *    的 `report.md`，工作區外本來就指不到。相對路徑補成以根為起點，同 dsh「相對路徑以工作目錄為準」。
 *    **但那句「指不到」對路由不成立**，見偏離 6。
 * 4. **拒絕是回錯誤訊息，不是拋。** 同 `@nexus/plugin-todo` 的第 3 條（[#271](https://github.com/DemianLi/nexus-agent/issues/271)）：
 *    模型手上的字與 dsh 一致，`Error: ` 前綴由 `toolRefusal` 加。
 * 5. **沒有 `turn` 與輸出 schema。** 事件不帶 `turn`，理由見 `@nexus/core` 的 `SessionEventMap`；工具
 *    回一句字串（LangChain 的 `tool()` 形狀），就是 dsh `render` 出來給模型看的那幾行。
 * 6. **不在工作區磁碟上的路由一律拒**（[#951](https://github.com/DemianLi/nexus-agent/issues/951)）。
 *    **哪一條**：dsh 只要 Session 檔案系統讀得到就收。它的讀端（`packages/client/ui-deliverables/src/present-open.ts`，
 *    SHA `5badb15`）拿工作區根加交付記的路徑，經 `workspaceFiles.stat` 與 `fs.resolve` 在同一個 `ctx.fs` 上
 *    驗過才開；那個檔案系統是真的磁碟，沒有只存在於 Session 裡的路由，所以「檢查看得到」與「讀端找得到」
 *    從沒分開過。**為什麼表達不出來**：我們的檢查走基座的虛擬 backend，它在磁碟之上疊了組裝點的路由，
 *    兩端不再是同一個東西。檢查走折後的 backend（偏離 1），
 *    而讀端（`apps/harness` 的 `deliverable-files.ts`）只對工作區磁碟做 `realpath`；組裝點包的會話歷史與工具
 *    結果暫存兩條路由、plugin 用 `backend.mount()` 掛的路由，檢查端看得到、讀端永遠讀不到，於是 `present`
 *    記下一筆沒人下載得了的交付。**退到什麼**：路徑落在這些路由的前綴底下就拒，回話叫模型先 `write_file`
 *    到工作區再交付（{@link presentOffWorkspaceMessage}，沒有 dsh 對應，句型接 `Cannot present <path>: …`）。
 *    不帶 `FS_NOT_FOUND`：檔案是在的，只是不在磁碟那一側，帶那個碼會讓讀它的人以為是「不存在」。
 *    前綴由兩處合併而來，**#1469 起都在 fs 把手的 `offWorkspacePrefixes()` 裡**（fold 填 backend 的同一處併進去）：組裝點明著交的
 *    （折後的 backend 是巢狀的，裡面兩層的前綴在 private 欄位裡讀不到）與 plugin 用 `backend.mount()` 掛的路由。
 *
 * 檔案系統照 dsh 從 `fs` 服務拿（dsh 的 `inject` 有 `'fs'`），拿到的是基座檔案工具實際讀寫的那一個
 * （[#694](https://github.com/DemianLi/nexus-agent/issues/694)）。**那條理由只對一半成立**：走服務是為了
 * 看得見檔案工具寫的檔（工作區那一側，今天仍如此）；但「看得見」不等於「讀端讀得到」，路由那一側看得見的
 * 檔要另外擋掉（偏離 6）。服務的值是一格 fold 之後才填的把手、
 * 所以在工具被叫時才讀；**樹上是 `@nexus/fs` 的查找服務**（#1466、#1469）：呼叫當下依 thread 找回那條 thread 自己的把手，偏離登記在
 * `docs/plugin-contract.md`（fs 查找）與 `@nexus/core` 的 `fs-service.ts`。
 *
 * ## 這個檔不 import `@nexus/core`（#1469）
 *
 * 遷上樹之後套 SDK lint：會話日誌與位址的型別取自 `@nexus/session`、工具結果的寫法與呼叫設定的讀法取自 `@nexus/tool-result`、
 * 路徑換算取自 `@nexus/fs`，三個都是 core 的單向轉出。`deliverables/presented` 的事件擴充搬進 core 的 `session-log.ts`
 * （前例 `todo/write`），**偏離 dsh**：dsh 把型別和事件擴充都放在插件自己的 `src/types.ts`，我們的宿主（wire、web 的事件讀端、
 * `conversation-history`）要不經插件就讀到這份型別。`present-invariant` 那一列（`src/invariant.ts`）仍在相容層，eslint 只排除那一個檔（#1463 Q3 (a)）。
 *
 * @see [#441](https://github.com/DemianLi/nexus-agent/issues/441)
 * @module
 */

import { posix } from 'node:path';

import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Context } from '@nexus/cordis';
import { fsToken, isUnderAnyPrefix, virtualPathOf } from '@nexus/fs';
import type { FsLookup } from '@nexus/fs';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { sessionLookupToken } from '@nexus/session';
import type { PresentedFile, SessionAddress, SessionLog, SessionLookup } from '@nexus/session';
import {
  callThreadId,
  toolCallIdOf,
  toolCallSessionAddress,
  toolRefusal,
} from '@nexus/tool-result';
import { toolsToken } from '@nexus/tools';
import type { ToolResultListener } from '@nexus/tools';
import { adaptBackendProtocol } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { z } from 'zod';

/** 註冊出來的工具名，照 dsh。web 的工具卡照這個名字認（`apps/web/src/lib/present-view.ts`）。 */
export const PRESENT_TOOL_NAME = 'present';

/** 一次最多幾個檔。照 dsh `Config.maxFiles` 的預設。 */
export const DEFAULT_MAX_FILES = 8;

/**
 * 模型看到的描述，**逐字照抄 dsh**（`tool-present/src/index.ts`）。它告訴模型**使用者需要一份
 * 獨立的檔案時才叫**（尤其是 Office 文件、試算表、簡報），最後回覆交代得了就不必叫。
 */
export const PRESENT_TOOL_DESCRIPTION =
  'Declare existing files as final deliverables for the user. ' +
  'Use it when the user needs a separate file, especially Office documents, spreadsheets, and slide decks; ' +
  'prefer your final response when that suffices. The user opens the current files; their contents are not copied.';

/** 這次組裝沒有工作區時回的話，照 dsh。 */
export const PRESENT_NO_WORKSPACE_MESSAGE = 'present requires a workspace';

/** 拿不到呼叫者那一份日誌時回的話，照 dsh 的 `present requires an agent Session`。 */
export const PRESENT_NO_SESSION_MESSAGE = 'present requires an agent Session';

/** 路徑是空的（去掉頭尾空白之後）時回的話，照 dsh。 */
export const PRESENT_EMPTY_PATH_MESSAGE = 'present requires a non-empty file path';

/**
 * 找不到檔案時帶的碼，照 dsh 的 `FsError`／`FS_NOT_FOUND`。core 那邊同一個字串是
 * `observation.ts` 的區域常數，沒有匯出，所以這裡自己寫一份。
 */
const NOT_FOUND = { name: 'FsError', code: 'FS_NOT_FOUND' } as const;

/**
 * 檔數不在範圍內時回的話。
 * @param maxFiles - 這次掛載的上限。
 * @returns 模型看到的那一句。
 */
export function presentCountMessage(maxFiles: number): string {
  return `present accepts 1 to ${maxFiles} files`;
}

/**
 * 找不到檔案時回的話，照 dsh。
 * @param path - 模型給的路徑，原樣。
 * @returns 模型看到的那一句。
 */
export function presentNotFoundMessage(path: string): string {
  return `Cannot present ${path}: file not found. Check the path, create the file if needed, and retry.`;
}

/**
 * 路徑指到的不是一般檔案（目錄、工作區根）時回的話，照 dsh。
 * @param path - 模型給的路徑，原樣。
 * @returns 模型看到的那一句。
 */
export function presentNotFileMessage(path: string): string {
  return `Cannot present ${path}: not a regular file`;
}

/**
 * 路徑落在不在工作區磁碟上的路由時回的話。**沒有 dsh 對應**，見檔頭偏離 6。
 *
 * 句型照上一句（`Cannot present <path>: …`），後半告訴模型下一步：交付的檔要在工作區裡，先 `write_file` 寫過去。
 * @param path - 模型給的路徑，原樣。
 * @returns 模型看到的那一句。
 */
export function presentOffWorkspaceMessage(path: string): string {
  return `Cannot present ${path}: it is not on the workspace disk. Write the file into the workspace with write_file, then present that path.`;
}

/**
 * 成功時模型看到的字：一個檔一行，照 dsh 的 `render`。
 * @param files - 通過檢查的檔案。
 * @returns 模型看到的那幾行。
 */
export function presentedText(files: readonly PresentedFile[]): string {
  return files.map((file) => `Presented ${file.path}`).join('\n');
}

/**
 * 掛載參數。
 *
 * dsh 在掛載時就驗這一格（`present requires a positive integer maxFiles`）；
 * 我們驗在同一個時刻，只是換成 schema——訊息因此帶得出是清單裡哪一個條目。
 */
export const presentConfigSchema = z.strictObject({
  /** 一次呼叫最多幾個檔。正整數，省略即 {@link DEFAULT_MAX_FILES}。 */
  maxFiles: z
    // **一條判準，一句話**：dsh 對每一種壞值都回同一句。拆成 `.number().int().positive()`
    // 的話訊息會隨壞法換三種，而 `Infinity` 印出來的是「expected number, received number」
    // （實測），對著設定檔的人看不懂那在講什麼。
    .custom<number>(
      (value) => Number.isSafeInteger(value) && (value as number) >= 1,
      'present requires a positive integer maxFiles',
    )
    .default(DEFAULT_MAX_FILES),
});

/** 驗過的設定。 */
export type PresentConfig = z.infer<typeof presentConfigSchema>;

/** 工廠收的東西：schema 的輸入面。 */
export type PresentPluginOptions = z.input<typeof presentConfigSchema>;

/** 一個路徑在 backend 上是什麼。 */
type Inspection = 'file' | 'not-file' | 'missing';

/**
 * 看一個路徑在 backend 上是什麼：列它上一層目錄，找它那一列。**不讀內容**（見檔頭偏離 1）。
 *
 * 模型給的路徑先過 `@nexus/core` 的 `virtualPathOf`（相對路徑以工作區根為起點，見檔頭偏離 3）。
 * **`..` 在那一步就被夾回根了**，不會走到 backend：`a/../b.md` 查的是 `/b.md`，`../x.md` 查的是
 * `/x.md`。同一個字串交給 `read_file` 會被基座拒，這裡則是查根底下那一個——那個檔在就認，
 * 不在就是找不到，出不了界。規則跟讀檔路由、workspace-changes 共用那一份，不在這裡另寫。
 * @param backend - 折出來的 backend。
 * @param path - 模型給的路徑。
 * @returns 一般檔案、別的東西，或不在。
 */
async function inspect(backend: AnyBackendProtocol, path: string): Promise<Inspection> {
  const target = virtualPathOf(path);
  // 工作區根自己列不出來（它沒有上一層），dsh 對 `.` 回的是「不是一般檔案」。
  if (target === '/') return 'not-file';
  let listing: Awaited<ReturnType<ReturnType<typeof adaptBackendProtocol>['ls']>>;
  try {
    listing = await adaptBackendProtocol(backend).ls(posix.dirname(target));
  } catch {
    // `..` 路段已經被夾掉了。基座 `FilesystemBackend` 的 `ls` 自己把 `resolvePath` 的拋（它比的是
    // `..` 子字串，`x..y/a.md` 的上一層也算）收成空清單，走的是下面的 'missing'；這裡接的是別的
    // backend 拋出來的。對模型來說都是指不到。
    return 'missing';
  }
  const found = listing.files?.find((file) => virtualPathOf(file.path) === target);
  if (found === undefined) return 'missing';
  return found.is_dir === true ? 'not-file' : 'file';
}

/**
 * 等結果的那張表的鍵：thread、呼叫者的位址加 `callId`。位址認不出來時本體已經拒了，不會走到這裡。
 *
 * **thread 不能省**（#1418）：插件套一次、服務好幾條 thread 時，這張表是 `apply` 閉包裡的一張，兩條 thread 可能撞上同一個
 * `callId`（模型給的 `tool_call.id`，各 thread 各自編號），少了它就互相覆蓋。dsh 用 `WeakMap<ToolExecution>`，是因為工具執行當下
 * 與 `tools/result` 拿到的是同一個物件；我們每次都重建 `exec`，照它的意思改用身分當鍵——`exec.thread` 與工具本體
 * 從 `config` 讀到的 `thread_id` 是同一個值（`thread-id-reaches-handlers.test.ts` 實測）。認不出 thread 時是 `?`
 * （手搭的測試呼叫；兩邊同樣認不出來，鍵仍然對得上）。
 */
function pendingKey(
  thread: string | undefined,
  address: SessionAddress | undefined,
  callId: string,
): string {
  const who =
    address === undefined ? '?' : address.kind === 'root' ? 'root' : `sub:${address.runId}`;
  return `${thread ?? '?'}\u0000${who}\u0000${callId}`;
}

/**
 * 交付需要的兩個查找。**都是呼叫當下才問**：行程裡活著哪幾條 thread、各自的 fs 把手是哪一個，是呼叫當下的事實，不是掛載當下的。
 * 兩個查找用同一支挑法（`@nexus/core` 的 `pickBoundForCall`），所以對「這次呼叫屬於哪一條 thread」永遠給同一個答案。
 */
export interface PresentLookups {
  /** 這次呼叫寫進哪一份日誌（會話查找，#1463）。 */
  readonly sessions: (invocation: unknown) => SessionLookup;
  /** 這次呼叫該讀哪一條 thread 的 fs 把手（fs 查找，#1466）。 */
  readonly fs: (invocation: unknown) => FsLookup;
}

/** {@link createPresentDelivery} 的回傳：工具，與等 `tools/result` 的那一位觀察者。 */
export interface PresentDelivery {
  /** `present` 工具。 */
  readonly tool: StructuredToolInterface;
  /** `tools/result` 觀察者：取出等著的那一筆，結果不是錯誤才往呼叫者那一份日誌寫 `deliverables/presented`。 */
  readonly onResult: ToolResultListener;
}

/**
 * 造 `present` 的工具與它的 `tools/result` 觀察者。**兩者共用同一張等結果的表**（閉包裡，每次呼叫一張，不在模組層級）。
 *
 * 樹上的 `apply` 與相容層的舊外殼（`apps/harness/src/present.fixture.ts`，給還沒上樹的測試用）都走這裡，所以行為只有一個出處。
 *
 * @param maxFiles - 一次最多幾個檔。
 * @param lookups - 會話與 fs 的查找（呼叫當下才問）。
 */
export function createPresentDelivery(maxFiles: number, lookups: PresentLookups): PresentDelivery {
  /**
   * 等 `tools/result` 的交付，依「thread＋呼叫者是誰＋`callId`」。見檔頭。
   *
   * **日誌是弱引用**（[#1484](https://github.com/DemianLi/nexus-agent/issues/1484)）：一次呼叫通常在 `onResult` 就取走了這一筆，但呼叫在結果出來之前被打斷
   * （中止、整條 thread 收掉）時這一筆會留下。閒置逐出之後 thread 從行程裡撤掉，留下的那一筆如果強引用日誌，整份日誌就被這張表
   * 釘在記憶體裡、逐出白做。弱引用讓日誌隨 thread 一起可回收；`onResult` 取不回日誌（已回收）就丟掉這一筆，等同重啟後這張表是空的。
   * 插件不必知道 thread 何時被撤——日誌不可達，這一筆就沒有東西可寫；新的 thread 有自己的日誌，碰不到舊的這一筆。
   * 日誌回收了的殘留鍵在下一次 `set` 時順手清掉，表不會無限長。
   */
  const pending = new Map<
    string,
    { readonly log: WeakRef<SessionLog>; readonly files: PresentedFile[] }
  >();
  const presentTool = tool(
    async (
      { files: requested }: { files: { path: string; description?: string }[] },
      config?: unknown,
    ) => {
      const callId = toolCallIdOf(config);
      const refuse = (message: string, error?: { name: string; code: string }) =>
        toolRefusal(message, {
          callId: callId ?? '',
          name: PRESENT_TOOL_NAME,
          ...(error !== undefined && { error }),
        });
      // 檢查的順序照 dsh 的 `execute`：先要有會話，再看檔數、工作區，最後逐個看路徑。
      // 會話查找回 `ambiguous`／`unknown-caller` 也一律是這一句（Q6，逐字不變）。
      const found = lookups.sessions(config);
      if (callId === undefined || found.kind !== 'ok') {
        return refuse(PRESENT_NO_SESSION_MESSAGE);
      }
      if (requested.length === 0 || requested.length > maxFiles) {
        return refuse(presentCountMessage(maxFiles));
      }
      // **被叫時才讀**：fs 把手的值要等 fold 折完才有。有沒有工作區與不在磁碟上的前綴（組裝點交的加上 plugin 掛的路由）
      // 都從這一格把手讀（#1469 Q2 (a)），不在別處再算。查找失敗與「沒有工作區」同一句。
      const located = lookups.fs(config);
      const handle = located.kind === 'ok' ? located.fs : undefined;
      const backend = handle?.backend();
      if (handle === undefined || !handle.hasWorkspace() || backend === undefined) {
        return refuse(PRESENT_NO_WORKSPACE_MESSAGE);
      }
      const offWorkspace = handle.offWorkspacePrefixes();
      const files: PresentedFile[] = [];
      for (const file of requested) {
        if (file.path.trim().length === 0) return refuse(PRESENT_EMPTY_PATH_MESSAGE);
        if (isUnderAnyPrefix(virtualPathOf(file.path), offWorkspace)) {
          return refuse(presentOffWorkspaceMessage(file.path));
        }
        const kind = await inspect(backend, file.path);
        if (kind === 'missing') return refuse(presentNotFoundMessage(file.path), NOT_FOUND);
        if (kind === 'not-file') return refuse(presentNotFileMessage(file.path));
        // `description` 沒給就整個不放 key：日誌收不下 `undefined`。
        files.push({
          path: file.path,
          ...(file.description !== undefined && { description: file.description }),
        });
      }
      for (const [key, entry] of pending) {
        if (entry.log.deref() === undefined) pending.delete(key);
      }
      pending.set(pendingKey(callThreadId(config), toolCallSessionAddress(config), callId), {
        log: new WeakRef(found.log),
        files,
      });
      return presentedText(files);
    },
    {
      name: PRESENT_TOOL_NAME,
      description: PRESENT_TOOL_DESCRIPTION,
      schema: z.object({
        files: z
          .array(
            z
              .object({
                path: z
                  .string()
                  .describe(
                    'Path of an existing regular file. Relative paths use the Session working directory.',
                  ),
                description: z.string().optional().describe('Brief description for the user.'),
              })
              // 照 dsh 的 `additionalProperties: false`：落庫的要等於模型以為它寫的。
              .strict(),
          )
          // 照 dsh：4 是建議的每次個數，`maxFiles` 才是真的會拒的上限，兩者不是同一件事。
          .describe('Usually the 1-2 most important deliverables; at most 4 per call.'),
      }),
    },
  );
  const onResult: ToolResultListener = (exec, result) => {
    const key = pendingKey(exec.thread, exec.agent, exec.callId);
    const entry = pending.get(key);
    if (entry === undefined) return;
    pending.delete(key);
    if (result.isError) return;
    // 日誌已經被回收（thread 被撤、記憶體裡沒有它了）就沒有東西可寫，見 `pending` 的說明。
    const log = entry.log.deref();
    if (log === undefined) return;
    // 同步寫，照 dsh：`tools/result` 由圍堵在記 `tool/result` 之前派發，所以交付先、結果後。見檔頭。
    log.append('deliverables/presented', { callId: exec.callId, files: entry.files });
  };
  return { tool: presentTool, onResult };
}

export const name = 'present';

/**
 * 要的服務：`tools`（`^1.3.0`，要 `onResult`）、`sessionLookup`（`^1.0.0`）與 `fs`（`^2.0.0`，要 `hasWorkspace()` 與併了 mounts 的
 * `offWorkspacePrefixes()`）。範圍在這裡宣告，落進 Cordis 的 `Context.intercept`，提供者的 `check` 讀得到。
 */
export const inject = injectOf(
  need(toolsToken, '^1.3.0'),
  need(sessionLookupToken, '^1.0.0'),
  need(fsToken, '^2.0.0'),
);

/** 這個插件的設定（manifest 的 `config`）：見 {@link presentConfigSchema}。`strictObject`：未知欄位讓載入失敗。 */
export const Config = presentConfigSchema;

export const manifest = defineManifest({
  id: 'present',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [],
  consumes: [
    { token: toolsToken.name, range: '^1.3.0' },
    { token: sessionLookupToken.name, range: '^1.0.0' },
    { token: fsToken.name, range: '^2.0.0' },
  ],
  config: Config,
  // 換程式碼要重啟行程；設定（`maxFiles`）只給新的 thread（#1405、決議 §3-2 第 6 條：組 thread 時取快照）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 掛上：把 `present` 登記進行程級的工具登記處，並登記等 `tools/result` 的觀察者。
 *
 * **三個服務都在這裡抓進閉包**，列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫（見檔頭）。**呼叫當下才 `forCall`**。
 * 提供者沒有 `onResult`（契約低於 `1.3.0`）就拒絕起來：不讓它靜靜不交付。
 *
 * @param ctx - 這一列的 Cordis context。
 * @param config - 驗過的設定。
 */
export function apply(ctx: Context, config: PresentConfig): void {
  const tools = service(ctx, toolsToken);
  if (tools.onResult === undefined) {
    throw new Error(
      'present 需要 tools 服務的 onResult（契約 1.3.0 起）；這個提供者沒有它，交付會靜靜不寫進日誌，所以拒絕掛載',
    );
  }
  const sessions = service(ctx, sessionLookupToken);
  const fs = service(ctx, fsToken);
  const delivery = createPresentDelivery(config.maxFiles, {
    sessions: (invocation) => sessions.forCall(invocation),
    fs: (invocation) => fs.forCall(invocation),
  });
  tools.register(delivery.tool);
  tools.onResult(delivery.onResult);
}
