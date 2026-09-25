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
 * | `read` | 讀穿了（照 [#34](https://github.com/DemianLi/nexus-agent/issues/34)：讀歸 `permissions` 管，fence 不碰） |
 *
 * 所以這個 class 要補的是 `write` 與 `edit`。**`delete` 也一起覆寫**，理由不是基座那邊有錯，
 * 而是**拒絕的措辭要只有一種**：基座擋下來時說的是 `Symlink parent not allowed`，我們說的是
 * 另一句，同一條政策在模型眼裡就有兩套詞彙，測試也得斷言兩個字串。dsh 讓所有拒絕共用一個
 * `FS_SANDBOX_DENIED` 正是這個理由。
 *
 * 第四個是 **`uploadFiles`**——`BackendProtocolV2` 上另一個會改檔案的方法，覆蓋面漏掉它
 * 就有一條繞得過 fence 的路（PR #62 的 review 實測，經 symlink 寫穿到根外）。
 *
 * ## 形狀照 dsh 的 `fs-sandbox`
 *
 * [#34](https://github.com/DemianLi/nexus-agent/issues/34) 的定案，逐條對應
 * （`references/deepseek-harness/packages/fs/fs-sandbox/`）：**繼承**而不是平行實作、
 * **只在寫入路徑加 fence**、**讀一律通過**、canonicalize-then-contain 且在委派前重新
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
 * 做不到同一件事：`super.write()` 收的是**虛擬路徑**，它自己會再 `resolvePath()` 一次，
 * 傳一個 realpath 進去只會被當成虛擬路徑接到 `cwd` 底下。所以這裡回傳的是「canonical 之後
 * 再表達回去的虛擬路徑」——祖先的 symlink 已經被解掉，但基座那一次 lexical resolve 仍在
 * 我們的檢查之後發生。
 */

import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { applyGrepMaxCount, FilesystemBackend } from 'deepagents';
import type {
  DeleteResult,
  EditResult,
  FileUploadResponse,
  GrepResult,
  ReadResult,
  WriteResult,
} from 'deepagents';
import micromatch from 'micromatch';

import { noteSandboxDenial } from '@nexus/core';
import { notTextReason, refuseNonText } from './binary-read.js';
import type {
  SandboxDenial,
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

/**
 * 帶目錄的 glob 的最後一段，拿來交給基座先比檔名（見 {@link ContainedFilesystemBackend.grep}）。
 * 大括號跨了 `/` 的時候（`{logs/a.log,src/b.ts}`），最後一段只是半個選項，拿它比檔名會漏掉
 * 其他選項，所以回 `null`。最後一段是空的（`logs/`）或 `**` 都不必特別處理：前者等於不帶 glob，
 * 後者拿來比檔名本來就什麼都對得上。
 *
 * @param anchored - 已去掉開頭 `/` 的 glob。
 * @returns 最後一段，或 `null`。
 */
function lastSegmentOf(anchored: string): string | null {
  if (/\{[^}]*\/[^}]*\}/.test(anchored)) return null;
  return anchored.slice(anchored.lastIndexOf('/') + 1) || null;
}

/**
 * 圍堵的強度。名字照抄 dsh 的三個 mode（`references/deepseek-harness/packages/fs/fs-sandbox/README.md`）。
 *
 * `read-only` 只擋得住**變更**——讀不經過這裡（`read` / `glob` 沒被覆寫；`grep` 的覆寫只修
 * glob 的錨點，不加任何 fence，見 {@link ContainedFilesystemBackend.grep}）。dsh 也是
 * 這樣：它的 fence 同樣只掛在兩個 mutation 上，「read-only」講的是這個 backend 不改東西，
 * 不是「這個 agent 看不到東西」。看不看得到歸 `permissions`。
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
 * （不像歷史那件事，至少摘要還在）。修法是在組裝點把那個前綴路由到獨立的 `StateBackend`
 * （`agent-factory.ts` 的 `withToolResultStash`），所以那次 write 不再經過這道 fence。
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
  /** 單檔大小上限，原樣轉給基座。 */
  readonly maxFileSizeMb?: number;
  /**
   * 升級的 grant 從哪裡認領（見 {@link SandboxGrantLedger}）。
   *
   * **省略就是沒有升級**：被擋就是被擋，拒絕後面不接指引。
   */
  readonly grants?: SandboxGrantLedger;
}

/**
 * 在寫入路徑上加了 canonicalize-then-contain 的 `FilesystemBackend`。
 *
 * **一定是 `virtualMode: true`**，而且不給關。`virtualMode: false` 的語義是「絕對路徑原樣
 * 放行」，那個模式底下沒有「根」這回事，圍堵無從談起——留一個關得掉的開關只會讓
 * 「我以為它有防」變成可能。
 */
export class ContainedFilesystemBackend extends FilesystemBackend {
  /** 圍堵強度的來源。建構期給的字面值在這裡已經被包成一個恆定的函式。 */
  private readonly resolveMode: SandboxModeSource;

  /** 升級的 grant 從哪裡認領；`undefined` 就是這道 fence 沒有升級。 */
  private readonly grants: SandboxGrantLedger | undefined;

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
    this.grants = options.grants;
  }

  /**
   * 讀檔：二進位檔照 dsh 拒絕（{@link refuseNonText}，判準與偏離見 `binary-read.ts`），其餘原樣交給基座。
   *
   * **判在基座讀完之後**：不存在、是符號連結、超出根目錄，照舊由基座回它自己的錯。文字那一支基座已經用有損的 UTF-8
   * 解掉了（非法位元組變成 U+FFFD，分不出原本就是 U+FFFD），所以另外讀一次原始位元組來判；非文字那一支位元組就在
   * 手上。
   *
   * @param filePath - 虛擬路徑。
   * @param offset - 從第幾行起（0 起算），交給基座。
   * @param limit - 最多幾行，交給基座。
   * @returns 基座的結果，或二進位檔的錯誤結果。
   */
  override async read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    const result = await super.read(filePath, offset, limit);
    if (result.error !== undefined) return result;
    if (result.content instanceof Uint8Array) return refuseNonText(filePath, result.content);
    let reason: string | undefined;
    try {
      reason = notTextReason(await this.rawBytes(filePath));
    } catch (error: unknown) {
      return { error: `Error reading file '${filePath}': ${(error as Error).message}` };
    }
    return reason === undefined ? result : { error: `cannot read "${filePath}": ${reason}` };
  }

  /**
   * 一個檔的原始位元組。路徑照基座虛擬模式的 `resolvePath` 拼（`cwd` 底下字面拼接，它在 TS 上是 private），開檔照基座
   * 帶 `O_NOFOLLOW`——判的要是基座剛讀的那一個檔。
   */
  private async rawBytes(filePath: string): Promise<Uint8Array> {
    const virtualPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
    const handle = await open(
      resolve(this.cwd, virtualPath.slice(1)),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  /**
   * 寫檔，先過 fence。
   * @param filePath - 虛擬路徑。
   * @param content - 檔案內容。
   * @returns 基座的寫入結果，或被 fence 擋下時的錯誤結果。
   */
  override async write(filePath: string, content: string): Promise<WriteResult> {
    const checked = await this.checkedPath(filePath, 'write', [content]);
    return typeof checked === 'string' ? super.write(checked, content) : denied(checked);
  }

  /**
   * 編輯檔案，先過 fence。
   * @param filePath - 虛擬路徑。
   * @param oldString - 要被換掉的字串。
   * @param newString - 換上去的字串。
   * @param replaceAll - 是否全部取代。
   * @returns 基座的編輯結果，或被 fence 擋下時的錯誤結果。
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
    return typeof checked === 'string'
      ? super.edit(checked, oldString, newString, replaceAll)
      : denied(checked);
  }

  /**
   * 刪除，先過 fence。基座那端還有它自己的 symlink 祖先檢查，兩道都會跑——我們這道先。
   * @param filePath - 虛擬路徑。
   * @returns 基座的刪除結果，或被 fence 擋下時的錯誤結果。
   */
  override async delete(filePath: string): Promise<DeleteResult> {
    const checked = await this.checkedPath(filePath, 'delete', []);
    return typeof checked === 'string' ? super.delete(checked) : denied(checked);
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
   * 搜尋檔案內容。**帶目錄的 glob 一律對工作區根錨定**，跟 dsh 一樣。
   *
   * **基座的缺陷**：`ripgrepSearch()` 啟動 `rg` 時沒指定 `cwd`，搜尋路徑又是主機上的絕對路徑，
   * 而 rg 會把帶 `/` 的 glob 錨定在行程的工作目錄上。harness 的工作目錄不是工作區根，所以
   * `glob: "logs/app.log"`、`glob: "/logs/app.log"` 都會**不報錯、回 0 筆**。沒有 rg 時走的退路
   * （`literalSearch()`）只拿檔名比對 glob，帶目錄的 glob 同樣永遠對不上。一次 live 量測裡，
   * 模型那一輪共打了 20 次工具呼叫，其中 9 次 grep 全部回 0 筆，花了 154 秒。不帶 `/` 的 glob（`*.ts`）兩條路
   * 都對得上，不受影響。
   *
   * **偏離登記**（AGENTS.md「技術實現標準」）：
   * - dsh 的做法（`packages/fs/tool-fs-search/src/grep.ts` 與 `search-core.ts`）：`rg` 在 session
   *   的工作目錄裡執行，glob 原樣以 `--glob=` 傳下去，所以帶目錄的 glob 對根錨定。
   * - 表達不出來的原因：`ripgrepSearch()` 與 `literalSearch()` 在型別上是 `private`，
   *   `FilesystemBackend` 也沒有指定 `rg` 工作目錄的選項，這一層換不到那個 `cwd`。
   * - 退到的做法：只在 glob 帶 `/` 時介入。交給基座的是 glob 的最後一段（`logs/app.log` →
   *   `app.log`），兩條路都拿它比檔名，回來的是一個超集；再拿完整的 glob 對「相對於工作區根」
   *   的路徑精確過濾，語意等同 rg 在根上執行。大括號跨了 `/` 時沒有可靠的最後一段，改成
   *   不帶 glob 交給基座，一樣在這裡過濾。
   * - 回頭點：`contained-backend.test.ts` 對裸 `FilesystemBackend` 斷言今天回 0 筆。基座修好
   *   那天它會紅，這個覆寫就該拿掉。
   *
   * `maxCount` 在過濾之後才套用，否則過濾前的截斷會丟掉本來對得上的結果；截斷時照基座的
   * 形狀設 `truncated`，工具層據此補上截斷提示。
   *
   * @param pattern - 要找的字面字串。
   * @param dirPath - 從哪個虛擬路徑開始找。
   * @param glob - 篩選檔案的 glob；帶 `/` 時對工作區根錨定。
   * @param maxCount - 最多回幾筆。
   * @returns 基座的搜尋結果；帶目錄的 glob 已按工作區根過濾。
   */
  override async grep(
    pattern: string,
    dirPath?: string,
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    if (glob === undefined || glob === null || !glob.includes('/')) {
      return super.grep(pattern, dirPath, glob, maxCount);
    }
    const anchored = glob.replace(/^\/+/, '');
    const result = await super.grep(pattern, dirPath, lastSegmentOf(anchored), null);
    if (result.matches === undefined) return result;
    const matches = result.matches.filter((match) =>
      micromatch.isMatch(match.path.replace(/^\/+/, ''), anchored, { dot: true }),
    );
    return applyGrepMaxCount({ result: { ...result, matches }, maxCount: maxCount ?? null });
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
      return { error: this.denial(mode, operation, filePath, `可寫根 ${this.cwd} 不存在`) };
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

    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      return {
        error: this.denial(
          mode,
          operation,
          filePath,
          `canonicalize 之後是 ${realTarget}，落在可寫根之外`,
        ),
      };
    }

    // 交給基座的是 canonical 位置**再表達回去的虛擬路徑**：祖先的 symlink 已經解掉，所以
    // 基座那一次 lexical resolve 走的是實際位置。合法路徑走到這裡通常原封不動。
    const inside = relative(realRoot, realTarget);
    return inside === '' ? '/' : `/${inside.split(sep).join('/')}`;
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

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * 把一個絕對路徑解到它的實際位置——**最深的那個存在的祖先** realpath 之後，再把還不存在的
 * 尾巴接回去。
 *
 * 要這一步是因為寫檔的目標通常還不存在，直接 `realpath()` 會 ENOENT。祖先的 symlink 就是
 * 在這裡被解開的，而那是 fence 唯一有趣的失敗法：只比對 `..` 是在測字串處理。
 *
 * @param target - 已經 `resolve()` 過的絕對路徑。
 * @returns 解析後的絕對路徑；連根都不存在時原樣回傳。
 */
async function canonicalize(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !MISSING_CODES.has(code)) throw error;
      const parent = dirname(current);
      if (parent === current) return target;
      missing.push(basename(current));
      current = parent;
    }
  }
}
