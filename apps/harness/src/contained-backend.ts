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

import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { FilesystemBackend } from 'deepagents';
import type { DeleteResult, EditResult, FileUploadResponse, WriteResult } from 'deepagents';

/**
 * 圍堵的強度。名字照抄 dsh 的三個 mode（`references/deepseek-harness/packages/fs/fs-sandbox/README.md`）。
 *
 * `read-only` 只擋得住**變更**——讀不經過這裡（`read` / `grep` / `glob` 沒被覆寫）。dsh 也是
 * 這樣：它的 fence 同樣只掛在兩個 mutation 上，「read-only」講的是這個 backend 不改東西，
 * 不是「這個 agent 看不到東西」。看不看得到歸 `permissions`。
 *
 * **`read-only` 就是不留對話歷史，這是明著接受的。** 長對話會觸發基座的 summarization，
 * 它把舊訊息 offload 到 `/conversation_history`；`read-only` 擋掉那次寫入，而基座對 offload
 * 失敗是 **fail-open** —— 摘要照生、舊訊息照換掉、完整歷史沒留下副本，只有一行 `console.warn`
 * （[#66](https://github.com/DemianLi/nexus-agent/issues/66)）。
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
 * **`danger-full-access` 比 dsh 的同名 mode 弱，這是一條偏離。** 它放行 symlink 逃逸，但
 * 基座那道 lexical 的 `..` 檢查仍在——這個 class 不給關 `virtualMode`（見下面的 class 註解），
 * 所以它結構上就不可能是 dsh 那種真正的不設防。想要完全不設防，用原生的 `FilesystemBackend`。
 */
export type ContainmentMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface ContainedFilesystemBackendOptions {
  /** 可寫根。所有虛擬路徑都以它為基準，變更不得 canonicalize 到它之外。 */
  readonly rootDir: string;
  /** 圍堵強度。省略即 `workspace-write`——預設要是設防的那一個。 */
  readonly mode?: ContainmentMode;
  /** 單檔大小上限，原樣轉給基座。 */
  readonly maxFileSizeMb?: number;
}

/**
 * 在寫入路徑上加了 canonicalize-then-contain 的 `FilesystemBackend`。
 *
 * **一定是 `virtualMode: true`**，而且不給關。`virtualMode: false` 的語義是「絕對路徑原樣
 * 放行」，那個模式底下沒有「根」這回事，圍堵無從談起——留一個關得掉的開關只會讓
 * 「我以為它有防」變成可能。
 */
export class ContainedFilesystemBackend extends FilesystemBackend {
  /** 這個 backend 的圍堵強度，錯誤訊息會指名它。 */
  readonly mode: ContainmentMode;

  constructor(options: ContainedFilesystemBackendOptions) {
    super({
      rootDir: options.rootDir,
      virtualMode: true,
      ...(options.maxFileSizeMb !== undefined && { maxFileSizeMb: options.maxFileSizeMb }),
    });
    this.mode = options.mode ?? 'workspace-write';
  }

  /**
   * 寫檔，先過 fence。
   * @param filePath - 虛擬路徑。
   * @param content - 檔案內容。
   * @returns 基座的寫入結果，或被 fence 擋下時的錯誤結果。
   */
  override async write(filePath: string, content: string): Promise<WriteResult> {
    const checked = await this.checkedPath(filePath, 'write');
    return typeof checked === 'string' ? super.write(checked, content) : checked;
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
    const checked = await this.checkedPath(filePath, 'edit');
    return typeof checked === 'string'
      ? super.edit(checked, oldString, newString, replaceAll)
      : checked;
  }

  /**
   * 刪除，先過 fence。基座那端還有它自己的 symlink 祖先檢查，兩道都會跑——我們這道先。
   * @param filePath - 虛擬路徑。
   * @returns 基座的刪除結果，或被 fence 擋下時的錯誤結果。
   */
  override async delete(filePath: string): Promise<DeleteResult> {
    const checked = await this.checkedPath(filePath, 'delete');
    return typeof checked === 'string' ? super.delete(checked) : checked;
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
      const checked = await this.checkedPath(filePath, 'uploadFiles');
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
   * fence 本體：過了回傳要交給基座的虛擬路徑，沒過回傳錯誤結果。
   *
   * 回傳「路徑或錯誤」而不是拋錯，是因為 `BackendProtocolV2` 的變更方法**約定用回傳值報錯**
   * （`WriteResult.error`），基座的檔案工具也是照那個欄位把訊息交給模型的。拋錯會走到另一條
   * 路上去，模型看到的東西不一樣。
   *
   * @param filePath - 模型給的虛擬路徑。
   * @param operation - 出現在拒絕訊息裡的操作名。
   * @returns 通過時是 canonicalize 之後再表達回去的虛擬路徑；被擋時是帶 `error` 的結果。
   */
  private async checkedPath(
    filePath: string,
    operation: 'write' | 'edit' | 'delete' | 'uploadFiles',
  ): Promise<string | { error: string }> {
    if (this.mode === 'danger-full-access') return filePath;
    if (this.mode === 'read-only') {
      return { error: this.denial(operation, filePath, '這個 backend 是唯讀的') };
    }

    // `~` 要對**原始路徑**檢查。底下補前置斜線那一步一跑，`~` 就永遠不在開頭了——這條
    // 檢查曾經寫在補斜線之後，於是從來沒有觸發過（PR #62 的 review 實測）。它擋的不是
    // 逃逸（`~/../x` 會撞上 `..`，`/~/x` 落在根內），是「模型以為自己在用家目錄」。
    if (filePath.startsWith('~')) {
      return { error: this.denial(operation, filePath, '路徑裡有 "~"') };
    }

    const virtualPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
    // 先擋字面上的穿越再碰檔案系統：這一段與基座的 `resolvePath()` 同一條規則，但我們要
    // 自己的措辭，而且擋在這裡就不必為了 `..` 去多跑幾次 realpath。
    if (virtualPath.includes('..')) {
      return { error: this.denial(operation, filePath, '路徑裡有 ".."') };
    }

    let realRoot: string;
    try {
      realRoot = await realpath(this.cwd);
    } catch {
      return { error: this.denial(operation, filePath, `可寫根 ${this.cwd} 不存在`) };
    }

    // `canonicalize()` 只把 ENOENT/ENOTDIR 當「還不存在」，其餘（ELOOP、EACCES…）會 rethrow。
    // 那些在這裡要收成回傳值：變更方法**約定用回傳值報錯**，讓它拋出去的話模型看到的不是
    // 拒絕訊息，而是 agent loop 撞上的一個 exception。
    let realTarget: string;
    try {
      realTarget = await canonicalize(resolve(this.cwd, virtualPath.slice(1)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '未知';
      return { error: this.denial(operation, filePath, `路徑解析失敗（${code}）`) };
    }

    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      return {
        error: this.denial(
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

  /** 拒絕訊息只有一種形狀——同一條政策不該在模型眼裡有兩套詞彙。 */
  private denial(operation: string, filePath: string, reason: string): string {
    return `[containment] 拒絕 ${operation} "${filePath}"：${reason}（mode: ${this.mode}）`;
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
