/**
 * **每條新 thread 的私有可寫根**，與退成唯讀共用區的 `--workspace`
 * （[#1775](https://github.com/DemianLi/nexus-agent/issues/1775)，#1675 卡 C；前置 #1774 的「thread → 可寫根」）。
 *
 * 盤點 `:64` 的失敗是一台主機多人共用同一個可寫根：使用者 A 在自己的對話裡產出的檔，使用者 B 在另一條對話問「工作區裡有什麼」就列得到。
 * 這一支回答「這條 thread 的可寫根是哪個」：
 *
 * | 這條 thread | 可寫根 | 唯讀共用區 |
 * | --- | --- | --- |
 * | 新 thread（沒有 header） | `<home>/thread-roots/thread-<鑰匙雜湊>`，目錄 0700，記進 header | `--workspace`，掛在 {@link SHARED_WORKSPACE_PREFIX} |
 * | 續接，header 的根就是這一次的 `--workspace` 根 | `--workspace`（舊 thread，Q6 (a)） | 沒有 |
 * | 續接，header 沒有那一格（格式 13 以前） | `--workspace`（今天「沒記就放行」的行為） | 沒有 |
 * | 續接，header 的根是基底的直接子目錄 | 照用 header 的根（分叉的子 thread 走這條，#1580） | `--workspace` |
 * | 續接，其他 | 拋 {@link ResumeWorkspaceConflictError} | — |
 *
 * **續接一律讀 header，不用 thread id 重算**：雜湊規則或基底以後變了，已經配出去的根照樣找得回來。
 *
 * ## 偏離登記（與 dsh 的偏離，理由 2：產品需求超出 dsh 的射程；PM 2026-10-20 核定共兩條）
 *
 * 1. **系統替每條新 thread 配根，不由人選、也不按專案共用。**
 *    dsh 是單人桌面：根是會話 header 的 `cwd`，逐次從 header 取（`packages/sandbox/sandbox-policy/src/index.ts:83`、`:164-171`，`687f282e`），
 *    子代理沿用父會話的 `cwd`（`packages/subagent/subagent/src/child-agent.ts:144`），分叉照抄來源（`packages/api/session-controller/src/commands.ts:281`）；
 *    新會話的 `cwd` 由建立者給（`commands.ts:112-113`、`:124`）。同專案的會話共用根沒有隱私問題。nexus 一台主機多人共用，共用根就是盤點 `:64` 的失敗。
 *    機制照 dsh：根記在 header、逐次從 header 取、子代理沿用、分叉照抄。**補的是出生配根那一步**，dsh 沒有「系統替每個會話配一個目錄」。
 * 2. **`--workspace` 退成唯讀共用區，且不吃升級**（登記在掛這條路由的地方，`agent-factory.ts` 的 `sharedWorkspace`）。**這一條有兩個延伸，都併在這裡**：
 *    - **工作區指示檔從共用區讀**（卡第 10 項；agent-instructions 檔頭同一句）：部署方放在 `--workspace` 的指示照舊生效，模型寫進自己私有根的
 *      `AGENTS.md` 不會變成系統指示。
 *    - **落盤關掉（#612）時，新 thread 的可寫根是記憶體**（PM 裁決 (f)，#1775 issuecomment-6314481471；子代理建議、PM 採納、demian 可推翻）。
 *      沒有會話日誌就沒有 header、沒有續接，也沒有會話鑰匙，私有根沒有身分可掛；部署方關掉落盤本來就是為了隱私，退回共用 `--workspace` 會讓盤點 `:64`
 *      在這種組合下重現（等於替 #1675 Q1 (a) 開了例外）。所以這種 thread 的可寫根是虛擬檔案系統（跟沒給 `--workspace` 時一樣，`root` 是 `undefined`），
 *      `--workspace` 照樣以唯讀共用區掛上。先例：落盤關掉時工具結果暫存退回記憶體（`serve.ts`）、這種 thread 不逐出（`serve.ts` 的閒置逐出）。
 *      代價：**重啟就沒了**；這種 thread 沒有磁碟上的可寫根，所以沒有圍堵（`--sandbox`、`/permission` 的檔案政策、`present`、`@` 列檔、改動摘要都跟沒給
 *      `--workspace` 一樣不適用）。啟動 warn、`docs/operations.md`、PR 內文三處都寫「偏離 2 的延伸」。
 *
 * ## 對卡的選擇（不是對 dsh 的偏離）
 *
 * - **基底寫死在 `<home>/thread-roots`，不開成設定列。** 卡第 1 項寫「可由設定列改」，PM 補充第 3 件給了兩條路，這裡選「寫死」。
 *   設定列可以把基底設成 home 本身或 home 的上層，home 根目錄那一層的狀態檔（設定雜湊鍵檔、量測記錄、瀏覽器會話密鑰、home 的 `.env`、
 *   `serve.lock`、metrics-token、plugin-journal）就會落進某條 thread 的根；寫死以後這一類不存在，要換位置是換 `HARNESS_HOME`。
 *   基底與 `--workspace`、工具結果暫存根、附件根、會話日誌目錄的重疊仍然檢查（{@link assertThreadRootsBaseSeparate}）：其中暫存根與會話日誌目錄是可設定的，
 *   而且重疊可以經符號連結造出來（`<home>/thread-roots` 本身是指向 `--workspace` 的連結時，home 沒有重疊，#1620 不會響），所以比的是 canonicalize 之後的位置。
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { canonicalize, isWithin } from './canonical-path.js';
import { resolveHarnessHome } from './harness-home.js';
import { assertPrivateFile } from './plugin-config.js';
import type { PrivateFileRole } from './plugin-config.js';
import { assertSameWorkspaceRoot, ResumeWorkspaceConflictError } from './resume-guards.js';

import type { StoredSessionHeader } from '@nexus/core';

/** 基底在 harness home 底下的名字。 */
export const THREAD_ROOTS_DIR_NAME = 'thread-roots';

/**
 * 唯讀共用參考區在模型位址空間裡的前綴。
 *
 * 不能撞到 `/attachments`、`/large_tool_results`、`/conversation_history`（組裝點掛的三格），也不能撞到插件用 `backend.mount()` 掛的前綴
 * （`backends.insert` 的撞名檢查只比插件之間，擋不到這一條——插件的路由包在組裝點那層的外面，會先接住請求、遮住唯讀路由；所以組裝點把這個前綴交給
 * `foldRegistry` 的 `reservedBackendPrefixes`，插件掛了重疊的前綴，組裝當場拋）。
 */
export const SHARED_WORKSPACE_PREFIX = '/shared';

/** 目錄權限：只有目前使用者進得去。 */
const DIR_MODE = 0o700;

const THREAD_ROOT_ROLE: PrivateFileRole = {
  subject: '私有可寫根',
  why: '別人進得去或換得掉這個目錄，這條對話的檔就不再是私有的。',
};

/** {@link threadRootDirName} 產生的名字，整個名字精確比對。 */
const THREAD_ROOT_DIR_RE = /^thread-[0-9a-f]{32}$/;

/**
 * 基底：`<harness home>/thread-roots`。
 *
 * @param env - 同 {@link resolveHarnessHome}。
 */
export function resolveThreadRootsBase(env: Readonly<Record<string, string | undefined>>): string {
  return join(resolveHarnessHome(env), THREAD_ROOTS_DIR_NAME);
}

/**
 * 一條 thread 的根目錄名：`thread-` 加鑰匙雜湊的前三十二個十六進位字。**不用 `session-` 前綴**：那個形狀是工具結果暫存的，
 * 暫存的清掃會碰合 `^session-[0-9a-f]{16}$` 的目錄（`tool-result-stash.ts`），名字形狀不同才不會被它掃到。
 * 鑰匙本身（路徑、thread id）不進檔名。
 *
 * @param key - 會話鑰匙（`${sessionStore.directory}\0${threadId}`，跟工具結果暫存同一把）。
 */
export function threadRootDirName(key: string): string {
  return `thread-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

/** 這個絕對路徑是不是 `base` 的直接子目錄，而且名字是 {@link threadRootDirName} 的形狀。**逐字比，不 realpath**（同續接守衛）。 */
export function isThreadRootOf(base: string, path: string): boolean {
  return dirname(path) === base && THREAD_ROOT_DIR_RE.test(basename(path));
}

/** 把一條 thread 放在哪裡。 */
export interface ThreadPlacement {
  /** 這條 thread 的可寫根（主機上的絕對路徑）；`undefined` 是沒有磁碟上的可寫根（沒給 `--workspace`，或落盤關掉的新 thread），檔案在虛擬檔案系統裡。 */
  readonly root: string | undefined;
  /** 唯讀共用區的根（`--workspace`）；有私有可寫根、或落盤關掉的新 thread（記憶體根）時才有。 */
  readonly sharedRoot?: string;
  /**
   * 可寫根就是新 thread 讀的共用區（舊 thread）。組裝點據它擋住這條 thread 寫新 thread 會讀成指示或技能的地方
   * （[#1960](https://github.com/DemianLi/nexus-agent/issues/1960)）。
   */
  readonly rootIsShared?: true;
}

/** {@link ThreadPlacer} 的參數。 */
export interface ThreadPlacementRequest {
  /** 哪個入口在接（`serve`），守衛的訊息開頭講的就是它。 */
  readonly entry: string;
  readonly threadId: string;
  /** 續接讀回來的 header；新 thread 是 `undefined`。 */
  readonly resumedHeader: StoredSessionHeader | undefined;
}

/** 「thread（連同它的 header）→ 放在哪裡」。可能要建目錄，所以是非同步的。 */
export type ThreadPlacer = (request: ThreadPlacementRequest) => Promise<ThreadPlacement>;

/** {@link createThreadPlacer} 的參數。 */
export interface ThreadPlacerOptions {
  /** `--workspace` 解析出來的根（`resolveWorkspaceRoot`）；沒給就沒有圍堵、也就沒有私有根。 */
  readonly sharedRoot: string | undefined;
  /** 基底的絕對路徑（{@link resolveThreadRootsBase}）。 */
  readonly base: string;
  /**
   * 這條 thread 的會話鑰匙；落盤關掉（沒有 `sessionStore`）時是 `undefined`，那時可寫根是記憶體（偏離 2 的延伸）。
   */
  readonly sessionKeyOf: ((threadId: string) => string) | undefined;
}

/**
 * 產品路徑的 placer：新 thread 配私有根，續接照 header 分類（見檔頭表格）。
 */
export function createThreadPlacer(options: ThreadPlacerOptions): ThreadPlacer {
  const shared = options.sharedRoot;
  return async ({ entry, threadId, resumedHeader }) => {
    // 沒給 `--workspace`：沒有圍堵，也就沒有共用區可退，一律沒有根（serve 沒給 `--workspace` 不變）。
    if (shared === undefined) return { root: undefined };
    if (resumedHeader !== undefined) {
      const recorded = resumedHeader.workspaceRoot;
      // header 沒有那一格（格式 13 以前）＝舊 thread，今天「沒記就放行」的行為：以共用區為可寫根。
      // 與 header 的根就是這一次的共用區根一樣，舊 thread 的可寫根本來就是共用區，不再另掛唯讀那條。
      if (recorded === undefined || recorded === shared)
        return { root: shared, rootIsShared: true };
      // 落在這一次基底底下：照用 header 的根（分叉的子 thread 抄來源的根，走的就是這條，不另配）。
      // header 那一格沒驗證過（`parseHeader` 直接 cast）：不是字串的畸形值一律往下掉到拒絕，不拋 TypeError。
      if (typeof recorded === 'string' && isThreadRootOf(options.base, recorded)) {
        await ensurePrivateRoot(options.base, recorded);
        return { root: recorded, sharedRoot: shared };
      }
      // 其他（換過 `--workspace`、換過基底、header 畸形）：拒絕，例外訊息指名兩個根。
      // **出路依根的名字形狀分兩種**：名字是 `thread-<32 hex>`＝這是某個人的私有根（多半是換過 home / `NEXUS_AGENT_HOME`），
      // 出路是換回原來的 home；**絕不能叫人把它當 `--workspace`**——照做的話，那個人的私有根會變成所有新 thread 的 `/shared`。
      const privateShaped =
        typeof recorded === 'string' && THREAD_ROOT_DIR_RE.test(basename(recorded));
      throw new ResumeWorkspaceConflictError(
        entry,
        threadId,
        shared,
        // 畸形值（不是字串）在這裡轉成字串只為了訊息；比對已經失敗，不會走到下面。
        String(recorded),
        privateShaped
          ? `這是一個私有根（不在目前的私有根基底 ${options.base} 底下），多半是換過 harness home（NEXUS_AGENT_HOME）。` +
              '換回原來的 home 再接；不要把它當 --workspace 給——那會讓這條對話的私有根變成所有新對話都讀得到的共用區。'
          : `這條對話記的根既不是 --workspace，也不在私有根基底 ${options.base} 底下。用 --workspace ${String(recorded)} 再接。`,
        privateShaped,
      );
    }
    // 新 thread：落盤關掉就沒有磁碟上的可寫根（偏離 2 的延伸，(f)）：`root` 明著回 `undefined`＝記憶體，`--workspace` 照樣掛成唯讀共用區。
    // **這是唯一收這個判斷的地方**。
    if (options.sessionKeyOf === undefined) return { root: undefined, sharedRoot: shared };
    const root = join(options.base, threadRootDirName(options.sessionKeyOf(threadId)));
    await ensurePrivateRoot(options.base, root);
    return { root, sharedRoot: shared };
  };
}

/**
 * 測試接縫用的 placer：根由呼叫端給（A 回 X、B 回 Y），沒有私有根與共用區，續接守衛照 #504 的逐字比。
 * 產品路徑不走這一支。
 */
export function createFixedThreadPlacer(
  workspaceRootOf: (threadId: string) => string | undefined,
): ThreadPlacer {
  return ({ entry, threadId, resumedHeader }) => {
    try {
      const root = workspaceRootOf(threadId);
      if (resumedHeader !== undefined)
        assertSameWorkspaceRoot(entry, threadId, resumedHeader, root);
      return Promise.resolve({ root });
    } catch (error) {
      return Promise.reject(error);
    }
  };
}

/**
 * 建基底與這條 thread 的根（0700），並確認它真的私有。冪等：根已經在（續接、配完根 header 還沒寫就當掉）就只驗。
 *
 * - 只收緊**自己建的**那一層（`mkdir` 的 mode 受 umask，建出來的明著再 `chmod` 一次）；已存在的只驗，不替別人改權限。
 * - 根必須是真目錄、不是符號連結（`lstat`），而且群組與其他人完全沒有權限（`& 0o077`）；上層可寫、不屬於我們也拒（`assertPrivateFile`）。
 */
async function ensurePrivateRoot(base: string, root: string): Promise<void> {
  const createdBase = await mkdir(base, { recursive: true, mode: DIR_MODE });
  if (createdBase !== undefined) await chmod(base, DIR_MODE);
  const createdRoot = await mkdir(root, { recursive: true, mode: DIR_MODE });
  if (createdRoot !== undefined) await chmod(root, DIR_MODE);
  const stats = await lstat(root);
  if (!stats.isDirectory()) {
    throw new Error(
      `私有可寫根 ${root} 不是目錄（或是符號連結），拒絕使用。${THREAD_ROOT_ROLE.why}`,
    );
  }
  /* v8 ignore next -- Windows 沒有 geteuid，POSIX 的測試走下面那條。 */
  if (process.geteuid !== undefined && (stats.mode & 0o077) !== 0) {
    throw new Error(
      `私有可寫根 ${root} 群組或其他人有權限（mode ${(stats.mode & 0o777).toString(8)}），拒絕使用。${THREAD_ROOT_ROLE.why}`,
    );
  }
  try {
    assertPrivateFile(root, THREAD_ROOT_ROLE);
  } catch (error) {
    // `assertPrivateFile` 的訊息是為啟動時的檢查寫的（「拒絕啟動」）；這裡是某條 thread 組裝當下，serve 早就起來了，不改的話訊息講錯。
    // 啟動時的同一個檢查在 {@link verifyThreadRootsBase}，所以正常情況到不了這裡。
    if (error instanceof Error) {
      throw new Error(error.message.replaceAll('拒絕啟動', '這條對話建不起來'), { cause: error });
    }
    throw error;
  }
}

/**
 * **啟動時先驗一次基底**（建議項，不是卡上的驗收）：基底已經在的話，它與它的上層目錄的擁有者與權限現在就驗，壞了讓 serve 起不來，
 * 不等到第一條新 thread 組裝才拋。基底還不在就不建（沒有新 thread 之前不留東西），那時改驗 home。
 *
 * @param base - 基底的絕對路徑。
 * @throws 基底（或 home）不屬於目前使用者、群組或其他人可寫、或上層目錄別人換得掉。
 */
export function verifyThreadRootsBase(base: string): void {
  const home = dirname(base);
  for (const candidate of [base, home]) {
    try {
      lstatSync(candidate);
    } catch {
      continue;
    }
    assertPrivateFile(candidate, THREAD_ROOT_ROLE);
    return;
  }
}

/** {@link assertThreadRootsBaseSeparate} 的參數。 */
export interface ThreadRootsOverlapCheck {
  /** 基底的絕對路徑。 */
  readonly base: string;
  /** 其餘要比的路徑，各帶一個名字（訊息點名是哪一對）。 */
  readonly others: readonly { readonly label: string; readonly path: string }[];
}

/**
 * **基底不能跟下面這些路徑重疊**（兩個方向都算：在裡面、就是它、包含它；各自 canonicalize 之後比，同 #1620 的寫法），重疊就拋，點名是哪一對：
 *
 * - `--workspace`：它是唯讀共用區；基底落在裡面，模型就能經共用前綴讀到所有人的私有根。
 * - 工具結果暫存根：暫存清掃會碰合 `^session-…` 的目錄，而它的根可由設定列改。
 * - 附件根、會話日誌目錄：都是基礎建設，不是任何一條 thread 的工作區。
 *
 * 基底寫死在 home 底下，所以 home 本身與 home 根目錄那一層的狀態檔不可能落進任何一條 thread 的根（對卡的選擇：基底寫死，見上面〈對卡的選擇〉；不是對 dsh 的偏離）。
 */
export async function assertThreadRootsBaseSeparate(check: ThreadRootsOverlapCheck): Promise<void> {
  const base = await canonicalize(resolve(check.base));
  const overlaps: string[] = [];
  for (const other of check.others) {
    const real = await canonicalize(resolve(other.path));
    const relation =
      real === base
        ? '就是私有根基底'
        : isWithin(base, real)
          ? '在私有根基底之內'
          : isWithin(real, base)
            ? '包含私有根基底'
            : undefined;
    if (relation === undefined) continue;
    overlaps.push(
      `- ${other.label}：${other.path}${real === other.path ? '' : `（實際位置 ${real}）`}，${relation}`,
    );
  }
  if (overlaps.length === 0) return;
  throw new Error(
    `serve 起不來：私有根基底 ${check.base} 跟下面這些重疊。\n${overlaps.join('\n')}\n` +
      '基底底下是每條新對話自己的可寫根；跟這些路徑重疊，要嘛模型經共用前綴讀得到別人的私有根，要嘛基礎建設的檔落進某條對話的根。' +
      '出路：把重疊的那個路徑改到基底外面（工具結果暫存的 root、--session-log），或換一個 HARNESS_HOME。',
  );
}
