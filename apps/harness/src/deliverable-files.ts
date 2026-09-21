/**
 * 讀一個**宣告過的**交付檔（[#452](https://github.com/DemianLi/nexus-agent/issues/452) 第二刀）。
 *
 * 兩條路由（預覽、下載）共用的那一半：把 `(seq, index)` 這個座標換成磁碟上的一個檔，或是一個
 * 講得出理由的拒絕。HTTP 那一半在 {@link ./wire-handler.ts}。
 *
 * 照 dsh 的 `workspace-files`（`packages/api/workspace-files/src/index.ts`，`ddefc45`）。
 *
 * ## 錨怎麼選的
 *
 * 一條續接回來的 thread，日誌裡混著兩群事件：**續接線以下**的（上一個行程寫的）與**以上**的
 * （這個行程寫的）。以 thread 為單位的閘會同時誤殺後者、放過前者，所以分界是逐事件的
 * `seq < storedCount`——而 `storedCount` 就是接回來那批的長度，`SessionLog` 的 `#adoptSeed`
 * 釘死 `event.seq === index`，所以這個比較是精確的，不是估計。
 *
 * 線**以下**的今天一律拒。原本的理由是「會話日誌沒有記工作區根那一格，所以上一個行程當時的根
 * 無從得知」——[#504](https://github.com/DemianLi/nexus-agent/issues/504) 把那一格加上去了，所以
 * **理由換了一半，結論沒換**：
 *
 * - **格式 13 以前寫的日誌永遠沒有那一格**（續接不回填），那些仍然無從得知，仍然是上面那句話。
 * - **13 以後寫的有**，而且續接時 `assertSameWorkspaceRoot` 已經擋下「同一個 cwd、不同的
 *   `--workspace`」，所以 `header.workspaceRoot` 在場時它就等於今天這台 server 的根。那條線
 *   因此**放寬得了**——「有那一格就准用今天的根」加上把 `header.workspaceRoot` 從 `ThreadAgent`
 *   串到這裡。**那是另一張卡**，#504 明著寫了它不改這條路由今天的行為。
 *
 * 讀錯檔的樣子仍然要寫著，因為放寬的那天它就是要防的東西：用今天這台 server 的 `--workspace`
 * 去讀昨天的路徑，讀到的會是另一個工作區裡的同名檔，而畫面上跟讀對了一模一樣。**不猜、直接拒**
 * 不是新發明：`assertSameCwd` 對 `header.cwd === undefined` 的處置就是拒絕。
 *
 * ## 為什麼錨是呼叫端交出來的，不是從 `threadFor` 拿的
 *
 * **不是成本考量，是正確性。** 從 `threadFor` 拿到的是**這一次組裝**的 backend；對一顆重播的事件
 * 而言那就是錯的錨——它不是通往修復的路，它就是那個 bug。這裡用的根是呼叫端明著交出來的那一個，
 * 而呼叫端只在 `seq >= storedCount` 時才有資格交。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **預覽也吃 `maxFileBytes`。** dsh 的檔案本身沒有大小上限（`Config.maxBytes` 的檔頭：「The file
 *    itself has no size cap: a caller pages through it」），因為它 `streamText` 串流。我們這條路
 *    整檔讀進來再切頁，所以超過 `maxFileBytes` 的文字檔預覽不了，回 413。頁的上限照 dsh：
 *    **拒絕，不截斷**。
 * 2. **不回 `absolutePath`**，理由見 `@nexus/wire` 的 `DeliverableFileStat`。
 * 3. **`/conversation_history` 那層 overlay 不在這條路上**（`agent-factory.ts` 的 `foldRegistry`）：
 *    模型宣告當下走的是折過的 backend，那一層會把 `/conversation_history` 底下的路徑導到別的地方；
 *    這條路直接解到工作區裡的同名檔。實務上 `present` 宣告的是工作區裡的產出，不是那層 overlay
 *    的內容，但這是一條真的分岔，登記在此。
 * 4. **不經基座的檔案 backend 讀**（#452 決議字面寫「自己建一個唯讀 backend」）：理由是量出來的
 *    ——基座那支會弄壞二進位檔，逐字見 {@link readDeliverableBytes}。偏離的是載體，決議給的紀律
 *    （錨由這條路由自己挑）原封不動。
 *
 * @module
 */

import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import type { SessionEvent } from '@nexus/core';
import { virtualPathOf } from '@nexus/plugin-present';
import type { DeliverableFilePage, DeliverableFileStat } from '@nexus/wire';

/**
 * 一頁文字的位元組上限，照 dsh 的 `maxBytes`（2 MiB）。
 *
 * **超標是拒絕，不是切短**——dsh 的理由逐字：「a silently cut page reads as the whole page」。
 */
export const DELIVERABLE_MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** 整檔讀取的上限，照 dsh 的 `maxFileBytes`（32 MiB）。下載與預覽都吃它（見檔頭偏離 1）。 */
export const DELIVERABLE_MAX_FILE_BYTES = 32 * 1024 * 1024;

/** 一頁的預設與最大行數，照 dsh 的 `maxLines`（5000）。要更多是拒絕，不是給到上限為止。 */
export const DELIVERABLE_MAX_LINES = 5000;

/** 文字不會帶的那個位元組；它在就代表這個檔不是文字。照 dsh 的 `NUL`。 */
const NUL = String.fromCharCode(0);

/**
 * 拒絕的理由。**每一個都對應到前端一個不同的動作**，所以不能壓成同一種：`not-text` 要前端改
 * 提供下載，`no-anchor` 要前端把卡片標成讀不到，兩者長得完全不一樣。
 */
export type DeliverableRefusal =
  /** 座標不是非負整數、或 `limit` 超過上限。 */
  | 'bad-request'
  /** 這顆座標這台 server 錨不住（線以下的重播事件、或這條 thread 不在服務中）。 */
  | 'no-anchor'
  /** 那個座標上沒有交付事件、沒有那個 index、或檔案不在磁碟上。 */
  | 'not-found'
  /** 最後一段是符號連結、目錄、或別的非一般檔。 */
  | 'not-regular-file'
  /** 超過整檔或單頁的上限。 */
  | 'too-large'
  /** 解出來的文字含 NUL 位元組。 */
  | 'not-text';

/** 成功，或一個講得出理由的拒絕。 */
export type DeliverableResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused'; readonly reason: DeliverableRefusal; readonly message: string };

function refuse<T>(reason: DeliverableRefusal, message: string): DeliverableResult<T> {
  return { kind: 'refused', reason, message };
}

/**
 * 把 `(seq, index)` 換成模型當初宣告的那個路徑字串。
 *
 * **線以下的一律拒**，見檔頭。線以上的要通過三道形狀檢查：那個 `seq` 上真的有事件、它真的是
 * `deliverables/presented`、而且真的有第 `index` 個檔。
 *
 * 那道型別檢查不只是防呆——**它是子代理那條路的封口**。子代理宣告的交付落在子代理自己的日誌裡
 * （`@nexus/wire` 的 `deliverables.ts` 檔頭：「只有 root 那一份」），root 日誌的同一個 `seq` 上
 * 是別的事件，於是這裡拒絕。少了它，一個亂給的座標會落到一顆無關的事件上。
 *
 * @param events - root 日誌這一刻的全部事件，`seq === index`。
 * @param storedCount - 接回來那批的長度；沒續接就是 0。
 * @param seq - 那顆 `deliverables/presented` 的位置。
 * @param index - 它在 `files` 裡的位置。
 * @returns 模型給的原路徑字串，或拒絕。
 */
export function locateDeliverable(
  events: readonly SessionEvent[],
  storedCount: number,
  seq: number,
  index: number,
): DeliverableResult<string> {
  if (seq < storedCount) {
    return refuse(
      'no-anchor',
      `讀不到：seq ${seq} 那顆交付是上一個行程寫的，而這條路由手上沒有它當時的工作區根` +
        `——格式 13 以前的日誌根本沒記，13 以後記了但這條路由還沒去讀。` +
        `不能拿這一次的 --workspace 去讀它宣告的路徑（#504）。`,
    );
  }
  const event = events[seq];
  if (event?.type !== 'deliverables/presented') {
    return refuse('not-found', `讀不到：seq ${seq} 上沒有交付宣告。`);
  }
  const file = event.data.files[index];
  if (file === undefined) {
    return refuse('not-found', `讀不到：seq ${seq} 那次宣告沒有第 ${index} 個檔。`);
  }
  return { kind: 'ok', value: file.path };
}

/** 一個已經通過所有閘門的交付檔。 */
export interface LocatedDeliverable {
  /** 磁碟上的絕對路徑。 */
  readonly target: string;
  /** 回給前端的身分，`path` 是模型給的原字串。 */
  readonly stat: DeliverableFileStat;
}

/**
 * 走完一個一般檔的所有閘門，最後那一次 `stat` 就是 `version` 與 `bytes` 的來源。
 *
 * 順序照 dsh 的 `locateFile`／`inspect`：**先擋路徑本身，再讓任何東西跟著它走**。
 *
 * - `virtualPathOf` 把模型給的原字串正規化成一條虛擬絕對路徑（`..` 在這一步被 `posix.normalize`
 *   吃掉，所以它不可能往上逃）。**這一份是從 `@nexus/plugin-present` 匯入的**，不是複製的：
 *   事件裡存的是原字串，正規化的結果不落庫，兩邊各寫一次的下場是有一天只有一邊擋。
 * - **父目錄先 `realpath`**，然後要求它落在工作區根的 realpath 之內。這一步擋的是中途某一層
 *   目錄是符號連結、指到工作區外的情況——`virtualMode` 的圍堵是 lexical 的（基座 `resolvePath`
 *   的檔頭自己寫著），lexical 擋不到它。
 * - **最後一段 `lstat`**：是符號連結就拒，照 dsh 的 `inspect`（「Gate on the path itself before
 *   anything follows it」）——**不是** `openVerified`，那支是 dsh 桌面端的路徑往返對映，跟讀檔無關。
 *
 * @param rootDir - 這一次的工作區根，呼叫端交出來的錨。
 * @param declaredPath - 模型宣告時給的原字串。
 * @returns 通過所有閘門的檔，或拒絕。
 */
export async function locateDeliverableFile(
  rootDir: string,
  declaredPath: string,
): Promise<DeliverableResult<LocatedDeliverable>> {
  const virtual = virtualPathOf(declaredPath);
  if (virtual === '/') return refuse('not-regular-file', `讀不到：${declaredPath} 是工作區根。`);
  const lexical = join(rootDir, virtual);
  let root: string;
  let parent: string;
  try {
    root = await realpath(rootDir);
    parent = await realpath(dirname(lexical));
  } catch {
    return refuse('not-found', `讀不到：${declaredPath} 的所在目錄不在了。`);
  }
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
    return refuse('not-found', `讀不到：${declaredPath} 解出來落在工作區外。`);
  }
  const target = resolve(parent, basename(lexical));
  let link: Awaited<ReturnType<typeof lstat>>;
  try {
    link = await lstat(target);
  } catch {
    return refuse('not-found', `讀不到：${declaredPath} 不在了。`);
  }
  if (link.isSymbolicLink()) {
    return refuse('not-regular-file', `讀不到：${declaredPath} 是符號連結。`);
  }
  if (!link.isFile()) {
    return refuse('not-regular-file', `讀不到：${declaredPath} 不是一般檔案。`);
  }
  // **再 stat 一次**，同 dsh 的理由逐字：「The stat re-checks what `lstat` saw: the file may have
  // gone or changed kind in between.」
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
    return refuse('not-found', `讀不到：${declaredPath} 不在了。`);
  }
  if (!info.isFile()) {
    return refuse('not-regular-file', `讀不到：${declaredPath} 不是一般檔案。`);
  }
  return {
    kind: 'ok',
    value: {
      target,
      stat: {
        path: declaredPath,
        // **不透明的新鮮度標記，前端不解析**（同 dsh 的 `version`）。內容換了就變，是它唯一的契約。
        version: `${info.mtimeMs.toString(36)}-${info.size.toString(36)}`,
        bytes: info.size,
      },
    },
  };
}

/**
 * 讀整份位元組，**吃整檔上限**。
 *
 * ## 為什麼不經基座的 `readRaw`
 *
 * **因為它會弄壞二進位檔，這是量出來的。** 拿一個 6 位元組的檔
 * （`00 01 02 03 ff fe`）餵 `ContainedFilesystemBackend.readRaw`，回來的 `content` 的形狀是
 * `string`——它把那串位元組當 UTF-8 解掉了，再編碼回去變成 10 個位元組，而 `error` 是
 * `undefined`、`mimeType` 也沒說它是二進位。**一張 PNG 走那條路下載下來是壞的，而且全程沒有
 * 任何徵兆。**（同一份量測裡，一個帶 BOM、CRLF、沒有結尾換行的文字檔倒是位元組相同——所以
 * 這個缺陷只在二進位那一側，正好是下載最需要它對的那一側。）
 *
 * 型別上也看得到同一件事：基座的 `FileData` 是聯集，其中一支的 `content` 是**行陣列**，
 * 那個形狀連「有沒有結尾換行」都表達不出來。
 *
 * 所以這裡直接讀 {@link LocatedDeliverable.target}——那條路徑已經通過
 * {@link locateDeliverableFile} 的每一道閘門（realpath 圍堵 ＋ `lstat` 擋符號連結 ＋ 兩次
 * `stat`），而那道閘門比基座的 lexical 圍堵**更嚴**，不是更鬆。
 *
 * **這是對 #452 決議字面的一處偏離**（決議寫「路由自己建一個唯讀 backend」），但它保住了
 * 決議給的**理由**：錨由這條路由自己挑，不是從 `threadFor` 繼承來的。偏離的是載體，不是紀律。
 *
 * @param located - 已經通過閘門的檔。
 * @returns 原始位元組，或拒絕。
 */
export async function readDeliverableBytes(
  located: LocatedDeliverable,
): Promise<DeliverableResult<Uint8Array>> {
  if (located.stat.bytes > DELIVERABLE_MAX_FILE_BYTES) {
    return refuse(
      'too-large',
      `讀不到：${located.stat.path} 有 ${located.stat.bytes} 位元組，超過 ` +
        `${DELIVERABLE_MAX_FILE_BYTES} 的上限。上限是拒絕，不是截斷。`,
    );
  }
  // **上限綁在讀本身，不是只綁在前面那次 stat 上。** 只看 stat 的話，兩次之間長大的檔就整份
  // 進記憶體了——這台機器是多人共用的。緩衝區開 `min(當時的大小, 上限) + 1`：那個 +1 就是
  // 「它長大了」的偵測器。dsh 同樣把上限傳進讀裡（`readAll` 的 `maxFileBytes`）。
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(located.target, 'r');
  } catch {
    return refuse('not-found', `讀不到：${located.stat.path} 不在了。`);
  }
  try {
    const room = Math.min(located.stat.bytes, DELIVERABLE_MAX_FILE_BYTES) + 1;
    const buffer = Buffer.alloc(room);
    const { bytesRead } = await handle.read(buffer, 0, room, 0);
    if (bytesRead > DELIVERABLE_MAX_FILE_BYTES) {
      return refuse(
        'too-large',
        `讀不到：${located.stat.path} 讀的時候已經超過 ${DELIVERABLE_MAX_FILE_BYTES} 的上限。`,
      );
    }
    return { kind: 'ok', value: buffer.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

/**
 * 切一頁文字出來。
 *
 * `offset` 是行偏移（0 起算），`limit` 是這一頁最多幾行。**要超過 {@link DELIVERABLE_MAX_LINES}
 * 是拒絕**，不是給到上限為止——同 dsh 的 `maxLines`（「a request asking for more is refused」）。
 *
 * @param located - 已經通過閘門的檔。
 * @param offset - 從第幾行起。
 * @param limit - 最多幾行。
 * @returns 一頁，或拒絕。
 */
export async function readDeliverablePage(
  located: LocatedDeliverable,
  offset: number,
  limit: number,
): Promise<DeliverableResult<DeliverableFilePage>> {
  if (limit > DELIVERABLE_MAX_LINES) {
    return refuse('bad-request', `limit 最多 ${DELIVERABLE_MAX_LINES} 行，收到 ${limit}。`);
  }
  const bytes = await readDeliverableBytes(located);
  if (bytes.kind === 'refused') return bytes;
  const text = new TextDecoder().decode(bytes.value);
  // **整份掃一次 NUL**，不是只掃這一頁：一個檔是不是文字是它自己的性質，不是某一頁的性質。
  // dsh 掃的是頁，因為它串流、看不到還沒讀的部分；我們整檔都在手上，掃整份才不會讓第 0 頁
  // 說「是文字」、第 3 頁才說「不是」。
  if (text.includes(NUL)) {
    return refuse('not-text', `讀不到：${located.stat.path} 含 NUL 位元組，不是 UTF-8 文字。`);
  }
  const all = text.split('\n');
  // 最後一行後面的換行不算一行。
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  const page = all.slice(offset, offset + limit);
  const pageText = page.join('\n');
  const pageBytes = new TextEncoder().encode(pageText).length;
  if (pageBytes > DELIVERABLE_MAX_PAGE_BYTES) {
    return refuse(
      'too-large',
      `讀不到：${located.stat.path} 的這一頁有 ${pageBytes} 位元組，超過 ` +
        `${DELIVERABLE_MAX_PAGE_BYTES} 的上限。上限是拒絕，不是截斷——切短的一頁看起來就是整頁。`,
    );
  }
  return {
    kind: 'ok',
    value: {
      ...located.stat,
      offset,
      text: pageText,
      lines: page.length,
      eof: offset + page.length >= all.length,
    },
  };
}
