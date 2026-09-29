/**
 * {@link @nexus/core!SessionStore} 的 JSONL 後端：一份會話一個檔，一行一顆事件。
 *
 * 形狀照 dsh 隨產品交付的 `session-persistence-jsonl`（`docs/subsystems/persistence.zh.md`，
 * 本地 clone SHA `d347e703908d0406b7a7ef80e3a0e594d86b2215`）：逐 session 的僅追加日誌、
 * **header 與日誌分開存**（dsh 明文：元資料在日誌之外，`stat`／`list` 讀 header 不掃正文）、
 * 實體化延後到第一次寫。
 *
 * **選 JSONL 不選 SQLite 是一個有代價的選擇，代價登記在這裡。** dsh 兩個 provider 都出
 * （`-jsonl` 與 `-sqlite`），我們先做 JSONL，理由三條：不必現場編譯（SQLite 那條要
 * `better-sqlite3`，而我們的 `onlyBuiltDependencies` 只放了 `esbuild`）、人讀得懂、
 * 以及未來 Proteus 的 `read_trace` 解析的就是 jsonl。丟掉的是頻繁更新時的效率，而
 * 僅追加的日誌本來就沒有頻繁更新。**第一條原本寫的是「零原生相依」，寫租約之後不成立了**：
 * 租約吃一個原生模組，但它是預編譯的、沒有 install script（見 `session-lease.ts`），所以
 * 真正擋掉 SQLite 的那件事——要在裝的機器上編——這條路仍然沒有。
 *
 * ## 一條沒抄的、一條照抄的
 *
 * - **沒有 Zstandard 壓縮與 checksum。** dsh 預設存成帶 checksum 的連續 Zstandard frame
 *   （也可配置成原始行）。我們存原始行：撕裂尾部的偵測與部分解碼是**讀方**的機器，
 *   而今天的讀方讀的都是原始行：續接（{@link JsonlSessionStore.resume}，CLI 的 `--resume`
 *   與 serve 碰到以前寫過的 thread，[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）、
 *   唯讀的列與冷讀（`list`／`open(id, 'read')`，serve 的會話列表與按內容搜尋，
 *   [#665](https://github.com/DemianLi/nexus-agent/issues/665)），與離線掃描（`eval/session-scan.ts`，
 *   [#268](https://github.com/DemianLi/nexus-agent/issues/268)，唯讀，共用 {@link parseJsonlSessionBody}）。
 *   加壓縮換到的是第二套解碼路徑，沒有人要。
 * - **寫租約照抄了**（`session-lease.ts`）：新開的在第一次實體化寫入之前拿，續接的在讀
 *   之前拿，把手關掉才放。一份會話一把，鎖檔跟日誌並排（`<base>.lock`）——理由在那個模組。
 *   `open(path, 'wx')` 仍然在：**檔案已經在就拒絕**，不覆寫也不續寫，那是 `SessionStore`
 *   檔頭說的撞名絆索，跟租約各擋一件事。
 *
 *   **拿租約是惰性的，所以輸的可能是先起來的那個**：一個行程還沒寫第一筆（還沒拿），另一個
 *   就 `--resume` 了同一份，後者先拿到；前者第一次寫的時候才撞上，而那一下在協調器的背景
 *   路徑上，**被收成一行 warn 而不是一個錯**。dsh 也是惰性的，所以不算偏離；只是我們的
 *   協調器讓那個後果更安靜。
 *
 * ## 目錄：CLI 每次一個，serve 按專案固定一格
 *
 * dsh 的 `SessionId` 全域唯一；我們的 CLI root 固定叫 `cli`，放在固定的地方會每次都撞。
 * 所以 CLI 用 {@link createJsonlSessionStore} 每次開一個 **run 目錄**——沒有這一層，`wx`
 * 會讓第二次啟動變成一個硬錯誤。serve 的 root 是 thread id，本來就全域唯一，所以它照 dsh
 * 用 {@link openJsonlSessionStore} 落在 `<根>/<projectKey(cwd)>` 那一格，重開之後找得回同一條
 * thread。
 *
 * ## 檔名與 header 的規則只在這裡
 *
 * 一份會話三個檔並排：`<base>.header.json`、`<base>.jsonl`、`<base>.lock`（`base` 見 {@link safeBaseName}）。
 * 會碰到它們的只有這個檔：列表與搜尋走 `list`／`open(id, 'read')`，離線掃描 import {@link sessionLogPathOf} 與
 * {@link parseHeader}，同 dsh 的檔名只有一份定義（`packages/session/session-format/src/filename.ts:14`）、日誌匯出
 * import 它（[#665](https://github.com/DemianLi/nexus-agent/issues/665)）。
 *
 * @see [#172](https://github.com/DemianLi/nexus-agent/issues/172)
 * @module
 */

import { mkdir, open, readdir, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionFormatUnsupportedError,
  SessionNotFoundError,
} from '@nexus/core';
import type {
  ReadonlyStoredSession,
  ResumedStoredSession,
  SessionEvent,
  SessionStore,
  StoredSession,
  StoredSessionHeader,
  StoredSessionListing,
  StoredSessionListOptions,
  StoredSessionReadOptions,
  StoredSessionSnapshot,
} from '@nexus/core';
import { acquireSessionLease } from './session-lease.js';
import type { LeaseUnavailable, SessionWriteLease, TryLock } from './session-lease.js';

/** 一份會話的三個檔的副檔名。見檔頭「檔名與 header 的規則只在這裡」。 */
const HEADER_SUFFIX = '.header.json';
const LOG_SUFFIX = '.jsonl';
const LOCK_SUFFIX = '.lock';

/**
 * 目錄與檔案的權限。
 *
 * **會話日誌裡有使用者打的每一句話**，所以是 `0700`／`0600`，同 dsh 的 spill store
 * （`dsh-spill-local` 的根目錄 `0700`、檔案 `0600`）。
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * 檔名基底的長度上限。超過就截短並綴上摘要（見 {@link safeBaseName}）。
 *
 * 多數檔案系統的單段上限是 255 **位元組**，而中文一個字三個位元組，所以用字元數當
 * 上限得留餘裕：120 個字元最壞情況是 360 位元組，加上 `.header.json` 還是進得去
 * 255 的只有截短後那條路——所以截短的門檻設在遠低於上限的地方，不是貼著它。
 */
const MAX_BASE_LENGTH = 120;
/** 截短後保留的前綴長度；其餘讓位給摘要。 */
const TRUNCATED_PREFIX_LENGTH = 96;
/** 摘要取幾個十六進位字元。48 bit，撞得到要靠刻意構造。 */
const DIGEST_LENGTH = 12;

/**
 * 把 session id 變成一個安全的檔名基底，**而且是單射的**。
 *
 * subagent 的 id 是 `<root>/<runId>`，帶斜線，直接拿去當檔名會變成子目錄。
 *
 * ## 為什麼要單射：`serve` 的 session id 是呼叫端給的
 *
 * CLI 的 root 固定叫 `cli`，subagent 是 `cli/<runId>`——那組 id 是我們自己造的，怎麼
 * 壓平都不會撞。**`serve` 不是**：`ThreadPump` 用 `new SessionRegistry(threadId)`
 * 開 root（`thread-pump.ts:129`），而 `threadId` 直接來自 `/threads/:id/...` 的路徑。
 * 把不合法字元一律換成 `_` 的話，`a~b`、`a!b`、`a_b` 三條不同的 thread 會壓成同一個
 * 檔名——第二條的第一次寫入撞上 `wx` 而失敗，協調器按設計吞掉它（暫停自動路徑、
 * 一行 warn），於是**那條 thread 的日誌就這麼沒了**。`wx` 那條拒絕是留給「`create`
 * 撞上一份已存的會話」的絆索——續接走的是 `resume`，不走 `create`——不是拿來擋這個的。
 *
 * ## 三條規則，各擋一種撞法
 *
 * 1. **百分號編碼，不壓平。** 不在 `[A-Za-z0-9._-]` 裡的位元組寫成 `%<小寫 hex>`，
 *    而 `%` 自己也被編碼（`%25`），所以解得回去，也就撞不到。`cli`、`cli%2frun-1`
 *    這種常見形狀仍然一眼看得懂。
 * 2. **大寫字母另外收。** macOS 與 Windows 的檔案系統預設**不分大小寫**，所以
 *    `Alpha` 與 `alpha` 在編碼之後仍然是同一個檔。把大寫字母也編碼會讓每一個
 *    駝峰 id 變得不能讀，所以改成：**含大寫就綴上摘要**。編碼用的 hex 刻意是小寫的，
 *    這樣這條規則只會被 id 自己的大寫觸發，不會被編碼觸發。
 * 3. **超過 {@link MAX_BASE_LENGTH} 就截短並綴上摘要。** 截短之後的單射性靠那段
 *    摘要，不靠前綴。
 *
 * 摘要是**完整 `sessionId`** 的 SHA-256 前 {@link DIGEST_LENGTH} 個十六進位字元。
 * **那個輸入不能改成 `encoded`**：規則 3 先判、走的是提早回傳，所以又長又含大寫的 id
 * 只拿得到截短那一顆摘要——它之所以同時擋得住大小寫，正是因為摘要算在原始 id 上。
 * 換成算在 `encoded` 上的話，大小寫的撞名會只在長 id 上回來，而那條路沒有測試蓋到。
 *
 * @param sessionId - 會話 id。
 * @returns 檔名基底；不同的 id 給出不同的基底，**而且在不分大小寫的檔案系統上也是**。
 */
function safeBaseName(sessionId: string): string {
  if (sessionId.length === 0) return 'session';
  const digest = (): string =>
    createHash('sha256').update(sessionId).digest('hex').slice(0, DIGEST_LENGTH);
  const encoded = [...Buffer.from(sessionId, 'utf8')]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9._-]/.test(char) ? char : `%${byte.toString(16).padStart(2, '0')}`;
    })
    .join('');
  if (encoded.length > MAX_BASE_LENGTH) {
    return `${encoded.slice(0, TRUNCATED_PREFIX_LENGTH)}-${digest()}`;
  }
  // 編碼產生的 hex 是小寫的，所以這裡認出來的大寫一定來自 id 本身。
  return encoded === encoded.toLowerCase() ? encoded : `${encoded}-${digest()}`;
}

/**
 * 續接一份已存會話時，把手要知道的兩件事。
 *
 * `truncateTo` 只在最後一行寫到一半時才有：那是當掉的常態，讀方不算它，而把手第一次寫入
 * 之前要把它截掉——不截的話，續寫的第一行會黏在那半行後面，兩行一起變成壞行。
 *
 * **截是跟著第一次寫入走的，不是跟著續接走的。** 續接幾乎都會寫：seed 結尾補的那顆
 * `session/end-seed` 就是一筆待寫。唯一不寫的是 seed 本來就停在 end-seed（上一次續接之後
 * 什麼都沒做）而這一次也什麼都沒做——那半行就留在檔上。無害：下一次讀方照樣不算它、
 * 照樣截。
 */
interface ResumePoint {
  readonly nextSeq: number;
  readonly truncateTo?: number;
  /** 讀之前就拿到的租約；這個平台拿不到就是 `undefined`。 */
  readonly lease: SessionWriteLease | undefined;
}

/**
 * 一個後端裡每一份會話共用的：拿鎖的那一下，與「這個平台拿不到鎖」那張嘴。
 *
 * **那張嘴一個後端只開一次**——不然每個 subagent 出生都重講一遍。
 */
interface LeaseContext {
  readonly lock: TryLock | undefined;
  readonly unavailable: (outcome: LeaseUnavailable) => void;
}

/** 拿租約；拿不到的平台講一聲、回 `undefined`。搶不到與其餘的錯照常拋。 */
async function leaseFor(
  context: LeaseContext,
  path: string,
  id: string,
): Promise<SessionWriteLease | undefined> {
  const outcome = await acquireSessionLease(path, id, context.lock);
  if ('unavailable' in outcome) {
    context.unavailable(outcome);
    return undefined;
  }
  return outcome;
}

/** 一份已存會話。IO 延後到第一次 {@link append} 或 {@link flush}。 */
class JsonlStoredSession implements StoredSession {
  readonly #directory: string;
  readonly #base: string;
  readonly #header: StoredSessionHeader;
  readonly #resume: ResumePoint | undefined;
  readonly #context: LeaseContext;
  #lease: SessionWriteLease | undefined;
  #handle: FileHandle | undefined;
  /**
   * 進行中的那次實體化。`#materialize` 裡有好幾個 await，同時進來兩次的話第二次會拿不到
   * **自己的**租約，拋出一句「另一個行程還開著它」——同一個行程、同一份會話，那句話會讓人去找
   * 一個不存在的行程。協調器的背景寫入與 `flush` 排在不同的隊伍上，所以這不是理論上的。
   */
  #materializing: Promise<FileHandle> | undefined;
  #closed = false;
  /** 已存的 next-seq。下一批的第一顆必須等於它。 */
  #nextSeq: number;

  /**
   * @param directory - run 目錄。
   * @param header - 要寫的 header。續接時是**已經翻成這一版**的那份。
   * @param context - 這個後端的租約設定。
   * @param resume - 續接一份已存的會話；省略即開一份新的。
   */
  constructor(
    directory: string,
    header: StoredSessionHeader,
    context: LeaseContext,
    resume?: ResumePoint,
  ) {
    this.#directory = directory;
    this.#base = safeBaseName(header.id);
    this.#header = header;
    this.#context = context;
    this.#resume = resume;
    this.#lease = resume?.lease;
    this.#nextSeq = resume?.nextSeq ?? 0;
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    this.#assertOpen();
    if (events.length === 0) return;
    for (const [index, event] of events.entries()) {
      const expected = this.#nextSeq + index;
      if (event.seq !== expected) {
        throw new Error(
          `會話 "${this.#header.id}" 的這一批不連續：第 ${index} 顆的 seq 是 ${event.seq}，` +
            `應該是 ${expected}。寫過的事件不重寫，缺號也不補。`,
        );
      }
    }
    const handle = await this.#materialize();
    await handle.write(events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    this.#nextSeq += events.length;
  }

  async flush(): Promise<void> {
    this.#assertOpen();
    // 一份還沒寫過任何事件的會話，在這裡才真的變成磁碟上看得到的東西——dsh 同條
    // （「一个空的已创建会话在此变得可持久列出」）。
    const handle = await this.#materialize();
    await handle.datasync();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const handle = this.#handle;
    this.#handle = undefined;
    try {
      if (handle !== undefined) {
        try {
          await handle.datasync();
        } finally {
          await handle.close();
        }
      }
    } finally {
      // **不論開沒開過日誌都放**：續接那條路在讀之前就拿了租約，一筆都沒寫就關也要放掉，
      // 不然同一個行程裡下一次接同一份會撞上自己。
      const lease = this.#lease;
      this.#lease = undefined;
      await lease?.release();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`會話 "${this.#header.id}" 的把手已經關掉了。`);
  }

  /**
   * 第一次真的要寫時才建目錄、寫 header、開檔。之後直接回同一個 handle。
   *
   * 同時進來的共用同一次；失敗了就清掉，下一次重來——協調器靠的正是「失敗保留、下次再送」。
   */
  #materialize(): Promise<FileHandle> {
    if (this.#handle !== undefined) return Promise.resolve(this.#handle);
    this.#materializing ??= this.#open().catch((error: unknown) => {
      this.#materializing = undefined;
      throw error;
    });
    return this.#materializing;
  }

  async #open(): Promise<FileHandle> {
    if (this.#resume !== undefined) return this.#materializeResumed(this.#resume);
    await mkdir(this.#directory, { recursive: true, mode: DIR_MODE });
    // **租約在第一筆實體化寫入之前拿**，照 dsh：一份還沒實體化的會話在檔案系統上沒有足跡。
    // 上一次實體化拿到租約之後才失敗的話，重試不再拿一次——那會撞上自己。
    this.#lease ??= await leaseFor(
      this.#context,
      join(this.#directory, `${this.#base}${LOCK_SUFFIX}`),
      this.#header.id,
    );
    // header 先寫：日誌有內容而 header 不見，比反過來難解釋得多。
    await writeFile(
      join(this.#directory, `${this.#base}${HEADER_SUFFIX}`),
      `${JSON.stringify(this.#header, null, 2)}\n`,
      { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' },
    );
    // `wx`：檔案已經在就拒絕。不覆寫、也不續寫。
    this.#handle = await open(join(this.#directory, `${this.#base}${LOG_SUFFIX}`), 'wx', FILE_MODE);
    return this.#handle;
  }

  /**
   * 續接那條：**header 覆寫、日誌續寫**，兩者都不是 `wx`。
   *
   * header 覆寫是因為續寫進去的是這一版的詞彙（`session-store.ts` 的版本 3 那一段）；
   * 其餘欄位原樣——`createdAt` 是這份會話出生的時間，不是這一次打開的時間。
   */
  async #materializeResumed(resume: ResumePoint): Promise<FileHandle> {
    await writeFile(
      join(this.#directory, `${this.#base}${HEADER_SUFFIX}`),
      `${JSON.stringify(this.#header, null, 2)}\n`,
      { encoding: 'utf8', mode: FILE_MODE },
    );
    const logPath = join(this.#directory, `${this.#base}${LOG_SUFFIX}`);
    if (resume.truncateTo !== undefined) await truncate(logPath, resume.truncateTo);
    this.#handle = await open(logPath, 'a', FILE_MODE);
    return this.#handle;
  }
}

/** `readFile` 撞到的是「沒有這個檔」。 */
function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** {@link parseHeader} 的選項。 */
export interface ParseHeaderOptions {
  /** 呼叫方知道是哪一份時給（續接、唯讀打開）：header 記的 id 要一樣。列的時候不知道，不給。 */
  readonly id?: string;
  /** 版本比這一版新照讀、不拋。**只給產品路徑外的離線掃描**（`eval/session-scan.ts` 的「照格式版本表態」）。 */
  readonly acceptNewer?: boolean;
}

/**
 * 讀 header，**版本太新與讀不懂分開報**（見 `session-store.ts` 的版本 3 那一段）。續接、列、唯讀打開與離線掃描
 * 共用這一份，差別只在選項。
 *
 * @throws {@link SessionFormatUnsupportedError} 版本比這一版新（開了 `acceptNewer` 就不拋）。
 * @throws {@link SessionCorruptionError} 不是 JSON、欄位形狀不對、或 id 對不上。
 */
export function parseHeader(text: string, options: ParseHeaderOptions = {}): StoredSessionHeader {
  const { id: expected } = options;
  /** 錯誤訊息裡的那個 id：呼叫方給的，沒給就是 header 自己記的。 */
  let id = expected ?? '（不明）';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SessionCorruptionError(id, 'header 不是 JSON');
  }
  if (!isRecord(value)) throw new SessionCorruptionError(id, 'header 不是一個物件');
  if (expected === undefined && typeof value['id'] === 'string') id = value['id'];
  const { version } = value;
  if (
    options.acceptNewer !== true &&
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version > SESSION_LOG_FORMAT_VERSION
  ) {
    throw new SessionFormatUnsupportedError(id, version);
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new SessionCorruptionError(id, `header 的 version 是 ${JSON.stringify(version)}`);
  }
  if (expected === undefined ? typeof value['id'] !== 'string' : value['id'] !== expected) {
    throw new SessionCorruptionError(id, `header 記的 id 是 ${JSON.stringify(value['id'])}`);
  }
  if (typeof value['createdAt'] !== 'number') {
    throw new SessionCorruptionError(id, 'header 沒有 createdAt');
  }
  return value as unknown as StoredSessionHeader;
}

/**
 * header 檔的路徑對到日誌本文的路徑。**不是 header 檔就是 `undefined`**。給自己走目錄的離線掃描用，它因此不必認得
 * 副檔名。
 *
 * @param headerPath - 一個檔的路徑。
 */
export function sessionLogPathOf(headerPath: string): string | undefined {
  return headerPath.endsWith(HEADER_SUFFIX)
    ? `${headerPath.slice(0, -HEADER_SUFFIX.length)}${LOG_SUFFIX}`
    : undefined;
}

/**
 * 讀日誌本文：**實體上有效的前綴**，加上它有幾個位元組。
 *
 * 最後一個換行之後的東西是寫到一半的那一行——當掉時的常態，不算壞檔，只是不算進去。
 * 換行之前的每一行都必須是一筆 `seq` 等於行號的事件；不是的話那不是當掉，是壞檔。
 *
 * **匯出給唯讀的讀方**：離線掃描（`eval/session-scan.ts`）不能走 {@link JsonlSessionStore.resume}
 * ——那條會拿寫租約、覆寫 header、截掉撕裂的尾巴，全是寫入，還會把一個正在寫的行程擋在門外。
 * 撕裂尾巴的規則只有這一份，唯讀打開（`open(id, 'read')`）也走它。
 *
 * @throws {@link SessionCorruptionError} 中段某一行讀不懂，或 `seq` 不連續。
 */
export function parseJsonlSessionBody(
  id: string,
  body: string,
): { events: SessionEvent[]; validBytes: number } {
  const complete = body.slice(0, body.lastIndexOf('\n') + 1);
  const lines = complete.split('\n');
  lines.pop();
  const events = lines.map((line, index): SessionEvent => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new SessionCorruptionError(id, `第 ${index + 1} 行不是 JSON`);
    }
    if (
      !isRecord(value) ||
      typeof value['type'] !== 'string' ||
      typeof value['time'] !== 'number'
    ) {
      throw new SessionCorruptionError(id, `第 ${index + 1} 行不是一筆會話事件`);
    }
    if (value['seq'] !== index) {
      throw new SessionCorruptionError(
        id,
        `第 ${index + 1} 行的 seq 是 ${JSON.stringify(value['seq'])}，應該是 ${index}——缺號或重號`,
      );
    }
    return value as unknown as SessionEvent;
  });
  return { events, validBytes: Buffer.byteLength(complete, 'utf8') };
}

/**
 * 中段壞掉的本文**撿回讀得懂的**：只看完整的行（最後一個換行之前），解析不動、或沒有數字的 `seq` 與 `time` 的略過。
 * 見 `@nexus/core` 的 `StoredSessionReadOptions.salvage`。
 */
function salvageJsonlSessionBody(body: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of body.slice(0, body.lastIndexOf('\n') + 1).split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(value) && typeof value['seq'] === 'number' && typeof value['time'] === 'number') {
      events.push(value as unknown as SessionEvent);
    }
  }
  return events;
}

/** 讀日誌本文。**不在是空的**：只有 header 是「還沒寫第一筆就當了」。 */
async function readBody(logPath: string): Promise<string> {
  try {
    return await readFile(logPath, 'utf8');
  } catch (error: unknown) {
    if (isNotFound(error)) return '';
    throw error;
  }
}

/**
 * 一個檔此刻的樣子，照 dsh 的 `fileRevision`（`packages/session/session-persistence-jsonl/src/index.ts:184-192`）：
 * 裝置、inode、大小、修改與變更時間（奈秒）。不在就是 `missing`。
 */
async function fileRevision(path: string): Promise<string> {
  let stats: BigIntStats;
  try {
    stats = await stat(path, { bigint: true });
  } catch (error: unknown) {
    if (isNotFound(error)) return 'missing';
    throw error;
  }
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
}

/**
 * 列 `directory` 裡落了盤的每一份。見 {@link SessionStore.list}。
 *
 * `revision` 算的是 **header 與本文兩個檔**：dsh 的 header 在同一個檔裡，我們分開存，而續接會覆寫 header
 * （改 `version`）。只算本文的話，那一下看不出來。
 *
 * **檔名基底對不上 header 記的 id 的算讀不懂**：`open(id)` 照 id 算檔名，找不到它。只有手動改過檔名才會這樣。
 */
async function listStoredSessions(
  directory: string,
  options: StoredSessionListOptions = {},
): Promise<StoredSessionListing> {
  const { signal } = options;
  signal?.throwIfAborted();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isNotFound(error)) return { sessions: [], unreadable: 0 };
    throw error;
  }
  const sessions: StoredSessionSnapshot[] = [];
  let unreadable = 0;
  for (const name of names) {
    signal?.throwIfAborted();
    if (!name.endsWith(HEADER_SUFFIX)) continue;
    const base = name.slice(0, -HEADER_SUFFIX.length);
    const headerPath = join(directory, name);
    // 先記樣子再讀：兩步之間被改了的話，記下的是舊的，下一次比對時不相等，衍生的快取多讀一次而已。
    const revision = `${await fileRevision(headerPath)}|${await fileRevision(join(directory, `${base}${LOG_SUFFIX}`))}`;
    let text: string;
    try {
      text = await readFile(headerPath, 'utf8');
    } catch (error: unknown) {
      // 讀目錄與讀檔之間被刪掉：不是壞檔，就是不在了。
      if (isNotFound(error)) continue;
      throw error;
    }
    let header: StoredSessionHeader;
    try {
      header = parseHeader(text);
    } catch (error: unknown) {
      if (
        error instanceof SessionCorruptionError ||
        error instanceof SessionFormatUnsupportedError
      ) {
        unreadable += 1;
        continue;
      }
      throw error;
    }
    if (safeBaseName(header.id) !== base) {
      unreadable += 1;
      continue;
    }
    sessions.push({ header, revision });
  }
  return { sessions, unreadable };
}

/**
 * 唯讀打開 `directory` 裡的那一份。見 {@link SessionStore.open}：**不拿租約、不截尾巴、不動 header**。
 */
async function openStoredSessionForRead(
  directory: string,
  id: string,
): Promise<ReadonlyStoredSession> {
  const base = safeBaseName(id);
  const headerPath = join(directory, `${base}${HEADER_SUFFIX}`);
  let text: string;
  try {
    text = await readFile(headerPath, 'utf8');
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw new SessionNotFoundError(
        id,
        `${directory} 裡沒有會話 "${id}"（找不到 ${headerPath}）。`,
      );
    }
    throw error;
  }
  const header = parseHeader(text, { id });
  const logPath = join(directory, `${base}${LOG_SUFFIX}`);
  return {
    header,
    async read(options: StoredSessionReadOptions = {}): Promise<readonly SessionEvent[]> {
      const body = await readBody(logPath);
      try {
        return parseJsonlSessionBody(id, body).events;
      } catch (error: unknown) {
        if (options.salvage === true && error instanceof SessionCorruptionError) {
          return salvageJsonlSessionBody(body);
        }
        throw error;
      }
    },
  };
}

/**
 * 續接 `directory` 裡的那一份。見 {@link SessionStore.resume}。
 *
 * **只有 header、沒有日誌不是壞檔**：`#materialize` 先寫 header 再開日誌，兩步之間當掉
 * 就是這個樣子——一份一筆都還沒寫進去的會話。
 */
async function resumeStoredSession(
  directory: string,
  id: string,
  context: LeaseContext,
): Promise<ResumedStoredSession> {
  const base = safeBaseName(id);
  const headerPath = join(directory, `${base}${HEADER_SUFFIX}`);
  const missing = () =>
    new SessionNotFoundError(id, `${directory} 裡沒有會話 "${id}"（找不到 ${headerPath}）。`);
  // **先認得有這份，再拿租約**：打錯的 `--resume` 不該留下一個鎖檔。
  try {
    await stat(headerPath);
  } catch (error: unknown) {
    if (isNotFound(error)) throw missing();
    throw error;
  }
  // **在讀之前拿**，照 dsh：持有者在實體化時會覆寫 header（非原子），不鎖就讀可能讀到半份；
  // 而且別人握著的話，該在什麼都還沒讀之前就講。
  const lease = await leaseFor(context, join(directory, `${base}${LOCK_SUFFIX}`), id);
  try {
    let headerText: string;
    try {
      headerText = await readFile(headerPath, 'utf8');
    } catch (error: unknown) {
      if (isNotFound(error)) throw missing();
      throw error;
    }
    const header = parseHeader(headerText, { id });
    const body = await readBody(join(directory, `${base}${LOG_SUFFIX}`));
    const { events, validBytes } = parseJsonlSessionBody(id, body);
    const torn = validBytes < Buffer.byteLength(body, 'utf8');
    return {
      header,
      events,
      stored: new JsonlStoredSession(
        directory,
        { ...header, version: SESSION_LOG_FORMAT_VERSION },
        context,
        { nextSeq: events.length, ...(torn && { truncateTo: validBytes }), lease },
      ),
    };
  } catch (error: unknown) {
    // 讀壞了就沒有把手可關，租約得在這裡放。
    await lease?.release();
    throw error;
  }
}

/**
 * 一個專案目錄在會話根底下的目錄名——照 dsh 的 `projectKey`
 * （`packages/session/session-persistence-jsonl/src/format.ts`，SHA `c291e79`），逐字元抄。
 *
 * 分隔符（`/`、`\\`、`:`）變成 `-`，連續的只留一個；不安全的 UTF-16 碼元寫成 `~XXXX`；
 * 前後包 `--`，長度封頂。**它是有損的**（分隔符與截短），dsh 明說這是刻意的：換來的是人
 * 在目錄裡找得到自己的專案。有損就可能撞，所以續接時照樣比 header 的 `cwd`
 * （{@link ./resume-guards.ts | ResumeCwdConflictError}），同 dsh。
 *
 * @param cwd - 專案目錄。
 * @returns 一段檔案系統安全的目錄名。
 * @throws 空字串。
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('專案目錄是空字串，排不出目錄名。');
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

/** {@link createJsonlSessionStore} 與 {@link openJsonlSessionStore} 交出來的東西。 */
export interface JsonlSessionStore extends SessionStore {
  /** 這一次的 run 目錄。披露那一行印的就是它。 */
  readonly directory: string;
}

/** 兩個工廠共用的選項。 */
export interface JsonlSessionStoreOptions {
  /**
   * 這個平台拿不到寫租約時講的那一句（見 `session-lease.ts`）。一個後端只講一次。
   * 省略就走 `console.warn`；產品路徑兩個入口都各自給（CLI 走 `Printer`，serve 走伺服器日誌）。
   */
  readonly warn?: (message: string) => void;
  /** 拿鎖的那一下。**只給測試換**：真的平台上量不到「拿不到」那兩條路。 */
  readonly lock?: TryLock;
}

/** 落在 `directory` 上的後端。兩個工廠差在目錄是新開的還是既有的。 */
function jsonlStoreAt(directory: string, options: JsonlSessionStoreOptions): JsonlSessionStore {
  const warn = options.warn ?? ((message: string) => console.warn(`[會話日誌] ${message}`));
  let warned = false;
  const context: LeaseContext = {
    lock: options.lock,
    unavailable: (outcome) => {
      if (warned) return;
      warned = true;
      warn(
        `這個平台拿不到寫租約（${outcome.unavailable}），${directory} 裡的會話都不鎖：` +
          `兩個行程同時寫同一份會撞號。`,
      );
    },
  };
  return {
    directory,
    create(header: StoredSessionHeader): StoredSession {
      return new JsonlStoredSession(directory, header, context);
    },
    resume(id: string): Promise<ResumedStoredSession> {
      return resumeStoredSession(directory, id, context);
    },
    list(options?: StoredSessionListOptions): Promise<StoredSessionListing> {
      return listStoredSessions(directory, options);
    },
    open(id: string): Promise<ReadonlyStoredSession> {
      return openStoredSessionForRead(directory, id);
    },
  };
}

/**
 * 開一個 JSONL 後端。
 *
 * @param options - `rootDir` 底下會開一個這一次專用的 run 目錄。
 * @returns 後端，以及它實際會寫進去的那個目錄。
 */
export function createJsonlSessionStore(
  options: { readonly rootDir: string } & JsonlSessionStoreOptions,
): JsonlSessionStore {
  // 每一次組裝一個目錄。時間戳在前面是為了人排序得動，UUID 在後面是為了同一毫秒起兩次
  // 也不會撞（`wx` 會擋，但擋下來的是一次硬錯誤，不是我們要的行為）。
  const directory = join(
    options.rootDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
  );
  return jsonlStoreAt(directory, options);
}

/** {@link createJsonlSessionStore} 開的 run 目錄的名字：`2026-09-25T12-15-38-007Z-eef8c1ff`。 */
const RUN_DIRECTORY_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/u;
/** {@link projectKey} 排出來的名字。 */
const PROJECT_DIRECTORY_NAME = /^--.+--$/u;

/** 會話根底下的一格。 */
export interface SessionStoreDirectory {
  /** `project` 是 serve 的 `<projectKey(cwd)>`，`cli-run` 是 CLI 一次一個的 run 目錄。 */
  readonly kind: 'project' | 'cli-run';
  readonly directory: string;
}

/**
 * 會話根底下有哪幾格存著會話，給跨專案的讀方（[#713](https://github.com/DemianLi/nexus-agent/issues/713) 的引用候選）
 * 一格一格 {@link openJsonlSessionStore} 再 `list`——**它不必自己認目錄名**。哪幾種要列成候選由它決定。
 *
 * dsh 的後端根就在整個會話根，`list` 一次掃遍（`packages/session/session-persistence-jsonl/src/index.ts` 的
 * `listArtifacts`）。我們不能照搬：CLI 的 root id 一律是 `cli`，一個根底下會有很多份同 id 的，而 dsh 對重複的 id
 * 直接拋。所以 `list` 掛在一格上，跨格的列舉另開這一支（demian 2026-09-29 拍板，#665）。
 *
 * @param rootDir - 會話根（`harnessSessionsDir` 或 `--session-log` 給的）。還不存在就是空的。
 * @returns 認得出來的每一格，照名字排；其餘的（使用者自己放的東西）略過。
 * @throws 會話根存在但讀不到。
 */
export async function listSessionStoreDirectories(
  rootDir: string,
): Promise<readonly SessionStoreDirectory[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const found: SessionStoreDirectory[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) continue;
    const kind = PROJECT_DIRECTORY_NAME.test(entry.name)
      ? 'project'
      : RUN_DIRECTORY_NAME.test(entry.name)
        ? 'cli-run'
        : undefined;
    if (kind !== undefined) found.push({ kind, directory: join(rootDir, entry.name) });
  }
  return found;
}

/**
 * 打開一個**既有的** run 目錄——續接（`--resume`）用的。
 *
 * **不另開目錄**：續接照 dsh 是往同一份檔續寫，不是把舊的抄進新的——抄一份的話，兩個目錄
 * 會帶著同一個 `(session.id, seq)`，而遙測的去重鍵正是它（`session-log.ts` 檔頭）。
 * 這個行程新出生的 subagent 日誌也落在這裡，與上一個行程的並排；它們的 id 帶 LangGraph
 * 的 task id（`session-address.ts`），`wx` 仍然擋撞名。
 *
 * **續接撞上別人握著就拋 {@link @nexus/core!SessionAlreadyOwnedError}**，在讀之前——另一個
 * 行程還開著這份會話的話，兩邊一起寫會撞號。
 *
 * @param options - 那個 run 目錄。
 * @returns 後端；`create` 開新的、`resume` 接舊的。
 */
export function openJsonlSessionStore(
  options: { readonly directory: string } & JsonlSessionStoreOptions,
): JsonlSessionStore {
  return jsonlStoreAt(options.directory, options);
}
