/**
 * 讀一個**宣告過的**交付檔（[#452](https://github.com/DemianLi/nexus-agent/issues/452) 第二刀）。
 *
 * 兩條路由（預覽、下載）共用的那一半：把 `(seq, index)` 這個座標換成磁碟上的一個檔，或是一個
 * 講得出理由的拒絕。HTTP 那一半在 {@link ./wire-handler.ts}。
 *
 * 照 dsh 的 `workspace-files`（`packages/api/workspace-files/src/index.ts`，`ddefc45`）。
 *
 * ## 錨怎麼選的：**不在這裡**
 *
 * 這個模組不挑錨，也不認得續接線。錨是呼叫端交出來的一個目錄
 * （{@link locateDeliverableFile} 的 `rootDir`），怎麼挑的寫在 `wire-handler.ts` 的
 * `locateRequested`——那是唯一挑得起的地方，因為線的位置（`storedCount`）與日誌 header 記下的
 * 根都只在那裡（[#519](https://github.com/DemianLi/nexus-agent/issues/519)）。
 *
 * **把它留在呼叫端不是成本考量，是正確性。** 從 `threadFor` 拿到的是**這一次組裝**的 backend；
 * 對一顆重播的事件而言那就是錯的錨——它不是通往修復的路，它就是那個 bug。
 *
 * 讀錯檔的樣子要寫在這裡，因為那是錨挑錯時唯一的徵兆：拿這台 server 這一次的 `--workspace` 去讀
 * 上一個行程宣告的路徑，讀到的會是另一個工作區裡的同名檔，而畫面上跟讀對了一模一樣。**不猜、
 * 直接拒**不是新發明：`assertSameCwd` 對 `header.cwd === undefined` 的處置就是拒絕。
 *
 * ## 預覽照 dsh 串流，整檔沒有大小上限
 *
 * dsh 的檔案本身沒有大小上限（`Config.maxBytes` 的檔頭：「The file itself has no size cap: a caller
 * pages through it」），因為它的 `read` 從 `streamText` 切頁，讀到頁尾之後的第一個字元就停。預覽
 * 照做（[#544](https://github.com/DemianLi/nexus-agent/issues/544)），見 {@link readDeliverablePage}。
 * **`maxFileBytes` 只管下載**，同 dsh 的 `readAll`。
 *
 * 從前這裡登記過一條偏離：「整檔讀進來再切頁，所以超過 `maxFileBytes` 的文字檔預覽不了」。那條
 * 偏離的理由是實作選擇，不是基礎建設表達不出來，#544 把它收掉了。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **不回 `absolutePath`**，理由見 `@nexus/wire` 的 `DeliverableFileStat`。
 * 2. **`/conversation_history` 那層 overlay 不在這條路上**（`agent-factory.ts` 的 `foldRegistry`）：
 *    模型宣告當下走的是折過的 backend，那一層會把 `/conversation_history` 底下的路徑導到別的地方；
 *    這條路直接解到工作區裡的同名檔。實務上 `present` 宣告的是工作區裡的產出，不是那層 overlay
 *    的內容，但這是一條真的分岔，登記在此。
 * 3. **不經基座的檔案 backend 讀**（#452 決議字面寫「自己建一個唯讀 backend」）：理由是量出來的
 *    ——基座那支會弄壞二進位檔，逐字見 {@link readDeliverableBytes}。偏離的是載體，決議給的紀律
 *    （錨由這條路由自己挑）原封不動。
 *
 * @module
 */

import { createReadStream } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import type { SessionEvent } from '@nexus/core';
import { virtualPathOf } from '@nexus/plugin-present';
import type { DeliverableFilePage, DeliverableFileStat } from '@nexus/wire';

import type { DeliverableFilesConfig } from './settings/deliverable-files.js';

/** 文字不會帶的那個位元組；它在就代表這個檔不是文字。照 dsh 的 `NUL`。 */
const NUL = String.fromCharCode(0);

/**
 * 拒絕的理由。**每一個都對應到前端一個不同的動作**，所以不能壓成同一種：`not-text` 要前端改
 * 提供下載，`no-anchor` 要前端把卡片標成讀不到，兩者長得完全不一樣。
 */
export type DeliverableRefusal =
  /** 座標不是非負整數、或 `limit` 超過上限。 */
  | 'bad-request'
  /**
   * 這顆座標這台 server 錨不住：這條 thread 不在服務中、這一次沒給 `--workspace`、或它是一顆
   * 線以下的重播事件而那份日誌的 header 沒記工作區根。**每一種都由呼叫端判**（見檔頭）。
   */
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
 * **三道形狀檢查**：那個 `seq` 上真的有事件、它真的是 `deliverables/presented`、而且真的有第
 * `index` 個檔。**錨錨不錨得住不在這裡問**，那是呼叫端的事（見檔頭）。
 *
 * 那道型別檢查不只是防呆——**它是子代理那條路的封口**。子代理宣告的交付落在子代理自己的日誌裡
 * （`@nexus/wire` 的 `deliverables.ts` 檔頭：「只有 root 那一份」），root 日誌的同一個 `seq` 上
 * 是別的事件，於是這裡拒絕。少了它，一個亂給的座標會落到一顆無關的事件上。
 *
 * @param events - root 日誌這一刻的全部事件，`seq === index`。
 * @param seq - 那顆 `deliverables/presented` 的位置。
 * @param index - 它在 `files` 裡的位置。
 * @returns 模型給的原路徑字串，或拒絕。
 */
export function locateDeliverable(
  events: readonly SessionEvent[],
  seq: number,
  index: number,
): DeliverableResult<string> {
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
 * 讀整份位元組，**吃整檔上限**。只有下載走這裡，同 dsh 的 `readAll`；預覽串流，見
 * {@link readDeliverablePage}。
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
 * @param limits - 這台 server 的三個上限，起動期從 `#settings/deliverable-files` 那一列解出來
 *   （[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。**這裡只讀不挑**：挑在
 *   `serve.ts`，因為上限是 server 的性質而這個模組一條 thread 都不認得。
 * @returns 原始位元組，或拒絕。
 */
export async function readDeliverableBytes(
  located: LocatedDeliverable,
  limits: DeliverableFilesConfig,
): Promise<DeliverableResult<Uint8Array>> {
  if (located.stat.bytes > limits.maxFileBytes) {
    return refuse(
      'too-large',
      `讀不到：${located.stat.path} 有 ${located.stat.bytes} 位元組，超過 ` +
        `${limits.maxFileBytes} 的上限。上限是拒絕，不是截斷。`,
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
    const room = Math.min(located.stat.bytes, limits.maxFileBytes) + 1;
    const buffer = Buffer.alloc(room);
    const { bytesRead } = await handle.read(buffer, 0, room, 0);
    if (bytesRead > limits.maxFileBytes) {
      return refuse(
        'too-large',
        `讀不到：${located.stat.path} 讀的時候已經超過 ${limits.maxFileBytes} 的上限。`,
      );
    }
    return { kind: 'ok', value: buffer.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

/** 一頁超過位元組上限時丟出來，在 {@link readDeliverablePage} 裡翻成拒絕。 */
class PageTooLarge extends Error {}

/** 讀到不是 UTF-8 的位元組時丟出來，在 {@link readDeliverablePage} 裡翻成 `not-text`。 */
class NotUtf8 extends Error {}

/**
 * 把檔案串流成 UTF-8 文字，**碰到不是 UTF-8 的位元組就停**，照 dsh 的 `streamText`（「decodes and
 * rejects non-UTF-8 as it goes」）。
 *
 * 用 `TextDecoder` 而不是 `createReadStream` 的 `encoding`：後者把壞位元組換成 U+FFFD、不會拒；
 * 而且 `TextDecoder` 預設吃掉開頭的 BOM，跟這條路從前整檔解碼時一樣。多位元組字元切在兩片之間
 * 由 `stream: true` 接住。
 *
 * 呼叫端提早收手時（`for await` 的 `return`），底下那個串流跟著關掉，檔案其餘部分不讀。
 *
 * @param path - 已經通過閘門的那條絕對路徑。
 * @throws {NotUtf8} 讀到的位元組不是 UTF-8。
 */
async function* streamUtf8(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (chunk?: Buffer): string => {
    try {
      return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
    } catch {
      throw new NotUtf8();
    }
  };
  for await (const chunk of createReadStream(path)) yield decode(chunk as Buffer);
  const tail = decode();
  if (tail.length > 0) yield tail;
}

/** 從串流切出來的一頁，還沒掃 NUL。 */
interface CutPage {
  readonly text: string;
  readonly lines: number;
  readonly eof: boolean;
}

/**
 * 從解碼過的串流切出第 `offset` 到 `offset + limit - 1` 行（0 起算），**讀到頁尾之後的第一個字元
 * 就停**，檔案其餘部分不讀。照 dsh `workspace-files` 的 `cutPage`（`src/index.ts:103-158`，`ddefc45`），
 * 差在 dsh 的行號 1 起算、我們 0 起算。
 *
 * **記憶體有兩道界限，兩道都是 dsh 的**：頁之前的行只數不留；頁內的位元組一超過 `maxBytes`
 * 就當場丟出，不是先攢完再比——所以一條巨大的長行也撐不大記憶體。這台機器是多人共用的。
 *
 * **最後一行後面的換行不算一行**：串流結束時手上沒有半行，就不補一行空的。
 *
 * @param chunks - 解碼過的文字片段，見 {@link streamUtf8}。
 * @param offset - 從第幾行起，0 起算。
 * @param limit - 最多幾行。
 * @param maxBytes - 一頁的位元組上限，含行與行之間的換行。
 * @returns 那一頁。
 * @throws {PageTooLarge} 這一頁超過 `maxBytes`。
 */
async function cutPage(
  chunks: AsyncIterable<string>,
  offset: number,
  limit: number,
  maxBytes: number,
): Promise<CutPage> {
  const last = offset + limit - 1;
  const lines: string[] = [];
  let current = '';
  let bytes = 0;
  let lineNumber = 0;
  const admit = (size: number): void => {
    bytes += size;
    if (bytes > maxBytes) throw new PageTooLarge();
  };
  const complete = (): void => {
    if (lines.length > 0) admit(1);
    lines.push(current);
    current = '';
  };
  for await (const chunk of chunks) {
    let position = 0;
    while (position < chunk.length) {
      // 手上還有一個字元、而它已經在頁之後：這一頁不是最後一頁。
      if (lineNumber > last) return { text: lines.join('\n'), lines: lines.length, eof: false };
      const newline = chunk.indexOf('\n', position);
      const segment = newline === -1 ? chunk.slice(position) : chunk.slice(position, newline);
      if (lineNumber >= offset) {
        admit(Buffer.byteLength(segment, 'utf8'));
        current += segment;
      }
      if (newline === -1) break;
      if (lineNumber >= offset) complete();
      lineNumber += 1;
      position = newline + 1;
    }
  }
  // 走到這裡時手上只可能是頁內的半行：頁前的行沒留，頁後的字元在上面就回了。
  if (current.length > 0) complete();
  return { text: lines.join('\n'), lines: lines.length, eof: true };
}

/**
 * 切一頁文字出來，**串流讀、只讀到這一頁為止**（#544）。
 *
 * `offset` 是行偏移（0 起算），`limit` 是這一頁最多幾行。**要超過 `limits.maxLines` 是拒絕**，
 * 不是給到上限為止——同 dsh 的 `maxLines`（「a request asking for more is refused」）。
 *
 * **`limits.maxLines` 是雙用的**：這裡當「不准超過」的上限，而「呼叫端沒給 `limit` 時用什麼」
 * 是同一個數字，那一半在 `wire-handler.ts` 的 `handleDeliverableFile`。dsh 一樣
 * （`workspace-files/src/index.ts:371-373`，兩處讀同一個 `this.config.maxLines`）。**兩處必須
 * 一起吃到設定值**：只接一處的話兩個方向都會壞——設定高於這裡寫死的上限，不帶 `limit` 的請求
 * 全部 400；設定低於那邊寫死的預設，一樣。
 *
 * **整檔沒有大小上限**，`limits.maxFileBytes` 不在這條路上（見檔頭）。**頁的上限照 dsh：拒絕，
 * 不截斷**——「a silently cut page reads as the whole page」。
 *
 * **不是 UTF-8 就是 `not-text`**，照 dsh；讀到哪裡判到哪裡，同下一段 NUL 的道理。
 *
 * **NUL 只掃這一頁**，照 dsh（「the NUL scan runs on the page itself」）。串流讀看不到還沒讀的部分，
 * 所以一個後段才出現 NUL 的檔，前面的頁讀得到、有 NUL 的那一頁才回 `not-text`。從前整檔讀進來時
 * 是整份掃，那個「第 0 頁說是文字、第 3 頁才說不是」的不一致因此是**照標準接受的**，不是疏漏。
 *
 * @param located - 已經通過閘門的檔。
 * @param limits - 這台 server 的三個上限，起動期從 `#settings/deliverable-files` 那一列解出來。
 * @param offset - 從第幾行起。
 * @param limit - 最多幾行。
 * @returns 一頁，或拒絕。
 */
export async function readDeliverablePage(
  located: LocatedDeliverable,
  limits: DeliverableFilesConfig,
  offset: number,
  limit: number,
): Promise<DeliverableResult<DeliverableFilePage>> {
  if (limit > limits.maxLines) {
    return refuse('bad-request', `limit 最多 ${limits.maxLines} 行，收到 ${limit}。`);
  }
  let page: CutPage;
  try {
    // 提早 return 會讓 `for await` 呼叫迭代器的 `return`，串流隨之關掉，檔案其餘部分不讀。
    page = await cutPage(streamUtf8(located.target), offset, limit, limits.maxBytes);
  } catch (error) {
    if (error instanceof PageTooLarge) {
      return refuse(
        'too-large',
        `讀不到：${located.stat.path} 從第 ${offset} 行起的這一頁超過 ${limits.maxBytes} 的上限。` +
          '上限是拒絕，不是截斷——切短的一頁看起來就是整頁。',
      );
    }
    if (error instanceof NotUtf8) {
      return refuse('not-text', `讀不到：${located.stat.path} 不是 UTF-8 文字。`);
    }
    // 閘門與開檔之間檔案不見了、或換了形狀。
    return refuse('not-found', `讀不到：${located.stat.path} 不在了。`);
  }
  if (page.text.includes(NUL)) {
    return refuse('not-text', `讀不到：${located.stat.path} 含 NUL 位元組，不是 UTF-8 文字。`);
  }
  return {
    kind: 'ok',
    value: { ...located.stat, offset, text: page.text, lines: page.lines, eof: page.eof },
  };
}
