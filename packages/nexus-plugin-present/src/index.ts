/**
 * `@nexus/plugin-present`——模型宣告**這一輪交付了哪些檔案**：一顆 `present` 工具，最終結果成功之後
 * 寫一筆 `deliverables/presented` 進呼叫它的那一份會話日誌。
 *
 * 形狀照 dsh 的 `packages/deliverables/tool-present/`（`477b4f4`）：模型看到的描述、參數說明與
 * `Presented <path>` 的結果逐字照抄；拒絕的字句也照抄，**但不是每一句都有**——dsh 那句
 * `present requires an open turn`（沒有進行中的那一輪就拒）我們沒有，要不要補見
 * [#696](https://github.com/DemianLi/nexus-agent/issues/696) 的留言，還沒定案。每次最多
 * `maxFiles`（預設 8）個；**只記路徑與說明，不讀、不複製內容**。dsh 的 standard preset 掛它，
 * 所以它在出貨清單裡。
 *
 * ## 什麼時候寫：配對的 `tool/result` 落定成功之後
 *
 * dsh 在工具本體裡只把這次要交付什麼記在一張表上，等 `tools/result` 通知（post-execute 鉤子都跑完之後
 * 那一顆）說結果不是錯誤才 `append`。我們的對應物是圍堵寫的那顆 `tool/result`：它在最外層，看得到
 * 內層每一顆 middleware 最後把結果判成什麼。所以本體訂閱自己那一份日誌，看到同一個 `callId` 的
 * `tool/result`、`isError` 為否，才寫。**不在本體裡直接寫**（`todo_write` 那條路）：那樣的話一次被
 * 外層改判成錯誤的呼叫照樣留下一筆交付，dsh 有一條測試專門擋它。
 *
 * 寫要**排到下一個 microtask**：日誌不准在自己的回呼裡重入（`SessionLog.append` 的防護）。訂閱者是
 * async 函式，`await` 一次之後才寫；它若拋，日誌把 reject 收成一行 warn，不會變成殺掉行程的
 * unhandled rejection。
 *
 * **等結果的那個訂閱一個 `callId` 只留一個。** 圍堵對控制流例外（中斷）是原樣往外拋、不寫
 * `tool/result` 的（`containment.ts` 的 `isGraphBubbleUp`），而 resume 之後同一個 `callId` 會再進來一次。
 * 本體要是在那之前跑過，舊的訂閱還掛著，結果落定時兩個一起觸發就交付兩次。今天核准閘門擋在本體之前，
 * 產品路徑上碰不到——這是一個沒人守的前提，所以新的一次先退掉舊的；組裝收掉時全部退掉，不留在
 * 活得跟行程一樣長的日誌上。
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
 *    行程的工作目錄，而且沒有工作區時組裝點照樣墊一顆 `StateBackend`。改看
 *    {@link WORKSPACE_CAPABILITY}（sandbox-policy 只在有圍堵時宣告它）。
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
 *    前綴由兩處合併而來：組裝點明著交的（`FsService.offWorkspacePrefixes`，折後的 backend 是巢狀的，
 *    裡面兩層的前綴在 private 欄位裡讀不到）與 `registry.backend.mounts()`。
 *
 * 檔案系統照 dsh 從 `fs` 服務拿（dsh 的 `inject` 有 `'fs'`），拿到的是基座檔案工具實際讀寫的那一個
 * （[#694](https://github.com/DemianLi/nexus-agent/issues/694)）。**那條理由只對一半成立**：走服務是為了
 * 看得見檔案工具寫的檔（工作區那一側，今天仍如此）；但「看得見」不等於「讀端讀得到」，路由那一側看得見的
 * 檔要另外擋掉（偏離 6）。服務的值是一格 fold 之後才填的把手、
 * 所以在工具被叫時才讀，偏離登記在 `@nexus/core` 的 `fs-service.ts`，理由同
 * `@nexus/plugin-agent-instructions` 的偏離 2，不另立一條。
 *
 * @see [#441](https://github.com/DemianLi/nexus-agent/issues/441)
 * @module
 */

import { posix } from 'node:path';

import { tool } from '@langchain/core/tools';
import type { NexusPlugin, PluginEntry, PluginRegistry, PresentedFile } from '@nexus/core';
import {
  FS_SERVICE,
  toolCallIdOf,
  toolRefusal,
  virtualPathOf,
  WORKSPACE_CAPABILITY,
} from '@nexus/core';
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

/**
 * 虛擬路徑在不在某個路由前綴底下（前綴本身也算）。
 *
 * 前綴的結尾斜線正規化掉再比，並且比的是「整段路徑」：`/large_tool_results_x/a.md` **不**在
 * `/large_tool_results/` 底下，那是工作區根下一個名字剛好以它開頭的目錄。
 * @param target - 已過 `virtualPathOf` 的路徑。
 * @param prefixes - 路由前綴，有沒有結尾斜線都行。
 * @returns 在其中任何一個底下就是真。
 */
function isUnderPrefix(target: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    const bare = prefix.replace(/\/+$/, '');
    return target === bare || target.startsWith(`${bare}/`);
  });
}

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
 * present plugin。
 *
 * **模組層級的一顆常數**，給 [#454](https://github.com/DemianLi/nexus-agent/issues/454)
 * 從設定檔 import。設定走 {@link Config} 進來，所以同一顆可以被好幾次組裝各 `apply` 一次
 * ——**每次掛載才有的狀態一律活在 `apply` 裡**。
 */
export const presentPlugin: NexusPlugin<PresentConfig> = {
  name: 'present',
  Config: presentConfigSchema,
  apply(registry: PluginRegistry, config: PresentConfig): void {
    const { maxFiles } = config;
    /** 還在等結果的訂閱，依 `callId`。見檔頭「一個 `callId` 只留一個」。 */
    const waiting = new Map<string, () => void>();
    registry.lifecycle.onDispose(() => {
      for (const unsubscribe of waiting.values()) unsubscribe();
      waiting.clear();
    });
    registry.tools.register(
      tool(
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
          const found = registry.sessions.forCall(config);
          if (callId === undefined || found.kind !== 'ok') {
            return refuse(PRESENT_NO_SESSION_MESSAGE);
          }
          if (requested.length === 0 || requested.length > maxFiles) {
            return refuse(presentCountMessage(maxFiles));
          }
          // **被叫時才讀**：`fs` 那一格要等 fold 折完才有值，見檔頭最後一段。
          const backend = registry.services.get(FS_SERVICE)?.backend();
          if (!registry.capabilities.has(WORKSPACE_CAPABILITY) || backend === undefined) {
            return refuse(PRESENT_NO_WORKSPACE_MESSAGE);
          }
          // 不在工作區磁碟上的前綴：組裝點交的那幾格，加上 plugin 自己 `backend.mount()` 掛的。**被叫時才讀**，
          // 理由同上面的 backend——mount 在每顆 plugin 的 `apply` 裡才註冊進來。
          const offWorkspace = [
            ...(registry.services.get(FS_SERVICE)?.offWorkspacePrefixes() ?? []),
            ...registry.backend.mounts().map(([prefix]) => prefix),
          ];
          const files: PresentedFile[] = [];
          for (const file of requested) {
            if (file.path.trim().length === 0) return refuse(PRESENT_EMPTY_PATH_MESSAGE);
            if (isUnderPrefix(virtualPathOf(file.path), offWorkspace)) {
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
          const { log } = found;
          waiting.get(callId)?.();
          const unsubscribe = log.subscribe(async (event) => {
            if (event.type !== 'tool/result' || event.data.callId !== callId) return;
            unsubscribe();
            if (waiting.get(callId) === unsubscribe) waiting.delete(callId);
            if (event.data.isError) return;
            // 還在日誌的發佈回呼裡，現在寫會撞重入防護。見檔頭。
            await Promise.resolve();
            log.append('deliverables/presented', { callId, files });
          });
          waiting.set(callId, unsubscribe);
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
      ),
    );
  },
};

export default presentPlugin;

/**
 * 建一個條目。**薄薄一層**：設定不在這裡驗，驗在載入的時候——那時候才有 id 可以指名。
 *
 * @param options - 設定，形狀見 {@link presentConfigSchema}。
 * @returns 可以放進組裝點清單的條目。
 */
export function createPresentPlugin(options: PresentPluginOptions = {}): PluginEntry {
  return { plugin: presentPlugin, config: options };
}
