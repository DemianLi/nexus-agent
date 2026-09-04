/**
 * {@link @nexus/core!SessionStore} 的 JSONL 後端：一份會話一個檔，一行一顆事件。
 *
 * 形狀照 dsh 隨產品交付的 `session-persistence-jsonl`（`docs/subsystems/persistence.zh.md`，
 * 本地 clone SHA `d347e703908d0406b7a7ef80e3a0e594d86b2215`）：逐 session 的僅追加日誌、
 * **header 與日誌分開存**（dsh 明文：元資料在日誌之外，`stat`／`list` 讀 header 不掃正文）、
 * 實體化延後到第一次寫。
 *
 * **選 JSONL 不選 SQLite 是一個有代價的選擇，代價登記在這裡。** dsh 兩個 provider 都出
 * （`-jsonl` 與 `-sqlite`），我們先做 JSONL，理由三條：零原生相依（SQLite 那條要
 * `better-sqlite3`，而我們的 `onlyBuiltDependencies` 只放了 `esbuild`）、人讀得懂、
 * 以及未來 Proteus 的 `read_trace` 解析的就是 jsonl。丟掉的是頻繁更新時的效率，而
 * 僅追加的日誌本來就沒有頻繁更新。
 *
 * ## 兩條沒抄的，各有理由
 *
 * - **沒有 Zstandard 壓縮與 checksum。** dsh 預設存成帶 checksum 的連續 Zstandard frame
 *   （也可配置成原始行）。我們存原始行：撕裂尾部的偵測與部分解碼是**讀方**的機器，
 *   而我們今天沒有讀方（[#155](https://github.com/DemianLi/nexus-agent/issues/155)：
 *   三個入口都沒有跨重啟的續接）。加壓縮換到的是一個沒有人走過的解碼路徑。
 * - **沒有跨行程的寫租約。** 退到 `open(path, 'wx')`——**檔案已經在就拒絕**，不覆寫也不
 *   續寫。這條拒絕就是 `SessionStore` 檔頭說的那個絆索。
 *
 * ## 每一次組裝各自一個目錄
 *
 * dsh 的 `SessionId` 全域唯一，我們的只在一次組裝內唯一（CLI 的 root 固定叫 `cli`）。
 * 所以 {@link createJsonlSessionStore} 自己開一個 **run 目錄**，第二次啟動不會撞到第一次
 * ——沒有這一層，`wx` 會讓第二次啟動變成一個硬錯誤。
 *
 * @see [#172](https://github.com/DemianLi/nexus-agent/issues/172)
 * @module
 */

import { mkdir, open, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionEvent, SessionStore, StoredSession, StoredSessionHeader } from '@nexus/core';

/**
 * 目錄與檔案的權限。
 *
 * **會話日誌裡有使用者打的每一句話**，所以是 `0700`／`0600`，同 dsh 的 spill store
 * （`dsh-spill-local` 的根目錄 `0700`、檔案 `0600`）。
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * 把 session id 變成一個安全的檔名基底。
 *
 * subagent 的 id 是 `<root>/<runId>`，帶斜線，直接拿去當檔名會變成子目錄。
 * **會不會撞名不靠這個函式保證**——撞到的時候 `wx` 會拒絕（見模組說明）。
 */
function safeBaseName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length === 0 ? 'session' : cleaned;
}

/** 一份已存會話。IO 延後到第一次 {@link append} 或 {@link flush}。 */
class JsonlStoredSession implements StoredSession {
  readonly #directory: string;
  readonly #base: string;
  readonly #header: StoredSessionHeader;
  #handle: FileHandle | undefined;
  #closed = false;
  /** 已存的 next-seq。下一批的第一顆必須等於它。 */
  #nextSeq = 0;

  constructor(directory: string, header: StoredSessionHeader) {
    this.#directory = directory;
    this.#base = safeBaseName(header.id);
    this.#header = header;
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
    if (handle === undefined) return;
    try {
      await handle.datasync();
    } finally {
      await handle.close();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`會話 "${this.#header.id}" 的把手已經關掉了。`);
  }

  /** 第一次真的要寫時才建目錄、寫 header、開檔。之後直接回同一個 handle。 */
  async #materialize(): Promise<FileHandle> {
    if (this.#handle !== undefined) return this.#handle;
    await mkdir(this.#directory, { recursive: true, mode: DIR_MODE });
    // header 先寫：日誌有內容而 header 不見，比反過來難解釋得多。
    await writeFile(
      join(this.#directory, `${this.#base}.header.json`),
      `${JSON.stringify(this.#header, null, 2)}\n`,
      { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' },
    );
    // `wx`：檔案已經在就拒絕。不覆寫、也不續寫。
    this.#handle = await open(join(this.#directory, `${this.#base}.jsonl`), 'wx', FILE_MODE);
    return this.#handle;
  }
}

/** {@link createJsonlSessionStore} 交出來的東西。 */
export interface JsonlSessionStore extends SessionStore {
  /** 這一次的 run 目錄。披露那一行印的就是它。 */
  readonly directory: string;
}

/**
 * 開一個 JSONL 後端。
 *
 * @param options - `rootDir` 底下會開一個這一次專用的 run 目錄。
 * @returns 後端，以及它實際會寫進去的那個目錄。
 */
export function createJsonlSessionStore(options: { readonly rootDir: string }): JsonlSessionStore {
  // 每一次組裝一個目錄。時間戳在前面是為了人排序得動，UUID 在後面是為了同一毫秒起兩次
  // 也不會撞（`wx` 會擋，但擋下來的是一次硬錯誤，不是我們要的行為）。
  const directory = join(
    options.rootDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
  );
  return {
    directory,
    create(header: StoredSessionHeader): StoredSession {
      return new JsonlStoredSession(directory, header);
    },
  };
}
