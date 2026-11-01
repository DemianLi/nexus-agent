/**
 * 加了路徑圍堵的 filesystem backend——**組裝點的 default backend**，不是 plugin。
 *
 * [#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 3 定「default backend 不走
 * plugin」，所以它住在 `apps/harness`。plugin 經 `registry.backend.mount()` 掛上的 backend
 * 由那個 plugin 自己負責圍堵，這裡管不到。
 *
 * ## 它補的是基座的一個實測破口
 *
 * `FilesystemBackend` 已經有 `virtualMode`，它的 `resolvePath()` 會擋掉 `..` 與 `~` 並檢查
 * 結果落在 `rootDir` 之下——**但那是純字串比對，不 canonicalize**。基座自己的註解就寫著
 * 「Virtual-mode path containment is lexical in resolvePath()」。實測（`contained-backend.test.ts`
 * 的第一組斷言，對著沒加工的 `FilesystemBackend` 跑）：
 *
 * | 操作 | 經 symlink 出去 |
 * | --- | --- |
 * | `write` | **寫穿了** |
 * | `edit` | **寫穿了** |
 * | `delete` | 被擋（基座的 `resolveDeletePath()` 會 lstat 逐層檢查祖先） |
 * | `read` | 讀穿了（`O_NOFOLLOW` 只管最後一段，祖先目錄的連結照跟） |
 *
 * 所以這個 class 要補的是 `write` 與 `edit`，以及讀（見下面〈讀取面的圍堵〉）。**`delete` 也一起覆寫**，理由不是基座那邊有錯，
 * 而是**拒絕的措辭要只有一種**：基座擋下來時說的是 `Symlink parent not allowed`，我們說的是
 * 另一句，同一條政策在模型眼裡就有兩套詞彙，測試也得斷言兩個字串。dsh 讓所有拒絕共用一個
 * `FS_SANDBOX_DENIED` 正是這個理由。
 *
 * ## `write` 與 `edit` 是暫存檔加 `rename` 的原子取代（[#1531](https://github.com/DemianLi/nexus-agent/issues/1531)）
 *
 * 基座的兩條寫入路都是 `O_TRUNC` 就地覆寫：寫到一半被 `kill -9`、斷電、磁碟寫滿，使用者打開的是截斷的檔；平行的 `edit`
 * 後寫蓋掉先寫；工作區裡指向根外的硬連結被寫穿。所以這兩個方法**過完 fence 就自己做完**（`super.write`／`super.edit`
 * 會 `O_TRUNC`，不能前後包一層）：同目錄 `0700` 暫存目錄、`wx` `0600` 暫存檔、`sync`、補回原檔 mode、`rename`；
 * 整段（`edit` 連讀與替換）在以 canonical 路徑為鍵的**行程層級**逐目標鎖裡。實作與 dsh 出處、偏離 1（不做
 * `createIfAbsent` 的 hard link 發佈，理由 1）與偏離 2（不做 Windows，理由 2）見 `atomic-workspace-write.ts`。
 * 路徑仍走基座的 `resolvePath`（字面檢查 `..`、`~`、跑出根）：`danger-full-access` 下 `verdict` 不檢查，那是唯一一道。
 * 結果形狀與錯誤字句照基座，`edit` 的字串替換逐字照抄 `performStringReplacement`；唯一不同的一句是寫到目錄上，
 * 基座是 `EISDIR` 的開檔錯誤，這裡是 `not a regular file`（卡上第 2 步的字句）；另外 errno 的訊息不帶主機路徑（{@link pathlessReason}）。
 *
 * ## `read` 自己讀一次、大檔串流（[#1530](https://github.com/DemianLi/nexus-agent/issues/1530)）
 *
 * 基座的 `read` 整份讀進來、整份 `split`，`read_file` 之外的「先讀後改」再 `readRaw` 一次，一個 191 MB 的檔在一次工具呼叫裡
 * 變成好幾份常駐的字串；單行 3 MB 的檔也整行送出。所以 `read` 也**自己做完**（不 `super.read`）：開檔後用同一個 fd 的 `stat` 定路由，
 * 小於 {@link READ_STREAM_MIN_SIZE}（同 dsh 的 `STREAM_MIN_SIZE`）一次 `readFile`，否則逐 chunk 解碼掃描；兩條路交給同一支
 * `scanWindow`。**在 `read_file` 裡**照 dsh 的 `buildWindow` 建頁（每行截 2000 字元、選到的行累計 50 KiB 停但掃到檔尾數總行數），
 * 並把頁的範圍與同一個 fd 的 stat 版本回報給 `@nexus/core`（#2030）；**不在 `read_file` 裡**的呼叫維持基座的切片語意。判二進位看內容、
 * 不看副檔名（撤掉 #642 的副檔名偏離，見 `binary-read.ts`）。**偏離 2（縮到只剩 BOM，理由 1 基座表達不出來）**：開頭的 BOM 保留，不照 dsh 去掉——
 * `edit` 沿用同一個解碼（`ignoreBOM`），寫回時 BOM 自然還在（dsh 的 `decodeUtf8` 沒設 `ignoreBOM`，寫回時 BOM 會消失）。行尾 `\r` 則照 dsh 去掉（[#1563](https://github.com/DemianLi/nexus-agent/issues/1563)
 * N0335：`edit` 現在對行尾做正規化，保留 `\r` 的理由沒了），只在 `read_file` 裡。
 *
 * 另一個會改檔案的方法是 **`uploadFiles`**——`BackendProtocolV2` 上的，覆蓋面漏掉它
 * 就有一條繞得過 fence 的路（PR #62 的 review 實測，經 symlink 寫穿到根外）。
 *
 * ## 讀取面的圍堵（[#1982](https://github.com/DemianLi/nexus-agent/issues/1982)）
 *
 * 讀得到內容的六個入口——`read`、`readRaw`、`ls`、`grep`／`glob` 的起點、`downloadFiles`——讀之前都 canonicalize，
 * 落在根外就拒，碼同樣是 `FS_SANDBOX_DENIED`。擋的是工作區裡往外指的符號連結：連結指向 harness home 或 `.env` 時，
 * 經它讀得到 key。`grep`／`glob` 從根往下搜時 rg 本來就不跟樹內的連結，所以只看起點，根內的連結也搜不到（#2193）。判法與例外見 `readDenial`。
 * 讀能看到什麼的其餘策略仍歸 `permissions`。
 *
 * ## 形狀照 dsh 的 `fs-sandbox`
 *
 * [#34](https://github.com/DemianLi/nexus-agent/issues/34) 的定案，逐條對應
 * （`references/deepseek-harness/packages/fs/fs-sandbox/`）：**繼承**而不是平行實作、
 * 變更的 fence 只掛在寫入路徑、canonicalize-then-contain 且在委派前重新
 * canonicalize、三個 mode 留一個不設防的逃生口。
 *
 * ## 威脅模型：這是 policy fence，不是 kernel boundary
 *
 * 照抄 dsh 的誠實標準：這是**信任的程式碼**對一條**模型控制的路徑**做檢查，操作本身
 * （open、rename）是我們自己的，只有目標路徑不可信，所以 canonicalize-then-contain 對
 * 這個面向是完整的答案。這是 containment，不是 security boundary。殘留的 TOCTOU
 * （檢查與 syscall 之間祖先 symlink 被抽換）被接受——核心級的隔離是 shell sandbox 的事
 * （`feat/sandbox-plugin`）。
 *
 * **我們的 TOCTOU 窗口比 dsh 寬一點，這件事要說明白。** dsh 的 `checkedTarget()` 回傳
 * 那個新鮮的 canonical target，變更就用**它**去寫，所以檢查的與寫入的是同一個身分。我們
 * 做不到同一件事（`delete`／`uploadFiles` 仍如此；`write`／`edit` 自己做完之後改走 `resolvePath`，見上）：`super.write()` 收的是**虛擬路徑**，它自己會再 `resolvePath()` 一次，
 * 傳一個 realpath 進去只會被當成虛擬路徑接到 `cwd` 底下。所以這裡回傳的是「canonical 之後
 * 再表達回去的虛擬路徑」——祖先的 symlink 已經被解掉，但基座那一次 lexical resolve 仍在
 * 我們的檢查之後發生。
 */

import { createHash } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { applyGrepMaxCount, FilesystemBackend } from 'deepagents';
import type {
  DeleteResult,
  EditResult,
  FileDownloadResponse,
  FileUploadResponse,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from 'deepagents';

import {
  currentReadWindow,
  currentToolCallSignal,
  EMPTY_CONTENT_WARNING,
  FILE_VERSION,
  FS_AMBIGUOUS_EDIT,
  FS_EDIT_NOT_FOUND,
  FS_NOT_FOUND,
  FS_NOT_REGULAR_FILE,
  FS_NOT_TEXT,
  FS_NO_SPACE,
  FS_PERMISSION_DENIED,
  noteFsError,
  noteReadVersion,
  noteReadWindow,
  noteSandboxDenial,
  noteSearchError,
  noteSearchSkipped,
  SEARCH_ABORTED,
  SEARCH_FAILED,
  SEARCH_INVALID_PATTERN,
} from '@nexus/core';
import { writeFileAtomic, withTargetLock } from './atomic-workspace-write.js';
import type { AtomicWriteInternals } from './atomic-workspace-write.js';
import { BINARY_SAMPLE_BYTES } from './binary-read.js';
import { canonicalize, isWithin } from './canonical-path.js';
import { resolveRgPath } from './rg-path.js';
import { runRipgrep } from './ripgrep-runner.js';
import type { RipgrepInternals, RipgrepTool } from './ripgrep-runner.js';
import { pageOf, scanWindow, ScanAborted } from './text-window.js';
import { NotUtf8, streamUtf8 } from './utf8-stream.js';
import type {
  FileVersionLookup,
  FsErrorCode,
  SandboxDenial,
  SearchErrorCode,
  SandboxGrantLedger,
  SandboxMode,
  SandboxModeSource,
} from '@nexus/core';

/**
 * fence 擋下了一次變更：回報給正在跑的那一次工具呼叫，讓結果帶上 `FS_SANDBOX_DENIED`
 * （[#293](https://github.com/DemianLi/nexus-agent/issues/293)，見 `@nexus/core` 的 `fs-tool-errors.ts`）。
 * 這一層不改字——回的仍是同一個結果；模型看到的 `Error: ` 由 `fs-tool-errors.ts` 補
 * （[#318](https://github.com/DemianLi/nexus-agent/issues/318)）。
 */
function denied<T extends { error: string }>(result: T): T {
  noteSandboxDenial();
  return result;
}

/** 讀檔碰到不是文字的檔。字句同基座 `notTextReason` 時代的：`cannot read "<路徑>": <原因>`；碼 `FS_NOT_TEXT`（#1563）。 */
function notText(filePath: string, reason: 'binary file' | 'invalid UTF-8 text'): ReadResult {
  noteFsError(FS_NOT_TEXT);
  return { error: `cannot read "${filePath}": ${reason}` };
}

/**
 * 作業系統的錯誤碼 → 檔案工具的原因碼（#1563），記在這一次工具呼叫上；錯誤文字不動。`EACCES`／`EPERM` 是 `FS_PERMISSION_DENIED`
 * （**依卡面要求，不是照 dsh**：dsh 只在 `listDirectory` 轉這個碼，`fsio.ts:282`，這裡 `read`／`write`／`edit` 碰到也記）；
 * `ENOENT`／`ENOTDIR` 是 `FS_NOT_FOUND`，但只有 `missing` 為真（呼叫端的目標本來就該存在：`read`、`edit`）時才算——`write` 會自己建父目錄，
 * 碰到它們是別的原因。`ENOSPC`／`EDQUOT` 是 `FS_NO_SPACE`。認不得的不記碼。
 */
function noteErrno(error: unknown, missing: boolean): void {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') noteFsError(FS_PERMISSION_DENIED);
  else if (code === 'ENOSPC' || code === 'EDQUOT') noteFsError(FS_NO_SPACE);
  else if (missing && (code === 'ENOENT' || code === 'ENOTDIR')) noteFsError(FS_NOT_FOUND);
}

/** 空間用完時交給模型的說明：重試沒用，要讓使用者知道找誰（#2195）。 */
const NO_SPACE_REASON =
  'the host is out of storage space; retrying will not help, tell the user to contact the administrator';

/**
 * 例外換成交給模型的原因（[#2201](https://github.com/DemianLi/nexus-agent/issues/2201)）。Node 的 errno 訊息結尾是 `, <syscall> '<主機路徑>'`，
 * 而模型的回覆使用者看得到，所以從 syscall 起整段不帶，留下碼與說明（`ENOSPC`／`EDQUOT` 的說明換成 {@link NO_SPACE_REASON}）；呼叫端的句子已經寫了模型給的虛擬路徑。
 * 沒有 errno 形狀的錯誤原樣回，訊息裡的根由 {@link ContainedFilesystemBackend} 再換掉。
 *
 * @param error - 接到的例外。
 * @returns 不含 errno 路徑的原因。
 */
export function pathlessReason(error: unknown): string {
  const { code, syscall, message } = error as NodeJS.ErrnoException;
  if (typeof code !== 'string' || typeof syscall !== 'string') return message;
  if (code === 'ENOSPC' || code === 'EDQUOT') return `${code}: ${NO_SPACE_REASON}`;
  const end = message.indexOf(`, ${syscall}`);
  return end === -1 ? code : message.slice(0, end);
}

/** 整份位元組 fatal 解碼；開頭的 BOM 留著（偏離 2，理由見檔頭）。 */
function decodeWhole(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new NotUtf8();
  }
}

/**
 * 搜尋失敗：替這一次工具呼叫記下碼，回帶 `error` 的結果。字句不以 `Error: ` 開頭，前綴由 `fs-tool-errors.ts` 補。
 */
function searchFailure(
  code: SearchErrorCode,
  message: string,
): { readonly error: string; readonly errorCode: SearchErrorCode } {
  noteSearchError(code);
  return { error: message, errorCode: code };
}

/** dsh `GLOB_VCS_EXCLUDES`（`glob.ts:21-107`，`687f282e`）：版本控制的中繼目錄，`glob` 一律不列。 */
const GLOB_VCS_EXCLUDES: readonly string[] = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];

/**
 * `relative(cwd, …)` 的結果跑出根了嗎？照 dsh `toWorkdirRelative`：只有 `..` 本身與 `..` 加分隔符開頭才算。
 * 不能用 `startsWith('..')`——檔名 `..foo` 的相對路徑就是 `..foo`，會被誤判成根外而整個漏掉。
 */
function escapesRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`);
}

/** 一次 `lstat` 同時最多幾支：結果可以有幾萬筆，一次全丟出去會撞檔案描述元上限。 */
const GLOB_LSTAT_BATCH = 64;

/**
 * 驗 `grep` 的檔案篩選（dsh 叫 `include`，基座的參數叫 `glob`）。照 dsh `validateInclude`（`grep.ts:24-116`，`687f282e`）：
 * 只收**單一正向 glob**——空字串、`!` 開頭、大括號外的逗號清單都拒絕；`*.{ts,tsx}` 的逗號在括號內，是同一個 glob 的選擇，放行。
 *
 * **偏離 dsh 的只有載體**：dsh 在工具參數驗證丟一般 `Error`，這裡的工具是基座的、驗證點只能在 backend，所以回
 * `SEARCH_INVALID_PATTERN`（卡面指定的碼，#1605）。字句照 dsh，把 `include` 換成基座工具實際的參數名 `glob`。
 *
 * @returns 不合格時的訊息；合格是 `undefined`。
 */
export function invalidGrepGlob(glob: string): string | undefined {
  if (glob.trim().length === 0) return 'glob must be a non-empty glob when given';
  if (glob.startsWith('!')) {
    return 'glob must be a positive glob filter; negated patterns ("!…") are not supported';
  }
  let braceDepth = 0;
  for (const char of glob) {
    if (char === '{') braceDepth++;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (char === ',' && braceDepth === 0) {
      return 'glob must be one glob, not a comma-separated list (use {a,b} alternation instead)';
    }
  }
  return undefined;
}

/**
 * {@link ContainedFilesystemBackend.grepPaths} 的結果：多一格 `errorCode`，給子類分辨「該不該把錯誤原文交給模型」
 * （附件路由只換 `SEARCH_FAILED`／`SEARCH_INVALID_PATTERN`，#1822）。**不經公開的 `grep` 出去**，`grep` 把它剝掉。
 */
export type GrepPathsResult = GrepResult & { readonly errorCode?: SearchErrorCode };

/** {@link ContainedFilesystemBackend.globPaths} 的結果：`GlobResult` 多一格 `errorCode`，給子類分辨該不該把錯誤原文交給模型。 */
export type GlobPathsResult = GlobResult & { readonly errorCode?: SearchErrorCode };

/**
 * 圍堵的強度。名字照抄 dsh 的三個 mode（`references/deepseek-harness/packages/fs/fs-sandbox/README.md`）。
 *
 * `read-only` 只擋得住**變更**：「read-only」講的是這個 backend 不改東西，不是「這個 agent 看不到東西」。
 * 讀在 `read-only` 與 `workspace-write` 下一樣，只擋經符號連結落到根外的（檔頭〈讀取面的圍堵〉）；
 * 其餘看不看得到歸 `permissions`。
 *
 * **`read-only` 的根上，組裝點預設的摘要器照樣留得住對話歷史**
 * （[#348](https://github.com/DemianLi/nexus-agent/issues/348) 之後）。長對話會觸發基座的
 * summarization，它把舊訊息 offload 到 `/conversation_history`；`agent-factory.ts` 的
 * `withConversationHistory` 把那個前綴路由到 graph state，所以那次寫入不經過這個 backend，
 * 也不被 fence 擋。
 *
 * **#348 之前不是這樣**，而那個形狀仍在基座裡：`read-only` 擋掉那次寫入，而基座對 offload
 * 失敗是 **fail-open** —— 摘要照生、舊訊息照換掉、完整歷史沒留下副本，只有一行 `console.warn`
 * （[#66](https://github.com/DemianLi/nexus-agent/issues/66)）。自己帶 backend 的摘要器（下面那段）
 * 與自訂的 `historyPathPrefix` 不走那條路由，碰得到它。
 *
 * 「組裝期擋下 `read-only` ＋ 長對話」這個選項**在結構上不可行**：summarization 是被無條件
 * 加進 stack 的，那個組合就是**每一個** `read-only` 組裝，擋掉它等於禁用這個 mode 本身。
 *
 * **要在唯讀的根上留住歷史，把摘要器的 backend 指到別處** —— `createSummarizationMiddleware`
 * 的 `backend` 是獨立的一格，不必是 agent 的那個：
 *
 * ```ts
 * registry.middleware.use(
 *   createSummarizationMiddleware({
 *     backend: new ContainedFilesystemBackend({ rootDir: historyDir, mode: 'workspace-write' }),
 *   }),
 * );
 * ```
 *
 * 代價是走這條就得自己建摘要器，等於接管 `trigger` / `keep` 的預設值 —— 同名取代是唯一的
 * 設定入口，而它是全有全無的。行為驗收見 [`summarization.test.ts`](./summarization.test.ts)。
 *
 * **這一顆只到 root。** 其他 plugin middleware 會攤進每個子代理，這一顆刻意不攤（[#327](https://github.com/DemianLi/nexus-agent/issues/327)，
 * `@nexus/core` `fold.ts` 的 `subagentPluginMiddleware`）：它是一份實例，攤過去 root 與子代理的歷史會混進同一個檔。
 * 子代理照舊用 fold 替它各建的那份，歷史寫在那一份的 backend 上。
 *
 * **同型的第二件事沒有被接受，它被修掉了（[#170](https://github.com/DemianLi/nexus-agent/issues/170)）。**
 * 基座還會把超過 80,000 字元的工具結果 `write` 到 `/large_tool_results/`，而**那一條的
 * fail-open 是丟資料**：寫不進去時它把訊息換成一句「存不進去」，模型剛要到手的東西整個沒了
 * （不像歷史那件事，至少摘要還在）。修法是在組裝點把那個前綴路由到獨立的暫存 backend
 * （`agent-factory.ts` 的 `withToolResultStash`；[#734](https://github.com/DemianLi/nexus-agent/issues/734) 起優先存主機私有目錄，
 * 存不進去才退回 graph state），所以那次 write 不再經過這道 fence。
 * **上面那句「明著接受」只涵蓋對話歷史，不要擴大解釋。**
 *
 * **`danger-full-access` 比 dsh 的同名 mode 弱，這是一條偏離。** 它放行 symlink 逃逸，但
 * 基座那道 lexical 的 `..` 檢查仍在——這個 class 不給關 `virtualMode`（見下面的 class 註解），
 * 所以它結構上就不可能是 dsh 那種真正的不設防。想要完全不設防，用原生的 `FilesystemBackend`。
 */
export type { SandboxMode } from '@nexus/core';

/**
 * 三個模式的完整清單與它的守衛，**詞彙住在 `@nexus/core`**（`sandbox.ts`）。
 *
 * 搬過去的理由不是分層潔癖：`sandbox/mode` 這顆會話事件的酬載型別宣告在 core 的
 * `SessionEventMap` 上，而酬載帶的就是模式本身。留在這裡的話，「哪三個字串合法」寫入端
 * 與讀取端各有一份。從這個檔案 re-export 是為了讓 fence 的使用者仍然只需要認得一個門。
 */
export { isSandboxMode, SANDBOX_MODES } from '@nexus/core';

/**
 * fence 與政策之間的**合約**，詞彙同一條路：**住在 `@nexus/core`**（`sandbox.ts`）。
 *
 * 搬過去的理由與 {@link SandboxMode} 同型，只是對面換了人：實作 {@link SandboxGrantLedger}
 * 的是 `@nexus/plugin-sandbox-policy` 的 `SandboxModeController`，跟這道 fence 分屬兩個
 * 套件。合約放在其中一邊，另一邊就得反向依賴。dsh 也是這樣分的——基底套件
 * `@deepseek-ai/dsh-sandbox` 出詞彙**加上**升級協定，policy 與執行端各自依賴它。
 *
 * 從這個檔案 re-export 是為了讓 fence 的使用者仍然只需要認得一個門。
 */
export type {
  SandboxDenial,
  SandboxGrant,
  SandboxGrantLedger,
  SandboxModeSource,
} from '@nexus/core';

/**
 * 目標對得上 grant、但它綁的不是這一次時，接在拒絕後面的那一行。開頭同 fence 的其他話，
 * 用 `[containment]`。
 */
export const GRANT_MISMATCH_NOTE =
  '[containment] 這個檔有一顆核准過的升級，但它只蓋被擋下的那一次操作；' +
  '這一次的操作或內容跟那次不同，所以沒有用它。';

/** 認領 grant 的三種結局。 */
type GrantClaim =
  | { readonly kind: 'granted'; readonly mode: SandboxMode }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'none' };

/**
 * 一次變更的摘要。
 * @param operation - 操作名。
 * @param payload - 這一次變更除了路徑以外的參數，依方法簽章的順序。
 * @returns sha256 的十六進位字串。
 */
function digestOf(operation: string, payload: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([operation, ...payload]))
    .digest('hex');
}

/** 兩次被擋下的變更是不是同一次。 */
function sameDenial(bound: SandboxDenial | undefined, call: SandboxDenial): boolean {
  return bound !== undefined && bound.target === call.target && bound.digest === call.digest;
}

/**
 * 基座錯誤字句開頭的那個字。拆成常數是因為 `tool-error-prefix.test.ts` 釘住「字串裡寫 `Error: ` 的只有前綴的定義」；
 * 這裡要的是基座的字句逐字不變（不是 `TOOL_ERROR_PREFIX`），寫法同 `fs-tool-errors.ts` 的 `BASE_ERROR_WORD`。
 */
const BASE_ERROR_WORD = 'Error';

/** 行尾的寫法。 */
type LineEndings = 'LF' | 'CRLF';

/** `\r\n` 收成 `\n`；單獨的 `\r` 不動。照 dsh `normalizeLineEndings`（`fsio.ts:683`，`687f282e`）。 */
function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n');
}

/** 前 4096 個字元裡 `\r\n` 比單獨 `\n` 多就是 CRLF。照 dsh `detectLineEndings`（`fsio.ts:687`）。 */
function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096);
  const crlfCount = sample.split('\r\n').length - 1;
  const lfCount = sample.split('\n').length - 1 - crlfCount;
  return crlfCount > lfCount ? 'CRLF' : 'LF';
}

/** 把 LF 的內容還原成原檔的行尾；CRLF 先正規化再轉，已經是 `\r\n` 的不會變成 `\r\r\n`。照 dsh `restoreLineEndings`（`fsio.ts:702`）。 */
function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n');
}

/** 字串替換失敗：碼給 `tool/result`，字句給模型。 */
interface EditFailure {
  readonly code: FsErrorCode;
  readonly message: string;
}

/**
 * 字串替換。**錯誤字句逐字照抄基座的 `performStringReplacement`**（`deepagents` 沒有匯出）：模型看到的拒絕理由不因為這個 backend
 * 自己寫檔而換了一套話；`contained-backend.test.ts` 對著裸的 `FilesystemBackend` 釘住字句。**行尾照 dsh 的 `applyLiteralEdit`**
 * （`packages/fs/fs-local/src/fsio.ts:814-834`，`687f282e`，[#1563](https://github.com/DemianLi/nexus-agent/issues/1563) N0335）：
 * `content` 要已經正規化成 LF，`oldString`／`newString` 裡的 `\r\n` 在比對前收成 `\n`；字句裡回顯的仍是模型給的原字串。
 *
 * 碼的歸類照 dsh：`old_string` 是空的或找不到是 `FS_EDIT_NOT_FOUND`，命中好幾處又沒有 `replaceAll` 是 `FS_AMBIGUOUS_EDIT`。
 *
 * @returns 新內容（LF）與取代次數，或失敗。
 */
function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { readonly content: string; readonly occurrences: number } | EditFailure {
  const oldNorm = normalizeLineEndings(oldString);
  const newNorm = normalizeLineEndings(newString);
  // 空的 `old_string` 一律是 `FS_EDIT_NOT_FOUND`，連空檔也一樣（照 dsh `applyLiteralEdit`，`fsio.ts:820-823`；基座對空檔配空字串是直接寫入）。
  if (oldNorm === '') {
    return {
      code: FS_EDIT_NOT_FOUND,
      message:
        content === ''
          ? `${BASE_ERROR_WORD}: old_string must be a non-empty string`
          : `${BASE_ERROR_WORD}: oldString cannot be empty when file has content`,
    };
  }
  const occurrences = content.split(oldNorm).length - 1;
  if (occurrences === 0) {
    return {
      code: FS_EDIT_NOT_FOUND,
      message: `${BASE_ERROR_WORD}: String not found in file: '${oldString}'`,
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      code: FS_AMBIGUOUS_EDIT,
      message: `${BASE_ERROR_WORD}: String '${oldString}' has multiple occurrences (appears ${String(occurrences)} times) in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.`,
    };
  }
  return { content: content.split(oldNorm).join(newNorm), occurrences };
}

export interface ContainedFilesystemBackendOptions {
  /** 可寫根。所有虛擬路徑都以它為基準，變更不得 canonicalize 到它之外。 */
  readonly rootDir: string;
  /**
   * 圍堵強度。省略即 `workspace-write`——預設要是設防的那一個。
   *
   * 給**函式**就是逐次呼叫解析（見 {@link SandboxModeSource}）；給字面值等於給一個
   * 恆定的函式，兩者在 fence 眼裡沒有差別。
   */
  readonly mode?: SandboxMode | SandboxModeSource;
  /**
   * 起 `rg` 用哪個模式，省略就跟 {@link mode}。路由的 {@link mode} 是寫死的檔案政策，上不上 OS 沙箱卻要跟著會話：`danger-full-access`
   * 在沒有沙箱後端的主機上是唯一起得來的模式，搜 `/` 碰到路由時得走同一條退路。
   */
  readonly toolMode?: SandboxModeSource;
  /** 單檔大小上限，原樣轉給基座。 */
  readonly maxFileSizeMb?: number;
  /**
   * 升級的 grant 從哪裡認領（見 {@link SandboxGrantLedger}）。
   *
   * **省略就是沒有升級**：被擋就是被擋，拒絕後面不接指引。
   */
  readonly grants?: SandboxGrantLedger;
  /** 只給測試用：換 `rg` 執行檔名、數 spawn、壓低輸出上限（{@link RipgrepInternals}）。 */
  readonly ripgrep?: RipgrepInternals;
  /** 原子寫入的測試接縫（暫存名、檢查點、注入失敗），見 {@link AtomicWriteInternals}。正式組裝不給。 */
  readonly atomicInternals?: AtomicWriteInternals;
  /**
   * 讀檔：檔案大小**達到**這個位元組數就串流讀，邊讀邊掃，不整份留在記憶體；比它小的一次讀進來。預設 {@link READ_STREAM_MIN_SIZE}。
   * 名字與預設照 dsh 的 `readStreamMinSize`（`packages/fs/tool-fs/src/read.ts:21`、`index.ts:42`）。
   */
  readonly streamMinSize?: number;
  /**
   * 搜尋（`grep`／`glob`）時，起點底下有些路徑讀不到，其餘照常交出並註明數量（偏離 dsh，理由 2，[#1704](https://github.com/DemianLi/nexus-agent/issues/1704)）。
   * **預設 `false`＝ dsh 的做法（整次失敗）**：只有多人共用主機上的使用者工作區明確打開；暫存目錄是 serve 自己的目錄，附件路由的
   * 讀不到的檔屬於別的 thread（#1822），都不開。判準與起點讀不到的規則見 `ripgrep-runner.ts` 檔頭。
   */
  readonly tolerateUnreadable?: boolean;
  /**
   * 不論模式、也不認領升級都拒絕變更的地方（[#1960](https://github.com/DemianLi/nexus-agent/issues/1960)）。`write`、`edit`、`delete` 落在這裡的回
   * `[containment]` 拒絕，`uploadFiles` 回 `permission_denied`；四者都不認領 grant、不接升級指引：升級是這條 thread 的使用者核准的，這幾個地方影響的是別人的 thread。**逐次呼叫讀**，
   * 呼叫端可以在建構之後才知道清單。省略就沒有。
   */
  readonly reservedWrites?: () => readonly ReservedWrite[];
}

/** {@link ContainedFilesystemBackendOptions.reservedWrites} 的一格。 */
export interface ReservedWrite {
  /** 這個 backend 的虛擬路徑。 */
  readonly path: string;
  /** `true`：這個目錄本身與底下全部；`false`：只有這個路徑本身。 */
  readonly subtree: boolean;
  /** 拒絕訊息裡的理由。 */
  readonly reason: string;
}

/** 讀檔改用串流的檔案大小門檻（位元組）。同 dsh 的 `STREAM_MIN_SIZE`（`read.ts:21`）。 */
export const READ_STREAM_MIN_SIZE = 10 * 1024 * 1024;

/**
 * 讀取面的圍堵解析失敗時，交給下游處理的錯誤碼（見 `ContainedFilesystemBackend.readDenial`）。`ENOENT`／`ENOTDIR` 只會來自
 * `realpath(this.cwd)`，也就是根不存在（`canonicalize` 把這兩個碼當成還不存在的尾巴吞掉，不往外拋）；其餘三個是開檔走同一串路徑
 * 也會撞上的（這三個各有一條在真的檔案系統上做出來的測試，`contained-backend-read-resolve.test.ts`）。不在這裡的一律拒。
 */
const READ_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'ENOTDIR',
  'ELOOP',
  'EACCES',
  'ENAMETOOLONG',
]);

/** 讀取面的圍堵擋的入口，出現在拒絕訊息裡。 */
type ReadOperation = 'read' | 'readRaw' | 'ls' | 'downloadFiles' | RipgrepTool;

/** 讀取面的圍堵判完的結果：拒絕訊息，或比過根的實際位置。 */
interface ReadScope {
  readonly denial?: string;
  readonly realTarget?: string;
}

/** 讀檔被取消（使用者停止、工具逾時）時回的錯誤字句。 */
const READ_ABORTED = 'read aborted';

/**
 * 檔案的版本 token：`dev:ino:size:mtimeNs:ctimeNs`。不透明，消費端只比相等。同一個時間戳粒度內改成等長的內容認不出來。
 *
 * @param info - `bigint: true` 的 stat。
 */
function statVersion(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/**
 * 在寫入路徑與讀取面上加了 canonicalize-then-contain 的 `FilesystemBackend`。
 *
 * **一定是 `virtualMode: true`**，而且不給關。`virtualMode: false` 的語義是「絕對路徑原樣
 * 放行」，那個模式底下沒有「根」這回事，圍堵無從談起——留一個關得掉的開關只會讓
 * 「我以為它有防」變成可能。
 */
export class ContainedFilesystemBackend extends FilesystemBackend {
  /** 圍堵強度的來源。建構期給的字面值在這裡已經被包成一個恆定的函式。 */
  private readonly resolveMode: SandboxModeSource;

  /** 起 `rg` 用的模式，見 {@link ContainedFilesystemBackendOptions.toolMode}。 */
  private readonly resolveToolMode: SandboxModeSource;

  /** 升級的 grant 從哪裡認領；`undefined` 就是這道 fence 沒有升級。 */
  private readonly grants: SandboxGrantLedger | undefined;

  /**
   * 搜尋時起點底下有些路徑讀不到，要不要照樣交出其餘的結果（偏離 dsh，#1704，見 `ripgrep-runner.ts` 檔頭）。**預設 `false`
   * ＝ dsh 的做法**，只有多人共用主機上的工作區明確打開（`assembly-root.ts`）；讀不到的是搜尋起點本身時不論如何都判錯。
   */
  protected readonly tolerateUnreadable: boolean;

  /** 只給測試用的 `rg` 接縫；正式組裝是 `undefined`。 */
  private readonly ripgrepInternals: RipgrepInternals | undefined;
  /** 原子寫入的測試接縫；正式組裝是 `undefined`。 */
  private readonly atomicInternals: AtomicWriteInternals | undefined;
  /** 讀檔改串流的大小門檻。 */
  private readonly streamMinSize: number;
  /** 不論模式都拒絕變更的地方；`undefined` 就是沒有。 */
  private readonly reservedWrites: (() => readonly ReservedWrite[]) | undefined;

  /**
   * 這一刻的圍堵強度，錯誤訊息會指名它。
   *
   * **每次讀都重新解析**——它不是一個快照。要在一次呼叫裡反覆用的話先存進區域變數
   * （`checkedPath()` 就是這麼做的），理由見 {@link SandboxModeSource}。
   */
  get mode(): SandboxMode {
    return this.resolveMode();
  }

  constructor(options: ContainedFilesystemBackendOptions) {
    super({
      rootDir: options.rootDir,
      virtualMode: true,
      ...(options.maxFileSizeMb !== undefined && { maxFileSizeMb: options.maxFileSizeMb }),
    });
    const mode = options.mode ?? 'workspace-write';
    this.resolveMode = typeof mode === 'function' ? mode : (): SandboxMode => mode;
    this.resolveToolMode = options.toolMode ?? this.resolveMode;
    this.grants = options.grants;
    this.ripgrepInternals = options.ripgrep;
    this.tolerateUnreadable = options.tolerateUnreadable === true;
    this.atomicInternals = options.atomicInternals;
    this.streamMinSize = options.streamMinSize ?? READ_STREAM_MIN_SIZE;
    this.reservedWrites = options.reservedWrites;
  }

  /**
   * 讀檔（[#1530](https://github.com/DemianLi/nexus-agent/issues/1530)）：**自己讀，只讀一次**，不再先 `super.read` 整份、
   * 再讀一次原始位元組判二進位，也不再讓「先讀後改」為了記版本整份 `readRaw`。
   *
   * 開檔之前先過讀取面的圍堵（{@link readScope}）：經符號連結落在根外的回 `[containment]` 拒絕，碼 `FS_SANDBOX_DENIED`。
   * 根內的連結讀得到：開的是比過根的那個實際位置，只解析這一次；它之後被換成連結，`O_NOFOLLOW` 回 `ELOOP`
   * （[#2193](https://github.com/DemianLi/nexus-agent/issues/2193)）。
   *
   * 其餘路徑與錯誤字句照基座（`FilesystemBackend.read`）：路徑走基座的 `resolvePath`（字面檢查 `..`、`~`、跑出根），不是一般檔回
   * `File '…' not found`，用 `O_RDONLY|O_NOFOLLOW` 開檔，其餘例外回 `Error reading file '…': …`。
   * 判二進位照 dsh（`fsio.ts` 的 `readWholeText`／`streamWholeText`）：前 {@link BINARY_SAMPLE_BYTES} 位元組有 NUL 是
   * `binary file`，fatal 解碼失敗是 `invalid UTF-8 text`；**看內容，不看副檔名**（撤掉 #642 的副檔名偏離，見 `binary-read.ts`）。
   *
   * **大小決定路由**：用開檔後同一個 fd 的 `stat`，`size` 小於 `streamMinSize` 就 `readFile` 一次，否則 `createReadStream` 逐 chunk
   * 解碼、掃描；兩條路交給同一支 {@link scanWindow}，判斷的與讀到的是同一個檔。
   *
   * **在 `read_file` 裡**（`currentReadWindow()` 有值）：照請求建頁——每行截到 2000 字元、選到的行累計 50 KiB 就停但掃到檔尾數總行數——
   * 並回報頁的範圍（`noteReadWindow`）與同一個 fd 的 stat 版本（`noteReadVersion`，給「先讀後改」，#2030）。**不在 `read_file` 裡**（摘要器、
   * `agent-instructions` 的 `discover`、直接呼叫）：語意照基座，回 `lines[offset, offset+limit)`，不截行、不套位元組上限。
   *
   * 取消：`currentToolCallSignal()` 接進讀取，中止時回 `{ error: 'read aborted' }`，不拋。
   *
   * **與 dsh 的偏離**：開頭的 BOM 不吃掉（偏離 2，理由 1，見檔頭與 `utf8-stream.ts`）；另外視窗經旁路回報，
   * 不經工具回傳值（偏離 1，見 `read-continuation.ts`）。
   *
   * @param filePath - 虛擬路徑。
   * @param offset - 從第幾行起（0 起算）。
   * @param limit - 最多幾行。
   * @returns 內容（`mimeType: 'text/plain'`，基座的工具才走文字那一支），或錯誤結果。
   */
  override async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    const signal = currentToolCallSignal();
    try {
      const resolved = this.resolveVirtual(filePath);
      const scope = await this.readScope(filePath, 'read');
      if (scope.denial !== undefined) return denied({ error: scope.denial });
      if (signal?.aborted === true) return { error: READ_ABORTED };
      const target = scope.realTarget ?? resolved;
      if (!(await stat(target)).isFile()) {
        noteFsError(FS_NOT_REGULAR_FILE);
        return { error: `File '${filePath}' not found` };
      }
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        return await this.readOpened(handle, filePath, offset, limit, signal);
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if (error instanceof ScanAborted || signal?.aborted === true) return { error: READ_ABORTED };
      if (error instanceof NotUtf8) return notText(filePath, 'invalid UTF-8 text');
      noteErrno(error, true);
      return { error: `Error reading file '${filePath}': ${await this.reasonFor(error)}` };
    }
  }

  /** {@link read} 開好檔之後的那一半：判文字、掃描、組結果。 */
  private async readOpened(
    handle: FileHandle,
    filePath: string,
    offset: number,
    limit: number,
    signal: AbortSignal | undefined,
  ): Promise<ReadResult> {
    const info = await handle.stat({ bigint: true });
    const window = currentReadWindow();
    // `read_file` 裡行尾的 `\r` 去掉（照 dsh，#1563 N0335）；其餘呼叫維持基座的切片語意。
    const params = window
      ? {
          offset: window.offset,
          limit: window.limit,
          maxLineLength: window.maxLineLength,
          maxBytes: window.maxBytes,
          stripCarriageReturn: true,
        }
      : {
          offset: Math.max(0, Math.trunc(offset)),
          limit: Math.max(0, Math.trunc(limit)),
          maxLineLength: Infinity,
          maxBytes: Infinity,
        };
    const options = signal === undefined ? {} : { signal };
    let scan;
    // 部署設定給了串流門檻（`tool-fs` 的 `readStreamMinSize`，#1605）就用它，沒給用建構子選項（預設 `READ_STREAM_MIN_SIZE`）。
    if (Number(info.size) < (window?.streamMinSize ?? this.streamMinSize)) {
      const bytes = await handle.readFile(signal === undefined ? undefined : { signal });
      if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0))
        return notText(filePath, 'binary file');
      const decoded = decodeWhole(bytes);
      scan = await scanWindow([decoded], params, options);
    } else {
      const sample = Buffer.alloc(BINARY_SAMPLE_BYTES);
      const { bytesRead } = await handle.read(sample, 0, BINARY_SAMPLE_BYTES, 0);
      if (sample.subarray(0, bytesRead).includes(0)) return notText(filePath, 'binary file');
      // 不把 signal 交給串流：串流自己在中止時 destroy(AbortError)，而 scanWindow 已經在每個 chunk 之間看 signal 並收手，
      // 兩邊搶著收會留下沒人接的 'error' 事件。
      const source = handle.createReadStream({ start: 0, autoClose: false });
      scan = await scanWindow(streamUtf8(source, { ignoreBOM: true }), params, options);
    }
    const page = pageOf(scan, params);
    if (page.kind === 'blank') return { content: EMPTY_CONTENT_WARNING, mimeType: 'text/plain' };
    if (page.kind === 'beyond') {
      return {
        error: `Line offset ${params.offset} exceeds file length (${page.splitLength} lines)`,
      };
    }
    if (window !== undefined) {
      noteReadWindow(page.extent, scan.lines);
      noteReadVersion(statVersion(info));
    }
    return { content: page.content, mimeType: 'text/plain' };
  }

  /**
   * 原始內容（`submit_record`、工具結果的中繼資料，以及先讀後改拿不到 stat 版本時走這支）。先過讀取面的圍堵（{@link readDenial}），其餘照基座。
   *
   * @param filePath - 虛擬路徑。
   * @returns 基座的結果，或落在根外時的錯誤結果。
   */
  override async readRaw(filePath: string): Promise<ReadRawResult> {
    const refused = await this.readDenial(filePath, 'readRaw');
    return refused === undefined ? super.readRaw(filePath) : denied({ error: refused });
  }

  /**
   * 列目錄。先過讀取面的圍堵（{@link readDenial}），其餘照基座。
   *
   * @param dirPath - 虛擬路徑。
   * @returns 基座的結果，或落在根外時的錯誤結果。
   */
  override async ls(dirPath: string): Promise<LsResult> {
    const refused = await this.readDenial(dirPath, 'ls');
    return refused === undefined ? super.ls(dirPath) : denied({ error: refused });
  }

  /**
   * 批次下載（技能目錄經它讀 `SKILL.md`），每個檔各自過讀取面的圍堵（{@link readDenial}）。錯誤型別是四個碼的 union，
   * 跟 {@link uploadFiles} 一樣，落在根外的回 `permission_denied`。
   *
   * @param paths - 虛擬路徑。
   * @returns 逐檔對應的結果，順序與輸入相同。
   */
  override async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = [];
    for (const filePath of paths) {
      if ((await this.readDenial(filePath, 'downloadFiles')) === undefined) {
        results.push(...(await super.downloadFiles([filePath])));
      } else {
        noteSandboxDenial();
        results.push({ path: filePath, content: null, error: 'permission_denied' });
      }
    }
    return results;
  }

  /**
   * 寫與改前比對用的版本，只做 `lstat`、不讀內容（[#2030](https://github.com/DemianLi/nexus-agent/issues/2030)）。token 跟 {@link read}
   * 回報的同一種（{@link statVersion}）。路徑是基座的 `resolvePath`，不解連結；不是一般檔（含最後一節是符號連結）回不存在。`lstat` 的錯原樣拋，observation 收成不存在，同它對 `readRaw` 拋錯的處理。
   *
   * @param filePath - 虛擬路徑。
   */
  async [FILE_VERSION](filePath: string): Promise<FileVersionLookup> {
    const info = await lstat(this.resolveVirtual(filePath), { bigint: true });
    return info.isFile() ? { kind: 'present', version: statVersion(info) } : { kind: 'absent' };
  }

  /**
   * 基座 `resolvePath` 的字面檢查（拒 `..`、`~`、跑出根）。它在 TS 上是 private，以型別斷言呼叫。
   *
   * **不要改成自己 `resolve(this.cwd, …)`**：`danger-full-access` 下 `verdict` 不檢查、原樣回傳路徑，
   * 今天擋住 `..`、`~` 與跑出根的只剩這一道。
   */
  protected resolveVirtual(virtualPath: string): string {
    return (this as unknown as { resolvePath(key: string): string }).resolvePath(virtualPath);
  }

  /**
   * 寫檔，先過 fence，**再經暫存檔加 `rename` 原子取代**（[#1531](https://github.com/DemianLi/nexus-agent/issues/1531)）。
   *
   * 基座的 `write` 是 `O_TRUNC` 就地覆寫，所以不能前後包一層，這裡自己做完：結果形狀與錯誤字句照基座
   * （成功 `{ path, filesUpdate: null }`，失敗 `{ error: "Error writing file '…': …" }`，symlink 的原句）。
   * **內容一律當 UTF-8 文字寫，不看副檔名**（[#1813](https://github.com/DemianLi/nexus-agent/issues/1813)，見下面的偏離）。整段在逐目標的鎖裡。
   *
   * **與 dsh 的偏離已撤銷：** 基座的 `write` 對非文字副檔名（圖、音、影、pdf、ppt）把內容當 base64 解碼成位元組再寫，工具描述沒講，模型寫的純文字落成亂碼
   * 還回「Successfully wrote」。dsh 沒有任何依副檔名的分支（`packages/fs/tool-fs/src/write.ts:75/:82/:124`：UTF-8 文字，`fs-local` 的
   * `writeFile(content, { encoding: 'utf8' })`），這裡照 dsh。要寫位元組的內部呼叫端走 `uploadFiles`（見下），不經過這支。
   *
   * @param filePath - 虛擬路徑。
   * @param content - 檔案內容。
   * @returns 寫入結果，或被 fence 擋下時的錯誤結果。
   */
  override async write(filePath: string, content: string): Promise<WriteResult> {
    const checked = await this.checkedPath(filePath, 'write', [content]);
    if (typeof checked !== 'string') return denied(checked);
    try {
      const resolved = this.resolveVirtual(checked);
      return await withTargetLock(await canonicalize(resolved), async () => {
        const existing = await lstat(resolved).catch(() => undefined);
        if (existing?.isSymbolicLink() === true) {
          return {
            error: `Cannot write to ${checked} because it is a symlink. Symlinks are not allowed.`,
          };
        }
        if (existing !== undefined && !existing.isFile()) {
          noteFsError(FS_NOT_REGULAR_FILE);
          return { error: `Error writing file '${checked}': not a regular file` };
        }
        await mkdir(dirname(resolved), { recursive: true });
        await writeFileAtomic(
          resolved,
          content,
          existing === undefined ? undefined : existing.mode & 0o777,
          this.atomicInternals,
        );
        return { path: checked, filesUpdate: null };
      });
    } catch (error: unknown) {
      noteErrno(error, false);
      return { error: `Error writing file '${checked}': ${await this.reasonFor(error)}` };
    }
  }

  /**
   * 編輯檔案，先過 fence，**自己讀、自己替換、經暫存檔加 `rename` 寫回**（[#1531](https://github.com/DemianLi/nexus-agent/issues/1531)）。
   *
   * 讀照基座（`stat` 判一般檔、`O_NOFOLLOW` 開），再照 dsh 的 `readForEdit`：含 NUL 或不是合法 UTF-8 的拒絕（`FS_NOT_TEXT`），行尾偵測後正規化成 LF
   * （[#1563](https://github.com/DemianLi/nexus-agent/issues/1563) N0335）。替換用 {@link applyLiteralEdit}（錯誤字句逐字照基座，`old_string`／
   * `new_string` 的 `\r\n` 也收成 `\n`），寫回前還原原檔的行尾；保留既有 mode。失敗的原因碼見 `fs-tool-errors.ts` 的 {@link noteFsError}。
   * **已知的界線（照 dsh）：** 混合行尾的檔以前 4096 個字元的多數為準，整份被統一成那一種。讀、替換、寫整段在逐目標的鎖裡，同一步的兩個平行 `edit` 不會丟修改。
   *
   * @param filePath - 虛擬路徑。
   * @param oldString - 要被換掉的字串。
   * @param newString - 換上去的字串。
   * @param replaceAll - 是否全部取代。
   * @returns 編輯結果，或被 fence 擋下時的錯誤結果。
   */
  override async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const checked = await this.checkedPath(filePath, 'edit', [
      oldString,
      newString,
      replaceAll === true,
    ]);
    if (typeof checked !== 'string') return denied(checked);
    try {
      const resolved = this.resolveVirtual(checked);
      return await withTargetLock(await canonicalize(resolved), async () => {
        if (!(await stat(resolved)).isFile()) {
          noteFsError(FS_NOT_REGULAR_FILE);
          return { error: `${BASE_ERROR_WORD}: File '${checked}' not found` };
        }
        let bytes: Uint8Array;
        let mode: number;
        const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          bytes = await handle.readFile();
          mode = (await handle.stat()).mode & 0o777;
        } finally {
          await handle.close();
        }
        // 二進位與壞掉的 UTF-8 不改：有損解碼再寫回會把原本的位元組換成 U+FFFD（照 dsh `readForEdit`，`fsio.ts:725-736`）。
        // **NUL 掃整份**，不像讀檔那條取樣前 {@link BINARY_SAMPLE_BYTES}（dsh `fsio.ts:733` 是 `buffer.includes(0)`；取樣是 `read` 的 `fsio.ts:396`）：
        // 這裡整份本來就在記憶體裡，而且改錯的代價是把檔案寫壞。
        if (bytes.includes(0)) {
          noteFsError(FS_NOT_TEXT);
          return { error: `cannot edit "${checked}": binary file` };
        }
        const raw = decodeWhole(bytes);
        const lineEndings = detectLineEndings(raw);
        const result = applyLiteralEdit(
          normalizeLineEndings(raw),
          oldString,
          newString,
          replaceAll === true,
        );
        if ('code' in result) {
          noteFsError(result.code);
          return { error: result.message };
        }
        await this.atomicInternals?.afterEditRead?.(resolved);
        await writeFileAtomic(
          resolved,
          restoreLineEndings(result.content, lineEndings),
          mode,
          this.atomicInternals,
        );
        return { path: checked, filesUpdate: null, occurrences: result.occurrences };
      });
    } catch (error: unknown) {
      if (error instanceof NotUtf8) {
        noteFsError(FS_NOT_TEXT);
        return { error: `cannot edit "${checked}": invalid UTF-8 text` };
      }
      noteErrno(error, true);
      return { error: `Error editing file '${checked}': ${await this.reasonFor(error)}` };
    }
  }

  /**
   * 刪除，先過 fence。基座那端還有它自己的 symlink 祖先檢查，兩道都會跑——我們這道先。
   * @param filePath - 虛擬路徑。
   * @returns 基座的刪除結果，或被 fence 擋下時的錯誤結果。
   */
  override async delete(filePath: string): Promise<DeleteResult> {
    const checked = await this.checkedPath(filePath, 'delete', []);
    if (typeof checked !== 'string') return denied(checked);
    const result = await super.delete(checked);
    return result.error === undefined
      ? result
      : { ...result, error: await this.withoutRoot(result.error) };
  }

  /**
   * 批次上傳，每個檔案各自過 fence。
   *
   * **`BackendProtocolV2` 上第四個會改檔案的方法**，漏掉它整道 fence 就有一條繞得過去的路。
   * 基座自己的 summarization middleware 就在走它做 history offload（`offloadToBackend()`，
   * 用的是 `historyPathPrefix/<sessionId>.md` 這種設定路徑，模型控制不到），所以目前沒有
   * 「模型給任意路徑」的入口——但覆蓋面不該押在「剛好沒有工具把模型的路徑餵進來」上。
   *
   * 拒絕的措辭在這裡是唯一的例外：`FileUploadResponse.error` 的型別是四個錯誤碼的 union
   * （`FileOperationError`），塞不進 `denial()` 那句話，所以被擋下的檔案回 `permission_denied`。
   *
   * @param files - `[虛擬路徑, 內容]` 的批次。
   * @returns 逐檔對應的結果，順序與輸入相同；被 fence 擋下的那些回 `permission_denied`。
   */
  override async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const results = new Array<FileUploadResponse | undefined>(files.length);
    const allowed: Array<[string, Uint8Array]> = [];
    const allowedSlots: number[] = [];

    for (const [index, [filePath, content]] of files.entries()) {
      const checked = await this.checkedPath(filePath, 'uploadFiles', []);
      if (typeof checked === 'string') {
        allowed.push([checked, content]);
        allowedSlots.push(index);
      } else {
        results[index] = { path: filePath, error: 'permission_denied' };
      }
    }

    // 通過的那些一次委派出去，再按原本的位次放回——回傳順序要與輸入逐項對得上。
    if (allowed.length > 0) {
      const uploaded = await super.uploadFiles(allowed);
      for (const [slot, response] of uploaded.entries()) {
        const index = allowedSlots[slot];
        if (index !== undefined) results[index] = response;
      }
    }

    return results.map(
      (result, index) =>
        result ?? { path: files[index]?.[0] ?? '', error: 'permission_denied' as const },
    );
  }

  /**
   * 搜尋檔案內容。**rg 由這裡自己起**（[#1532](https://github.com/DemianLi/nexus-agent/issues/1532)），照 dsh
   * `packages/fs/tool-fs-search/src/search-core.ts:222-287`（`687f282e`）：`--no-config`、`cwd` 是工作區根、stdout 上限、
   * 取消與逾時、錯誤分類，細節在 `ripgrep-runner.ts`。
   *
   * **基座的做法有四個洞**（`deepagents@1.13.1`，`dist/src-C9o7b5C6.js:935-984`）：`spawn("rg", …)` 沒有 `--no-config`，
   * 所以管理者的 `~/.ripgreprc`、專案 `.env` 帶進來的 `RIPGREP_CONFIG_PATH` 能濾掉結果，`--pre` 還能讓 rg 對每個命中的檔
   * 執行任意程式；stdout 不設上限；沒有取消；結束碼不是 0／1、逾時、spawn 失敗一律改走結果不同的 `literalSearch`。
   * 帶目錄的 glob 回 0 筆那個缺陷（rg 的錨點是行程的工作目錄，不是工作區根）也是同一處：`cwd` 現在直接給工作區根，
   * glob 原樣以 `--glob` 傳下去，錨點語意同 dsh。
   *
   * 流程：解出搜尋的起點並 `stat`（不存在就 `{ matches: [] }`，同基座）→ 確認工作區根存在 → 跑 rg →
   * 解析 `--json`、換算虛擬路徑（邏輯照基座 `:951-978`）→ `maxCount` 截斷。失敗一律回 `{ error }`，並替這一次工具呼叫記下
   * 搜尋碼（`noteSearchError`），最後落進會話日誌那顆 `tool/result` 的 `error`。**不換成別的搜尋法。**
   *
   * rg 是 serve 直接起的子行程，spawn 之後登記進 `trackHostExitChild`（`ripgrep-runner.ts`）：serve 走 `process.exit` 結束而
   * rg 還在跑時由 core 同步 `SIGKILL`。**只殺直接子行程，不做 process group**——#1542 登記的偏離（理由 1：沒有 subprocess
   * 服務）同樣適用。
   *
   * ## 內附的 rg，沒有退路（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 4）
   *
   * 執行檔是 `rg-path.ts` 解出的**內附 rg 絕對路徑**（`@vscode/ripgrep` 的平台套件），直接交給 `runRipgrep`，**不前置進
   * `PATH`、不查 `PATH`**——管理者機器上有沒有 rg、是哪個版本，與這裡無關。內附的找不到或起不來是產物壞了，回
   * `SEARCH_FAILED`，**不改走基座的 `literalSearch`**：#1532 原本為「完全內網主機可能沒有 rg」暫留的 `ENOENT` 退路
   * （偏離 1）在這一張拿掉——它的前提是「我們和基座 spawn 的是同一支 `PATH` 上的 rg」，絕對路徑 `ENOENT` 時 `PATH` 上另一支
   * rg 會被基座以沒有 `--no-config` 的方式起來，注入就又打開了。啟動時 `serve` 會印出這一支的路徑或「不可用」（`rg-path.ts`
   * 的 `formatRipgrepDisclosure`）。
   *
   * ## 正規式，不是字面字串（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605)）
   *
   * 基座與 #1532 起 rg 時都帶 `-F`（字面字串）：`foo|bar`、`\bword\b` 全是 0 筆，模型會把 0 筆當成「沒有」。#1563 Q1 (a) 拍板照 dsh 改成
   * 正規式（`--regexp=`，rg 的語法），本卡接手 #1532 PR 內文那句「暫留，見 #1605 Q1」。不合法的正規式 rg 回 `regex parse error`，
   * 歸類成 `SEARCH_INVALID_PATTERN`（`ripgrep-runner.ts` 的 `classifyExit`）。檔案篩選（`glob`）先驗過：空字串、`!` 開頭、大括號外的
   * 逗號清單回 `SEARCH_INVALID_PATTERN`（{@link invalidGrepGlob}）。每行文字的截斷（dsh `previewLine`）在 `search-overflow.ts`，
   * 跟筆數上限同一對包裝，上限來自 `grepMaxLineBytes`。
   *
   * ## 與基座一樣的
   *
   * 筆數上限（`maxCount`）在解析之後才套用，截斷時照基座的形狀設 `truncated`。
   *
   * @param pattern - 要找的正規式（rg 語法）。
   * @param dirPath - 從哪個虛擬路徑開始找。
   * @param glob - 篩選檔案的 glob（單一正向 glob）；帶 `/` 時對工作區根錨定。
   * @param maxCount - 最多回幾筆。
   * @returns 搜尋結果；失敗時是帶 `error` 的結果。
   */
  override async grep(
    pattern: string,
    dirPath?: string,
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    const result = await this.grepPaths(pattern, [dirPath || '.'], glob, maxCount);
    return result.error === undefined ? result : { error: result.error };
  }

  /**
   * {@link grep} 的本體，**一次 rg 搜多個起點**（rg 吃多個路徑引數）。起點之間不存在的略過、全都不存在回 `{ matches: [] }`；
   * 其餘（`--no-config`、上限、取消、錯誤分類、`maxCount` 在解析之後才套）與單一起點完全一樣。
   * 給「要搜的是一堆分散的子目錄」的子類用，免得一個目錄起一次 rg（[#1782](https://github.com/DemianLi/nexus-agent/issues/1782)）。
   *
   * **偏離 dsh**（理由 2，登記在 `attachment-store.ts` 檔頭偏離 2）：dsh 的 `buildGrepCommand` 只收一個起點；多起點是附件路由
   * 「只搜這條 thread 引用過的目錄」那條偏離帶出來的，這裡不為別的用途開放。
   *
   * **呼叫端負責去重**：起點不能重複、也不能互相包含（`['/a', '/a']`、`['/', '/a']` 會讓同一份檔的命中出現兩次）。附件路由給的是
   * `Set` 裡互不重疊的第三層目錄，所以今天不會發生。
   *
   * **全部起點一次放進 argv，沒有分批**：作業系統的 argv 有長度上限，超過時 `spawn` 失敗，而這一層把 spawn 失敗一律說成
   * `grep could not start its search command (ripgrep launch failed)`——**那句話會讓人以為 rg 不見了，其實是起點太多**。
   * macOS 實測 1 萬個起點正常、2 萬個失敗；正式環境要一條 thread 引用上萬份附件才會碰到，所以不分批、只在這裡寫明。
   *
   * @param dirPaths - 起點的虛擬路徑。
   * @returns 搜尋結果；失敗時帶 `error` 與 `errorCode`（{@link GrepPathsResult}）。
   */
  protected async grepPaths(
    pattern: string,
    dirPaths: readonly string[],
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepPathsResult> {
    // 空 pattern 先擋（dsh `parseGrepArgs`，`grep.ts:90`）：`--regexp=` 會命中每一行。只有「空」才擋，空白字元本身是合法的正規式。
    if (pattern.length === 0) {
      return searchFailure(SEARCH_INVALID_PATTERN, 'pattern must be a non-empty string');
    }
    // 檔案篩選要先驗，再看根與起點：寫錯的篩選不該因為「根不存在」之類的前提被說成別的（`invalidGrepGlob`）。
    if (glob !== undefined && glob !== null) {
      const invalid = invalidGrepGlob(glob);
      if (invalid !== undefined) return searchFailure(SEARCH_INVALID_PATTERN, invalid);
    }
    const prepared = await this.prepareSearch('grep', dirPaths, false);
    if (prepared.kind === 'empty') return { matches: [] };
    if (prepared.kind === 'failed') return prepared.failure;
    const outcome = await runRipgrep({
      executable: prepared.executable,
      // **形式照 dsh `buildGrepCommand`**（`packages/fs/tool-fs-search/src/grep.ts:112`，`687f282e`）：pattern 與 glob 走
      // `--flag=value` 形式、起點放在 `--` 後面，模型給的值不可能被當成旗標（`-x` 開頭的 pattern 照樣是 pattern）。pattern 是
      // **正規式**（#1605，沒有 `-F`）。差別：dsh 是 `--json`、`--regexp=`、`--glob=`、（有 path 才）`--`＋一個 path；這裡是
      // `--json`、`--glob=`、`--regexp=`（glob 與 regexp 的順序相反，rg 不在意）、**一定帶 `--`**、起點多個且都有 `./` 前綴
      // （理由見 `existingSearchArgs`）。
      argv: [
        '--json',
        ...(glob !== undefined && glob !== null ? [`--glob=${glob}`] : []),
        `--regexp=${pattern}`,
        '--',
        ...prepared.searchArgs,
      ],
      cwd: this.cwd,
      mode: this.resolveToolMode(),
      signal: currentToolCallSignal(),
      ...(this.tolerateUnreadable && { tolerateUnreadable: { searchRoots: prepared.searchArgs } }),
      internals: this.ripgrepInternals,
    });
    if (outcome.kind === 'error') {
      return searchFailure(outcome.code, await this.withoutRoot(outcome.message));
    }
    const parsed = this.parseRipgrepJson(outcome.stdout);
    if (typeof parsed === 'string') {
      return searchFailure(
        SEARCH_FAILED,
        `grep received malformed ripgrep --json output (${parsed})`,
      );
    }
    noteSearchSkipped(outcome.unreadable);
    return applyGrepMaxCount({ result: { matches: parsed }, maxCount: maxCount ?? null });
  }

  /**
   * 列出符合 glob 的檔案。**rg 由這裡自己起**（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605)），共用 `grep` 的
   * 起法（`ripgrep-runner.ts`：不經 shell、`--no-config`、輸出上限、取消與逾時、錯誤分類），argv 照 dsh
   * `buildGlobCommand`（`packages/fs/tool-fs-search/src/glob.ts:89-92`，`687f282e`）：
   * `--files --glob=<pattern> --sort=modified --no-ignore --hidden`，再為 {@link GLOB_VCS_EXCLUDES} 每個名字各加兩條否定 glob
   * （一條剪掉目錄，一條在搜尋起點就在那個目錄裡面時排除內容），起點放在 `--` 後面。
   *
   * 基座的 `glob`（`dist/src-C9o7b5C6.js:1035-1082`）是 `fast-glob` 的 `dot: true`，不剪任何目錄，最後 `localeCompare` 照路徑排序：
   * 工作區裡有 git 倉庫時 `glob('**\/*')` 會把 `.git/objects` 整棵走過、佔滿上限；剛改過的檔也不會排在一起。
   *
   * ## 和基座不一樣的地方（外部可見，見升級指南）
   *
   * - **排序**：修改時間，舊的在前（rg `--sort=modified`）；基座是路徑字典序。
   * - **版本控制目錄不列**：`.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl`，任何深度。
   * - **pattern 是 rg 的 glob 語意**：沒有 `/` 的 pattern 比檔名、任何深度都對得上（`*.ts` 找整棵樹），帶 `/` 的對**工作區根**錨定
   *   （不是對 `path`）。基座的 `*.ts` 只比搜尋起點那一層。這是 dsh 的語意（`glob.ts` 工具描述），不是我們挑的。
   * - **symlink 不列**：rg 預設不跟 symlink，指向檔案的連結也不出現在結果裡；基座會列。
   * - 空白 pattern 回 `SEARCH_INVALID_PATTERN`：`--glob=` 空字串會讓 rg 列出全部（含 `.git`），dsh 同樣拒絕。
   *
   * ## 沒有 rg 就是錯誤，沒有退路
   *
   * 同 `grep`（#1502 刀 4）：內附 rg 找不到或起不來回 `SEARCH_FAILED`，**不退回 `super.glob`**。
   *
   * 每一筆 `lstat` 一次，補 `size`／`modified_at`（形狀同基座）；`lstat` 失敗（兩次呼叫之間被刪）或不是一般檔的略過。順序維持 rg 的輸出。
   * 筆數上限與外溢不在這裡（`search-overflow.ts` 包在外面）。
   *
   * @param pattern - glob；不可空白。
   * @param searchPath - 從哪個虛擬路徑開始找，預設工作區根；不存在或不是目錄回空結果（同基座）。
   * @returns 檔案清單（`is_dir: false`），失敗時是帶 `error` 的結果。
   */
  override async glob(pattern: string, searchPath = '/'): Promise<GlobResult> {
    return this.globPaths(pattern, [searchPath || '/']);
  }

  /**
   * {@link glob} 的本體，**一次 rg 列多個起點**；起點之間不存在或不是目錄的略過、全都略過回 `{ files: [] }`，其餘與單一起點完全一樣。
   * 給附件路由「只列這條 thread 引用過的目錄」用，條件與界限同 {@link grepPaths}：呼叫端負責去重、起點不能互相包含；起點一次全放進
   * argv、不分批。
   *
   * @param dirPaths - 起點的虛擬路徑。
   * @returns 檔案清單；失敗時帶 `error` 與 `errorCode`（{@link GlobPathsResult}）。
   */
  protected async globPaths(
    pattern: string,
    dirPaths: readonly string[],
  ): Promise<GlobPathsResult> {
    if (pattern.trim().length === 0) {
      return searchFailure(SEARCH_INVALID_PATTERN, 'glob pattern must be a non-empty string');
    }
    const prepared = await this.prepareSearch('glob', dirPaths, true);
    if (prepared.kind === 'empty') return { files: [] };
    if (prepared.kind === 'failed') return prepared.failure;
    const signal = currentToolCallSignal();
    const outcome = await runRipgrep({
      executable: prepared.executable,
      argv: [
        '--files',
        // 檔名可以含換行：用 NUL 分隔，不靠換行切（偏離 dsh 的只有這一個旗標，理由 2：工作區內容是不可信輸入）。
        '--null',
        `--glob=${pattern}`,
        '--sort=modified',
        '--no-ignore',
        '--hidden',
        ...GLOB_VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
        '--',
        ...prepared.searchArgs,
      ],
      cwd: this.cwd,
      mode: this.resolveToolMode(),
      tool: 'glob',
      signal,
      ...(this.tolerateUnreadable && { tolerateUnreadable: { searchRoots: prepared.searchArgs } }),
      internals: this.ripgrepInternals,
    });
    if (outcome.kind === 'error') {
      return searchFailure(outcome.code, await this.withoutRoot(outcome.message));
    }
    noteSearchSkipped(outcome.unreadable);

    const relatives: string[] = [];
    for (const entry of outcome.stdout.split('\0')) {
      if (entry === '') continue;
      const rel = relative(this.cwd, resolve(this.cwd, entry));
      if (rel === '' || escapesRoot(rel)) continue;
      relatives.push(rel);
    }
    const files: Array<{ path: string; is_dir: false; size: number; modified_at: string }> = [];
    for (let start = 0; start < relatives.length; start += GLOB_LSTAT_BATCH) {
      if (signal?.aborted === true) {
        return searchFailure(
          SEARCH_ABORTED,
          'glob was aborted before completion (tool timeout or caller cancellation)',
        );
      }
      const batch = relatives.slice(start, start + GLOB_LSTAT_BATCH);
      const stats = await Promise.all(
        batch.map((rel) => lstat(resolve(this.cwd, rel)).catch(() => undefined)),
      );
      batch.forEach((rel, index) => {
        const stats0 = stats[index];
        if (stats0 === undefined || !stats0.isFile()) return;
        files.push({
          path: `/${rel.split(sep).join('/')}`,
          is_dir: false,
          size: stats0.size,
          modified_at: stats0.mtime.toISOString(),
        });
      });
    }
    return { files };
  }

  /**
   * `grep` 與 `glob` 起 rg 之前共用的準備：確認工作區根、解出搜尋起點、解出內附 rg。
   *
   * **根不存在不是錯誤，是「沒有東西可找」**（`empty`，同基座對不存在的起點）：暫存 backend 的根是第一次存東西才建的
   * （`tool-result-stash.ts`），經 `CompositeBackend` 搜 `/` 時也會搜到它。根存在卻不是目錄才是錯誤。
   *
   * @param tool - 錯誤訊息裡的工具名。
   * @param dirPaths - 起點的虛擬路徑。
   * @param directoriesOnly - 起點必須是目錄（`glob`）；`grep` 的起點也可以是單一檔案。
   */
  private async prepareSearch(
    tool: RipgrepTool,
    dirPaths: readonly string[],
    directoriesOnly: boolean,
  ): Promise<
    | { readonly kind: 'empty' }
    | {
        readonly kind: 'failed';
        readonly failure: { readonly error: string; readonly errorCode?: SearchErrorCode };
      }
    | { readonly kind: 'ready'; readonly executable: string; readonly searchArgs: string[] }
  > {
    try {
      if (!(await stat(this.cwd)).isDirectory()) throw new Error('not a directory');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'empty' };
      return {
        kind: 'failed',
        failure: searchFailure(
          SEARCH_FAILED,
          `${tool} cannot search: the workspace root is not an accessible directory`,
        ),
      };
    }
    for (const dirPath of dirPaths) {
      const refused = await this.readDenial(dirPath || '.', tool);
      if (refused !== undefined) return { kind: 'failed', failure: denied({ error: refused }) };
    }
    const searchArgs = await this.existingSearchArgs(dirPaths, directoriesOnly);
    if (searchArgs.length === 0) return { kind: 'empty' };
    let executable = this.ripgrepInternals?.executable;
    if (executable === undefined) {
      try {
        executable = await resolveRgPath();
      } catch {
        // 固定字串：`resolveRgPath` 的錯誤訊息帶套件名與路徑，不交給模型（理由見 `ripgrep-runner.ts` 的 `FAILURE_REASONS`）。
        // 管理者從 serve 啟動日誌那一行看得到原因。
        return {
          kind: 'failed',
          failure: searchFailure(
            SEARCH_FAILED,
            `${tool} could not start its search command (bundled ripgrep unavailable)`,
          ),
        };
      }
    }
    return { kind: 'ready', executable, searchArgs };
  }

  /**
   * 把虛擬路徑換成 rg 的搜尋引數，濾掉解不出來或不存在的（`directoriesOnly` 時也濾掉不是目錄的）。
   *
   * **搜尋起點要傳相對於工作區根的路徑**（根本身是 `.`）：rg 的錨點是它自己 `getcwd()` 的 realpath，根經過 symlink 時
   * 傳絕對路徑會對不上、帶目錄的 `--glob` 一個都命中不了；相對路徑不受影響（rg 15.1.0 實測；`cwd` 為根、路徑為 `.` 或
   * `src` 時 `logs/app.log`、`/logs/app.log` 與 `src` 底下的遞迴 glob 都對根錨定）。
   * 一律加 `./` 前綴：目錄名剛好是 `-` 時 rg 會改讀 stdin（0 筆、沒有錯誤），`-x` 這類也不會被當成旗標。
   */
  private async existingSearchArgs(
    dirPaths: readonly string[],
    directoriesOnly: boolean,
  ): Promise<string[]> {
    const args: string[] = [];
    for (const dirPath of dirPaths) {
      let baseFull: string;
      try {
        baseFull = this.resolveVirtual(dirPath || '.');
      } catch {
        continue;
      }
      try {
        const info = await stat(baseFull);
        if (directoriesOnly && !info.isDirectory()) continue;
      } catch {
        continue;
      }
      const searchRel = relative(this.cwd, baseFull);
      args.push(searchRel === '' ? '.' : `.${sep}${searchRel}`);
    }
    return args;
  }

  /**
   * 解 `rg --json` 的輸出，換算成虛擬路徑；**輸出壞了回一句說明**（呼叫端判 `SEARCH_FAILED`），不回半份結果。
   *
   * `rg --json` 是內部的傳輸格式，不是給人看的：一行不是 JSON、紀錄不是物件、`match` 紀錄缺了路徑文字、行號或行內容，都表示這一次
   * 的輸出不可信。檔名不是 UTF-8 時 rg 送 `path.bytes`，同樣算缺路徑文字。`type` 不是 `match` 的紀錄（`begin`／`end`／`summary` 等）
   * 一律略過。行不是 UTF-8 時 rg 送 `lines.bytes` 而不是 `text`，換成一句佔位，不算壞。路徑相對 `cwd` 換成 `/…`，跑到根外或就是根
   * 本身的丟掉。
   */
  private parseRipgrepJson(
    stdout: string,
  ): Array<{ path: string; line: number; text: string }> | string {
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const line of stdout.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return 'a line is not JSON';
      }
      if (typeof parsed !== 'object' || parsed === null) return 'a record is not an object';
      const record = parsed as { type?: unknown; data?: unknown };
      if (record.type !== 'match') continue;
      if (typeof record.data !== 'object' || record.data === null) {
        return 'a match record has no data';
      }
      const data = record.data as { path?: unknown; line_number?: unknown; lines?: unknown };
      const file =
        typeof data.path === 'object' && data.path !== null
          ? (data.path as { text?: unknown }).text
          : undefined;
      if (typeof file !== 'string') return 'a match record has no path text';
      if (typeof data.line_number !== 'number') return 'a match record has no line number';
      if (typeof data.lines !== 'object' || data.lines === null) {
        return 'a match record has no line content';
      }
      const lines = data.lines as { text?: unknown; bytes?: unknown };
      let text: string;
      if (typeof lines.text === 'string') text = lines.text.replace(/\n$/, '');
      else if (typeof lines.bytes === 'string') text = '(line is not valid UTF-8)';
      else return 'a match record has neither line text nor bytes';
      const rel = relative(this.cwd, resolve(this.cwd, file));
      if (rel === '' || escapesRoot(rel)) continue;
      matches.push({ path: `/${rel.split(sep).join('/')}`, line: data.line_number, text });
    }
    return matches;
  }

  /**
   * fence 本體：過了回傳要交給基座的虛擬路徑，沒過回傳錯誤結果。
   *
   * 回傳「路徑或錯誤」而不是拋錯，是因為 `BackendProtocolV2` 的變更方法**約定用回傳值報錯**
   * （`WriteResult.error`），基座的檔案工具也是照那個欄位把訊息交給模型的。拋錯會走到另一條
   * 路上去，模型看到的東西不一樣。
   *
   * @param filePath - 模型給的虛擬路徑。
   * @param operation - 出現在拒絕訊息裡的操作名。
   * @param payload - 這一次變更除了路徑以外的參數，被擋下時拿來算 {@link SandboxDenial} 的摘要。
   * @returns 通過時是 canonicalize 之後再表達回去的虛擬路徑；被擋時是帶 `error` 的結果。
   */
  private async checkedPath(
    filePath: string,
    operation: 'write' | 'edit' | 'delete' | 'uploadFiles',
    payload: readonly unknown[],
  ): Promise<string | { error: string }> {
    // **一次呼叫解析一次**：底下有 `await`，來源在那之間變了的話，判斷與拒絕訊息就會
    // 指向兩個不同的模式。dsh 的「一次呼叫一份政策」在這個形狀底下就是這一行。
    const standing = this.mode;
    // 保留的地方排在模式之前：全開與核准來的 grant 都蓋不過它，所以不記拒絕、不接指引。
    const reserved = await this.reservedDenial(standing, filePath, operation);
    if (reserved !== undefined) return { error: reserved };
    const first = await this.verdict(standing, filePath, operation);
    if (typeof first === 'string') return first;

    // `uploadFiles` 不認領 grant、也不接指引：它今天唯一的生產者是基座自己（摘要器），
    // 模型碰不到；而它的錯誤型別是四個錯誤碼的 union，指引也塞不進去。
    const grants = this.grants;
    if (operation === 'uploadFiles' || grants === undefined) return first;

    // `~` 與 `..` 沒有 canonical 目標：記不下這一次，也認領不到任何 grant（見 canonicalTarget）。
    const target = await this.canonicalTarget(filePath);
    if (target === undefined) return this.withHint(first);
    const denial: SandboxDenial = { target, digest: digestOf(operation, payload) };

    const claim = await this.claimGrant(denial);
    if (claim.kind === 'granted') {
      // 核准來的模式**只蓋這一次**，判斷與拒絕訊息都用它——照 dsh 把核准的模式蓋到那一次
      // 呼叫上，拒絕標記印的也是那一格。還是被擋的話 grant 照樣用掉了，同 dsh：它屬於這一次。
      const second = await this.verdict(claim.mode, filePath, operation);
      if (typeof second === 'string') return second;
      // 再記一次同一顆：grant 已經用掉，模型要升到更寬那格就得再叫一次升級、再問一次人，
      // 那顆新 grant 綁的還是這一次。不會空轉——每一輪都要人按。
      grants.recordDenial(denial);
      return this.withHint(second);
    }
    // 記下這一次：模型接著叫升級的話，發出去的 grant 綁的就是它。
    grants.recordDenial(denial);
    return this.withHint(
      claim.kind === 'mismatch' ? { error: `${first.error}\n${GRANT_MISMATCH_NOTE}` } : first,
    );
  }

  /**
   * 在某一格模式之下判一條路徑。
   *
   * **模式是傳進來的**：呼叫端決定這一次呼叫用哪一格（常駐那格，或核准來的那格），
   * 這裡不自己讀。
   *
   * @param mode - 這一次呼叫用的模式。
   * @param filePath - 模型給的虛擬路徑。
   * @param operation - 出現在拒絕訊息裡的操作名。
   * @returns 通過時是要交給基座的虛擬路徑；被擋時是帶 `error` 的結果。
   */
  private async verdict(
    mode: SandboxMode,
    filePath: string,
    operation: 'write' | 'edit' | 'delete' | 'uploadFiles',
  ): Promise<string | { error: string }> {
    if (mode === 'danger-full-access') return filePath;
    if (mode === 'read-only') {
      return { error: this.denial(mode, operation, filePath, '這個 backend 是唯讀的') };
    }

    // `~` 要對**原始路徑**檢查。底下補前置斜線那一步一跑，`~` 就永遠不在開頭了——這條
    // 檢查曾經寫在補斜線之後，於是從來沒有觸發過（PR #62 的 review 實測）。它擋的不是
    // 逃逸（`~/../x` 會撞上 `..`，`/~/x` 落在根內），是「模型以為自己在用家目錄」。
    if (filePath.startsWith('~')) {
      return { error: this.denial(mode, operation, filePath, '路徑裡有 "~"') };
    }

    const virtualPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
    // 先擋字面上的穿越再碰檔案系統：這一段與基座的 `resolvePath()` 同一條規則，但我們要
    // 自己的措辭，而且擋在這裡就不必為了 `..` 去多跑幾次 realpath。
    if (virtualPath.includes('..')) {
      return { error: this.denial(mode, operation, filePath, '路徑裡有 ".."') };
    }

    let realRoot: string;
    try {
      realRoot = await realpath(this.cwd);
    } catch {
      return { error: this.denial(mode, operation, filePath, '可寫根不存在') };
    }

    // `canonicalize()` 只把 ENOENT/ENOTDIR 當「還不存在」，其餘（ELOOP、EACCES…）會 rethrow。
    // 那些在這裡要收成回傳值：變更方法**約定用回傳值報錯**，讓它拋出去的話模型看到的不是
    // 拒絕訊息，而是 agent loop 撞上的一個 exception。
    let realTarget: string;
    try {
      realTarget = await canonicalize(resolve(this.cwd, virtualPath.slice(1)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '未知';
      return { error: this.denial(mode, operation, filePath, `路徑解析失敗（${code}）`) };
    }

    if (!isWithin(realRoot, realTarget)) {
      return {
        error: this.denial(mode, operation, filePath, '經符號連結解析之後落在可寫根之外'),
      };
    }

    // 交給基座的是 canonical 位置**再表達回去的虛擬路徑**：祖先的 symlink 已經解掉，所以
    // 基座那一次 lexical resolve 走的是實際位置。合法路徑走到這裡通常原封不動。
    const inside = relative(realRoot, realTarget);
    return inside === '' ? '/' : `/${inside.split(sep).join('/')}`;
  }

  /**
   * 變更落在保留的地方（{@link reservedReason} 有理由）就拒，不看模式。
   *
   * @param mode - 這一次呼叫用的模式，只用在拒絕訊息。
   * @param filePath - 模型給的虛擬路徑。
   * @param operation - 出現在拒絕訊息裡的操作名。
   * @returns 落在保留的地方時的拒絕訊息；其餘 `undefined`。
   */
  private async reservedDenial(
    mode: SandboxMode,
    filePath: string,
    operation: 'write' | 'edit' | 'delete' | 'uploadFiles',
  ): Promise<string | undefined> {
    const reason = await this.reservedReason(filePath);
    return reason === undefined ? undefined : this.denial(mode, operation, filePath, reason);
  }

  /**
   * `filePath` 落在保留的地方嗎（{@link ContainedFilesystemBackendOptions.reservedWrites}）。變更的拒絕（{@link reservedDenial}）與
   * 升級工具（#2078）問的都是這一個。
   *
   * 兩邊都 canonicalize 之後比，經符號連結的別名（`/docs/AGENTS.md`，`docs` 指向根）也擋得到；解析失敗的退回字面位置比。
   * **不分大小寫**：不分大小寫的檔案系統上，`/claude.md` 跟 `/CLAUDE.md` 是同一個檔。代價是分大小寫的檔案系統上，只差大小寫的名字也寫不進去。
   * 路徑本身不合法（`..`、`~`、跑出根）的不在這裡判，交給 {@link verdict} 與基座。
   *
   * @param filePath - 模型給的虛擬路徑。
   * @returns 落在保留的地方時是那一格的理由；其餘（含路徑不合法）`undefined`。
   */
  async reservedReason(filePath: string): Promise<string | undefined> {
    const reserved = this.reservedWrites?.() ?? [];
    if (reserved.length === 0) return undefined;
    const target = await this.placeOf(filePath);
    if (target === undefined) return undefined;
    for (const entry of reserved) {
      const place = await this.placeOf(entry.path);
      if (place === undefined) continue;
      const hit = entry.subtree ? isWithin(place, target) : place === target;
      if (hit) return entry.reason;
    }
    return undefined;
  }

  /** {@link reservedReason} 比對用的位置：canonicalize 之後轉小寫；解析失敗退回字面位置，路徑不合法回 `undefined`。 */
  private async placeOf(virtualPath: string): Promise<string | undefined> {
    let resolved: string;
    try {
      resolved = this.resolveVirtual(virtualPath);
    } catch {
      return undefined;
    }
    const place = await canonicalize(resolved).catch(() => resolved);
    return place.toLowerCase();
  }

  /**
   * 讀取面的圍堵（[#1982](https://github.com/DemianLi/nexus-agent/issues/1982)）：路徑 canonicalize 之後落在根外就拒。
   * 擋的是工作區裡往外指的符號連結——祖先目錄的連結基座照跟，經它讀得到根外的檔，連結指向 harness home 或 `.env` 時就是 key。
   *
   * 跟寫入的 {@link verdict} 同一套 canonicalize-then-contain（`canonical-path.ts`），差在三處：
   * - **`read-only` 也照判**：那一格擋的是變更，不是讀。只有 `danger-full-access` 放行，跟寫入一致。
   * - **不認領 grant、不接升級指引**：升級只蓋變更，指引對讀沒有用。
   * - **判不了時只放行下游必定也失敗的那幾種**：字面檢查（`..`、`~`）擋下的、根不存在、解析撞上 {@link READ_PASSTHROUGH_CODES}
   *   的，原樣交給基座或自己的讀法，錯誤字句是下游自己的——開檔走同一串路徑，會撞上同一個錯。其餘（`EMFILE`、`EIO` 這類暫時性的錯）
   *   拒，措辭同 {@link verdict} 的「路徑解析失敗」：這一刻判不了，下一刻開檔卻可能成功，就經連結讀出去了。
   *
   * 最後一段是指向根外的檔案連結也在這裡被拒，到不了開檔那一步。
   * 殘留的 TOCTOU（檢查之後、開檔之前祖先被換成連結）跟寫入面同一個取捨，見檔頭。
   *
   * @param filePath - 模型給的虛擬路徑。
   * @param operation - 出現在拒絕訊息裡的操作名。
   * @returns 落在根外時的拒絕訊息；其餘 `undefined`。
   */
  private async readDenial(
    filePath: string,
    operation: ReadOperation,
  ): Promise<string | undefined> {
    return (await this.readScope(filePath, operation)).denial;
  }

  /**
   * {@link readDenial} 的判斷，連同比過根的那個實際位置一起回。解析交給下游的情況沒有 `realTarget`。
   * `danger-full-access` 不比根，位置照樣解開，所以連結在這一格一律讀得到，往外的也是。
   *
   * @param filePath - 模型給的虛擬路徑。
   * @param operation - 出現在拒絕訊息裡的操作名。
   */
  private async readScope(filePath: string, operation: ReadOperation): Promise<ReadScope> {
    const mode = this.mode;
    let resolved: string;
    try {
      resolved = this.resolveVirtual(filePath);
    } catch {
      return {};
    }
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = await realpath(this.cwd);
      realTarget = await canonicalize(resolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (mode === 'danger-full-access') return {};
      if (code !== undefined && READ_PASSTHROUGH_CODES.has(code)) return {};
      return {
        denial: this.denial(mode, operation, filePath, `路徑解析失敗（${code ?? '未知'}）`),
      };
    }
    if (mode === 'danger-full-access' || isWithin(realRoot, realTarget)) return { realTarget };
    return { denial: this.denial(mode, operation, filePath, '經符號連結解析之後落在根之外') };
  }

  /**
   * 認領一顆**對得上這一次變更**的 grant。
   *
   * 目標比的是兩邊 canonicalize 之後的實際位置，不是字串：經 symlink 的別名要對得上，否則模型
   * 換個寫法重試就認不到；反過來，字串比對會讓一顆 grant 蓋到另一個檔。目標對上之後再比
   * grant 綁的那一次（見 `SandboxGrant`）：操作、目標、內容摘要都一樣才算。
   *
   * **先 peek、await 完再 take**：兩顆平行的變更都對得上時，只有先 take 的那一顆拿得到。
   *
   * @param call - 這一次變更，已經被常駐那格擋下。
   * @returns `granted` 帶核准來的模式；`mismatch` 是這個檔有 grant、但它綁的不是這一次
   *   （**沒有消費**）；`none` 是沒有 grant、目標對不上、或被別人先拿走。
   */
  private async claimGrant(call: SandboxDenial): Promise<GrantClaim> {
    const pending = this.grants?.peekGrant();
    if (pending === undefined) return { kind: 'none' };
    if ((await this.canonicalTarget(pending.target)) !== call.target) return { kind: 'none' };
    if (!sameDenial(pending.denied, call)) return { kind: 'mismatch' };
    return this.grants?.takeGrant(pending) === true
      ? { kind: 'granted', mode: pending.mode }
      : { kind: 'none' };
  }

  /**
   * 一條虛擬路徑的實際位置，比對 grant 用。
   *
   * `~` 與 `..` **一律回 `undefined`**（對不上任何 grant）：它們在 fence 裡本來就是字面上
   * 擋掉的，讓它們認領得到 grant 等於開一條繞過那兩條檢查的路。
   *
   * @param filePath - 虛擬路徑。
   * @returns canonicalize 之後的絕對路徑；不適合比對或解析失敗時為 `undefined`。
   */
  private async canonicalTarget(filePath: string): Promise<string | undefined> {
    if (filePath.startsWith('~')) return undefined;
    const virtualPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
    if (virtualPath.includes('..')) return undefined;
    try {
      return await canonicalize(resolve(this.cwd, virtualPath.slice(1)));
    } catch {
      return undefined;
    }
  }

  /**
   * 被擋下時接上升級指引——**只在這個組裝真的有升級工具時**（見 {@link SandboxGrantLedger}）。
   *
   * 指引騎在拒絕上，照 dsh 的 `escalationHintMarker`：推力放在決定點上，模型不必記得工具描述。
   * **每次都重讀**，不在建構期快照：掛上工具的那一步發生在 fence 建好之後。
   */
  private withHint(denied: { error: string }): { error: string } {
    const hint = this.grants?.escalationHint;
    return hint === undefined ? denied : { error: `${denied.error}\n${hint}` };
  }

  /** {@link pathlessReason} 再換掉訊息裡的根。 */
  private async reasonFor(error: unknown): Promise<string> {
    return this.withoutRoot(pathlessReason(error));
  }

  /**
   * 把文字裡的根換成虛擬路徑的 `/`（[#2201](https://github.com/DemianLi/nexus-agent/issues/2201)）：`cwd` 與它的 realpath 都換，
   * 根經過符號連結時兩種寫法都可能出現。擋的是我們拿不到例外、只拿得到字串的地方：基座的 `delete`、rg 的 stderr、包過一層的錯誤。
   */
  private async withoutRoot(text: string): Promise<string> {
    const real = await realpath(this.cwd).catch(() => this.cwd);
    let scrubbed = text;
    // 長的先換：`cwd` 可能是 realpath 的後綴（`/var/x` 與 `/private/var/x`），先換短的會留下 `/private`。
    for (const root of [...new Set([this.cwd, real])].sort((a, b) => b.length - a.length)) {
      scrubbed = scrubbed.replaceAll(`${root}${sep}`, '/').replaceAll(root, '/');
    }
    return scrubbed;
  }

  /**
   * 拒絕訊息只有一種形狀——同一條政策不該在模型眼裡有兩套詞彙。
   *
   * **模式是傳進來的，不是在這裡讀的**：呼叫端已經解析過一次，這裡再讀一次就可能印出
   * 跟實際擋下它的那一格不同的名字。
   */
  private denial(mode: SandboxMode, operation: string, filePath: string, reason: string): string {
    return `[containment] 拒絕 ${operation} "${filePath}"：${reason}（mode: ${mode}）`;
  }
}
