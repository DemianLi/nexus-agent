/**
 * 嵌入方的身分對應表（[#2370](https://github.com/DemianLi/nexus-agent/issues/2370)，#1827 D231）：管理者寫的
 * 「嵌入方＋對方帳號 → nexus 使用者代號」，不在表上就拒。
 *
 * - **檔**：`<home>/embed-identities.json`，固定路徑、`0600`，serve 不替管理者建。表是憑證層級的東西，不放進插件設定，連路徑也不放。
 * - **形狀**：`{ "version": 1, "mappings": [{ "embedder", "subject", "userId" }] }`，不認得的欄位一律拒。
 *   `embedder` 要是設定裡有的嵌入方；`subject` 1 到 256 字、照原樣比；`userId` 是小寫英數開頭的小寫英數與 `._-`，最長 64 字。
 *   同一組 (embedder, subject) 只能出現一次；不同的對方帳號可以對到同一個 `userId`。
 * - **啟動時**（{@link EmbedIdentityTable.load}）：檔不在、權限過寬、不是一般檔案、太大、讀不了、不合規就拋，serve 起不來。
 * - **跑著時**：查表前先 stat，距上次 stat 不到 {@link IDENTITY_TABLE_STAT_INTERVAL_MS} 就沿用；檔變了才重讀，改表不用重啟。
 *   重讀失敗（壞掉、權限變寬、被刪）時一律拒（`identity_table_invalid`），修好之後下一次查表自動恢復。
 * - **訊息只指名檔與第幾筆**：不印 subject 與 userId 的值。
 *
 * @module
 */

import { readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';

import type { EmbedIdentity, EmbedIdentityResolver } from './embed-login.js';
import { assertOwnerOnlyMode } from './owner-only.js';

/** 對應表在 harness home 底下的檔名。 */
export const EMBED_IDENTITIES_FILE = 'embed-identities.json';

/** 兩次 stat 之間至少隔多久（毫秒）：查表跟請求一樣頻繁，stat 不必每次都做。 */
export const IDENTITY_TABLE_STAT_INTERVAL_MS = 1000;

/** 表檔大小的上限（位元組）：超過就當作不合規。 */
export const MAX_IDENTITY_TABLE_BYTES = 1024 * 1024;

const TABLE_VERSION = 1;
const MAX_SUBJECT_LENGTH = 256;
const USER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const TABLE_LABEL = '嵌入身分對應表';

type Lookup = ReadonlyMap<string, ReadonlyMap<string, string>>;

type TableState =
  | { readonly kind: 'ready'; readonly lookup: Lookup; readonly size: number }
  | { readonly kind: 'invalid'; readonly message: string };

/** {@link EmbedIdentityTable.load} 的選項。 */
export interface EmbedIdentityTableOptions {
  /** 重讀失敗時講一次（失敗原因變了再講）、恢復時講一次；訊息不帶 subject 與 userId 的值。 */
  readonly warn?: (message: string) => void;
  /** 單調時鐘（毫秒），決定多久 stat 一次；測試換掉。 */
  readonly monotonicNow?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

/** stat 結果裡能看出檔被換過或改過的部分。 */
function fingerprint(stats: Stats): string {
  return `${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}:${String(stats.ctimeMs)}:${String(stats.mode)}`;
}

/**
 * 解析表的內容。
 *
 * @returns 查表用的兩層 `Map`（嵌入方 → 對方帳號 → 使用者代號）與筆數。
 * @throws 不合規：訊息指名檔與第幾筆（從 1 數），不帶值。
 */
function parseTable(
  file: string,
  text: string,
  embedders: ReadonlySet<string>,
): { readonly lookup: Lookup; readonly size: number } {
  const fail = (detail: string): Error => new Error(`${TABLE_LABEL} ${file} ${detail}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail('不是合法的 JSON。');
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ['version', 'mappings'])) {
    throw fail('頂層要剛好是 { "version", "mappings" } 兩個欄位。');
  }
  if (parsed.version !== TABLE_VERSION) {
    throw fail(`的 version 要是 ${String(TABLE_VERSION)}。`);
  }
  if (!Array.isArray(parsed.mappings)) throw fail('的 mappings 要是陣列。');
  const lookup = new Map<string, Map<string, string>>();
  const firstSeen = new Map<string, Map<string, number>>();
  parsed.mappings.forEach((entry: unknown, index) => {
    const at = `第 ${String(index + 1)} 筆`;
    if (!isRecord(entry) || !hasExactKeys(entry, ['embedder', 'subject', 'userId'])) {
      throw fail(`${at}要剛好是 { "embedder", "subject", "userId" } 三個欄位。`);
    }
    const { embedder, subject, userId } = entry;
    if (typeof embedder !== 'string' || !embedders.has(embedder)) {
      throw fail(`${at}的 embedder 不是 embed-login 設定裡的嵌入方。`);
    }
    if (
      typeof subject !== 'string' ||
      subject.length === 0 ||
      subject.length > MAX_SUBJECT_LENGTH
    ) {
      throw fail(`${at}的 subject 要是 1 到 ${String(MAX_SUBJECT_LENGTH)} 字的字串。`);
    }
    if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
      throw fail(`${at}的 userId 要是小寫英數開頭、只含小寫英數與 . _ -、最長 64 字。`);
    }
    const seen = firstSeen.get(embedder) ?? new Map<string, number>();
    firstSeen.set(embedder, seen);
    const earlier = seen.get(subject);
    if (earlier !== undefined) {
      throw fail(`${at}與第 ${String(earlier + 1)} 筆的 embedder 與 subject 重複。`);
    }
    seen.set(subject, index);
    const subjects = lookup.get(embedder) ?? new Map<string, string>();
    lookup.set(embedder, subjects);
    subjects.set(subject, userId);
  });
  return { lookup, size: parsed.mappings.length };
}

/**
 * 讀一次表：stat、權限、大小、內容。
 *
 * @throws 檔不在、權限過寬、不是一般檔案、太大、讀不了、不合規。
 */
function readTable(
  file: string,
  embedders: ReadonlySet<string>,
): { readonly stats: Stats; readonly lookup: Lookup; readonly size: number } {
  let stats: Stats;
  try {
    stats = statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      throw new Error(
        `${TABLE_LABEL} ${file} 不存在：embed-login 設了嵌入方，就要由管理者寫這個檔（權限 0600），serve 不會替你建。`,
      );
    }
    throw error;
  }
  assertOwnerOnlyMode(TABLE_LABEL, file, stats.mode);
  if (!stats.isFile()) throw new Error(`${TABLE_LABEL} ${file} 不是一般檔案。`);
  if (stats.size > MAX_IDENTITY_TABLE_BYTES) {
    throw new Error(`${TABLE_LABEL} ${file} 超過 ${String(MAX_IDENTITY_TABLE_BYTES)} 位元組。`);
  }
  const text = readFileSync(file, 'utf8');
  return { stats, ...parseTable(file, text, embedders) };
}

/**
 * 管理者寫的身分對應表。實作 {@link EmbedIdentityResolver}：換票、兌換與驗嵌入 cookie（`embed-session.ts`）都問它。
 *
 * 查表是同步的：表檔小，stat 之間有間隔，檔沒變就不讀。
 */
export class EmbedIdentityTable implements EmbedIdentityResolver {
  readonly #file: string;
  readonly #embedders: ReadonlySet<string>;
  readonly #warn: (message: string) => void;
  readonly #monotonicNow: () => number;
  #state: TableState;
  #fingerprint: string | undefined;
  #checkedAt: number;

  private constructor(
    file: string,
    embedders: ReadonlySet<string>,
    loaded: ReturnType<typeof readTable>,
    options: EmbedIdentityTableOptions,
  ) {
    this.#file = file;
    this.#embedders = embedders;
    this.#warn = options.warn ?? (() => undefined);
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#state = { kind: 'ready', lookup: loaded.lookup, size: loaded.size };
    this.#fingerprint = fingerprint(loaded.stats);
    this.#checkedAt = this.#monotonicNow();
  }

  /**
   * 啟動時讀表。
   *
   * @param file - 表檔的絕對路徑（`<home>/embed-identities.json`）。
   * @param embedders - embed-login 設定裡的嵌入方 id。
   * @throws 檔不在、權限過寬、不是一般檔案、太大、讀不了、不合規：serve 該起不來。
   */
  static load(
    file: string,
    embedders: Iterable<string>,
    options: EmbedIdentityTableOptions = {},
  ): EmbedIdentityTable {
    const ids = new Set(embedders);
    return new EmbedIdentityTable(file, ids, readTable(file, ids), options);
  }

  /** 目前表裡有幾筆；表不合規時是 `undefined`。 */
  get size(): number | undefined {
    const state = this.#current();
    return state.kind === 'ready' ? state.size : undefined;
  }

  resolve(embedder: string, subject: string): EmbedIdentity {
    const state = this.#current();
    if (state.kind === 'invalid') return { kind: 'rejected', reason: 'identity_table_invalid' };
    const userId = state.lookup.get(embedder)?.get(subject);
    return userId === undefined
      ? { kind: 'rejected', reason: 'not_mapped' }
      : { kind: 'accepted', userId };
  }

  #current(): TableState {
    const now = this.#monotonicNow();
    if (now - this.#checkedAt < IDENTITY_TABLE_STAT_INTERVAL_MS) return this.#state;
    this.#checkedAt = now;
    let stats: Stats | undefined;
    try {
      stats = statSync(this.#file);
    } catch {
      // 被刪或讀不了：下面的 readTable 會拋出指名原因的訊息。
    }
    if (stats !== undefined && fingerprint(stats) === this.#fingerprint) return this.#state;
    try {
      const loaded = readTable(this.#file, this.#embedders);
      if (this.#state.kind === 'invalid') {
        this.#warn(
          `[嵌入換票] ${TABLE_LABEL} ${this.#file} 恢復：重讀成功，${String(loaded.size)} 筆。`,
        );
      }
      this.#state = { kind: 'ready', lookup: loaded.lookup, size: loaded.size };
      this.#fingerprint = fingerprint(loaded.stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.#state.kind === 'ready' || this.#state.message !== message) {
        this.#warn(`[嵌入換票] ${message} 換票與兌換一律拒絕，直到修好。`);
      }
      this.#state = { kind: 'invalid', message };
      this.#fingerprint = stats === undefined ? undefined : fingerprint(stats);
    }
    return this.#state;
  }
}
