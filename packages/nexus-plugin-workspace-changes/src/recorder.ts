/**
 * 一份 root 會話的輪次記錄器：檔案工具改檔前的副本、收尾時的比較、事件，以及留到會話結束的摘要。
 *
 * 照 dsh `workspace-changes/src/recorder.ts`（`ddefc45`）。**這一刀是 dsh「沒有 git」那條模式**
 * （[#443](https://github.com/DemianLi/nexus-agent/issues/443) 第二則決議）：沒有快照，摘要只列檔案工具改過的檔，
 * git 那半是 [#461](https://github.com/DemianLi/nexus-agent/issues/461)。
 *
 * ## 跟 dsh 不一樣的三處
 *
 * 1. **沒有 `turn`**。dsh 每一輪一個狀態物件，靠輪號對上 `tool/result` 與 `turn/end`。我們的日誌沒有輪號，
 *    事件也不帶（同 #441），web 由 `seq` 往前找最近一顆不是 resume 的 `turn/start` 認輪。所以一顆事件
 *    **必須落在它那一輪的 `turn/start` 之後、下一輪的 `turn/start` 之前**：
 *    - 正常收尾在輪內記（{@link TurnRecorder.stopping}，由 `afterAgent` 叫，對應 dsh 的 `agent/turn-stopping`）。
 *    - 中止、失敗的在 `turn/end`／`turn/failed` 之後補記（{@link TurnRecorder.end}，同 dsh）。**這時如果
 *      下一輪已經開始，就不記**，留一行 warn——記下去會被 web 算進下一輪。dsh 有輪號，不必丟。
 * 2. **停在核准點不是收尾**。我們的核准把一輪切成兩段（`turn/end` ＋ 一顆 resume 的 `turn/start`），dsh 的
 *    核准在同一輪裡等。所以 `interrupt/raised` 之後那顆 `turn/end` 不記，resume 接著用同一份狀態，
 *    副本也還是這一輪第一次改之前的那份。
 * 3. **擷取的路徑先從虛擬路徑對到磁碟**（`hostPathOf`），見 `paths.ts`。
 *
 * @module
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SessionLog } from '@nexus/core';
import type { WorkspaceChangedFile, WorkspaceChangesSummary, WorkspaceFileDiff } from '@nexus/wire';

import { captureFile, mutationPath, sameCapture } from './capture.js';
import type { Capture } from './capture.js';
import { compareText } from './compare.js';
import {
  canonicalPath,
  compareDisplay,
  displayPathOf,
  durablePathOf,
  hostPathOf,
  isInside,
  isTemporaryPath,
  temporaryRoots,
} from './paths.js';

/** 同一個 plugin 實例的每一個記錄器共用的東西。 */
export interface RecorderEnvironment {
  /** 每份會話的暫存目錄建在哪裡。 */
  readonly tempRoot: string;
  /** 一份摘要最多帶幾個檔。 */
  readonly maxFiles: number;
  /** 一份副本的位元組上限（含）。 */
  readonly maxFileBytes: number;
  /** 逐行比較可以跑多久，超過就退成整檔替換。 */
  readonly diffTimeoutMs: number;
  /** 失敗回報；失敗的那一輪什麼都不記，下一輪重來。 */
  readonly warn: (message: string) => void;
}

/** 每次比較與顯示用的標準路徑，一份會話解一次。 */
interface Paths {
  /** 標準化的工作區根。 */
  readonly cwd: string;
  /** 標準化的家目錄，顯示時縮成 `~`。 */
  readonly home: string;
  /** 工作區外、這底下的檔永遠不進摘要。 */
  readonly temporaryRoots: readonly string[];
}

/** 一個列出的檔可讀的一側。 */
type ContentSource = Exclude<Capture, { kind: 'oversized' }>;

/** 一個列出的檔的比較從哪裡來：記錄時就決定的拒絕，或要比較時才讀的兩側。 */
type FileSources =
  | { readonly refusal: 'binary' | 'oversized' }
  | { readonly refusal?: undefined; readonly before: ContentSource; readonly after: ContentSource };

/** 服務中的一份摘要，連同每個列出的檔的兩側，與 `summary.files` 逐格對齊。 */
interface TurnRecord {
  readonly summary: WorkspaceChangesSummary;
  readonly sources: readonly FileSources[];
}

/** 一輪累積的東西；新的一輪換一個新物件，所以替舊的那輪排著的工作拿到的還是它自己的。 */
interface TurnState {
  /** 這一輪第一次改每個路徑之前的內容，依標準絕對路徑。 */
  readonly captures: Map<string, Capture>;
  lastToolResultSeq: number;
  /** 最近一次記錄開始時的最後一顆 `tool/result`；`end()` 看它決定要不要補記。 */
  attemptedAfterSeq: number;
  /** 最近一顆記下的事件的 `seq`，沒有是 -1。 */
  recordedAfterSeq: number;
  /** 停在核准點：`interrupt/raised` 之後、resume 之前。 */
  paused: boolean;
}

/** 一個列出的檔與它兩側的來源。 */
interface Listed {
  readonly file: WorkspaceChangedFile;
  readonly sources: FileSources;
}

/**
 * 把一份會話的記錄工作排成一列：每次改檔前的整檔副本、收尾時的比較，以及寫進日誌的 `workspace/changes`，
 * 那顆事件指到的摘要與比較由這個記錄器保管。副本放在記錄器自己的暫存目錄裡，收掉時連同摘要一起刪。
 * 工具執行前會等排著的工作做完，所以副本不會被改檔搶先。
 */
export class TurnRecorder {
  #chain: Promise<void> = Promise.resolve();
  /** 目前這一輪；第一顆 `turn/start` 之前沒有。 */
  #state: TurnState | undefined;
  #paths: Paths | undefined;
  /** 這份會話的暫存目錄，第一次要用時才建。 */
  #scratch: Promise<string> | undefined;
  /** 依宣告它的那顆事件的 `seq`。 */
  readonly #records = new Map<number, TurnRecord>();
  readonly #lifetime = new AbortController();

  /**
   * @param log - root 那一份日誌，事件寫在這裡。
   * @param root - 工作區根（`--workspace`）。
   * @param env - 上限與回報。
   */
  constructor(
    private readonly log: SessionLog,
    private readonly root: string,
    private readonly env: RecorderEnvironment,
  ) {}

  /** 一輪開始（不是 resume 的 `turn/start`）：換一份新的狀態。 */
  start(): void {
    this.#state = freshState();
    void this.#enqueue(async () => {
      this.#paths ??= {
        cwd: await realpath(this.root),
        home: await canonicalPath(homedir()),
        temporaryRoots: await temporaryRoots(),
      };
    });
  }

  /**
   * 工具跑之前排一次擷取；一輪裡同一個路徑只擷取第一次。之後要 await {@link settled}，工具才不會搶先。
   * @param name - 工具名。
   * @param args - 解析過的呼叫參數。
   */
  capture(name: string, args: unknown): void {
    const path = mutationPath(name, args);
    const state = this.#state;
    if (path === undefined || state === undefined) return;
    void this.#enqueue(async () => {
      const paths = this.#paths;
      if (paths === undefined) return;
      const absolute = await canonicalPath(hostPathOf(paths.cwd, path));
      if (state.captures.has(absolute)) return;
      const capture = await captureFile(absolute, await this.#captures(), this.env.maxFileBytes);
      if (capture !== undefined) state.captures.set(absolute, capture);
    });
  }

  /**
   * 記下一顆落定的 `tool/result`，讓 `turn/end` 之後的補記涵蓋它。
   * @param seq - 那顆事件的 `seq`。
   */
  observe(seq: number): void {
    if (this.#state !== undefined) this.#state.lastToolResultSeq = seq;
  }

  /** 停在核准點（`interrupt/raised`）。 */
  pause(): void {
    if (this.#state !== undefined) this.#state.paused = true;
  }

  /** 從核准點接回來（resume 的 `turn/start`）：同一輪，同一份狀態。 */
  resume(): void {
    if (this.#state !== undefined) this.#state.paused = false;
  }

  /**
   * 在輪內記下這一輪的改動，`turn/end` 之前。
   * @returns 事件寫進去、或這次嘗試失敗之後。
   */
  stopping(): Promise<void> {
    const state = this.#state;
    if (state === undefined) return Promise.resolve();
    return this.#enqueue(() => this.#record(state));
  }

  /** `turn/end`／`turn/failed` 之後補記，除非停在核准點，或最後一顆結果之後已經試過一次。 */
  end(): void {
    const state = this.#state;
    if (state === undefined || state.paused) return;
    if (state.attemptedAfterSeq >= state.lastToolResultSeq) return;
    void this.#enqueue(() => this.#record(state));
  }

  /** @returns 排著的每一件都落定之後。 */
  settled(): Promise<void> {
    return this.#chain;
  }

  /**
   * 一顆 `workspace/changes` 宣告的摘要。
   * @param seq - 那顆事件的 `seq`。
   * @returns 摘要；不是這個記錄器宣告的、或已經收掉時是 `undefined`。
   */
  summary(seq: number): WorkspaceChangesSummary | undefined {
    return this.#records.get(seq)?.summary;
  }

  /**
   * 比較一個列出的檔在這一輪開始與結束時的內容。
   * @param seq - 宣告它的那顆事件的 `seq`。
   * @param index - 它在摘要 `files` 裡的位置。
   * @param signal - 取消讀取。
   * @returns 比較；認不得的 `seq` 或 `index`、或已經收掉時是 `undefined`。
   * @throws 記錄器還活著時讀檔失敗。
   */
  async diff(
    seq: number,
    index: number,
    signal: AbortSignal,
  ): Promise<WorkspaceFileDiff | undefined> {
    const record = this.#records.get(seq);
    const file = record?.summary.files[index];
    const sources = record?.sources[index];
    if (file === undefined || sources === undefined) return undefined;
    const { path, display } = file;
    if (sources.refusal !== undefined) return { kind: sources.refusal, path, display };
    const combined = AbortSignal.any([signal, this.#lifetime.signal]);
    try {
      const [before, after] = await Promise.all([
        readSide(sources.before, combined),
        readSide(sources.after, combined),
      ]);
      const { hunks, coarse } = compareText(before, after, this.env.diffTimeoutMs);
      return {
        kind: 'text',
        path,
        display,
        before: before !== null,
        after: after !== null,
        hunks,
        coarse,
      };
    } catch (error: unknown) {
      // 收掉時暫存目錄在讀到一半時被刪；會話反正已經不在了。
      if (this.#lifetime.signal.aborted) return undefined;
      throw error;
    }
  }

  /**
   * 中止排著的工作、忘掉每一份摘要、刪掉暫存目錄。
   * @returns 暫存目錄刪掉之後。
   */
  async dispose(): Promise<void> {
    this.#lifetime.abort();
    this.#records.clear();
    await this.#chain;
    if (this.#scratch !== undefined) {
      await rm(await this.#scratch, { recursive: true, force: true });
    }
  }

  /** 這份會話的暫存目錄。`mkdtemp` 建出來就是 `0700`：多人共用主機上別人讀不到副本。 */
  scratchDirectory(): Promise<string> {
    this.#scratch ??= mkdtemp(join(this.env.tempRoot, 'nexus-workspace-changes-'));
    return this.#scratch;
  }

  async #captures(): Promise<string> {
    return join(await this.scratchDirectory(), 'captures');
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(async () => {
      if (this.#lifetime.signal.aborted) return;
      try {
        await task();
      } catch (error: unknown) {
        // 收掉之後的失敗是預期中的取消，不講。
        if (!this.#lifetime.signal.aborted) this.env.warn(`workspace-changes: ${String(error)}`);
      }
    });
    this.#chain = run;
    return run;
  }

  async #record(state: TurnState): Promise<void> {
    const paths = this.#paths;
    if (paths === undefined || state.lastToolResultSeq < 0) return;
    state.attemptedAfterSeq = state.lastToolResultSeq;
    const listed: Listed[] = [];
    for (const [absolute, before] of state.captures) {
      // 工作區外，暫存目錄底下的草稿不列。
      if (!isInside(paths.cwd, absolute) && isTemporaryPath(absolute, paths.temporaryRoots)) {
        continue;
      }
      const after = await captureFile(absolute, await this.#captures(), this.env.maxFileBytes);
      if (after === undefined || sameCapture(before, after)) continue;
      listed.push(await this.#compared(paths, absolute, before, after));
    }
    const sorted = listed.sort((a, b) => compareDisplay(a.file, b.file));
    // 這一輪先前記過一份時，空的清單取代它。
    if (sorted.length === 0 && state.recordedAfterSeq < 0) return;
    if (this.#state !== state) {
      // 見檔頭第 1 點：下一輪已經開始，記下去會被算進那一輪。
      this.env.warn('workspace-changes: 下一輪已經開始，上一輪的改動紀錄不記');
      return;
    }
    const event = this.log.append('workspace/changes', {});
    const kept = sorted.slice(0, this.env.maxFiles);
    this.#records.set(event.seq, {
      summary: {
        files: kept.map((entry) => entry.file),
        total: sorted.length,
        added: sorted.reduce((sum, entry) => sum + entry.file.added, 0),
        deleted: sorted.reduce((sum, entry) => sum + entry.file.deleted, 0),
      },
      sources: kept.map((entry) => entry.sources),
    });
    state.recordedAfterSeq = event.seq;
  }

  /**
   * 一對副本的列法：過大的一側列出來但沒有行數、拒絕比較；二進位同樣；兩側都是文字就帶逐行比較的行數。
   */
  async #compared(
    paths: Paths,
    absolute: string,
    before: Capture,
    after: Capture,
  ): Promise<Listed> {
    const list = (counts: Counts, sources: FileSources): Listed => ({
      file: changedFile(paths, absolute, counts),
      sources,
    });
    if (before.kind === 'oversized' || after.kind === 'oversized') {
      return list(
        { added: 0, deleted: 0, binary: false, oversized: true },
        { refusal: 'oversized' },
      );
    }
    if (isBinary(before) || isBinary(after)) {
      return list({ added: 0, deleted: 0, binary: true }, { refusal: 'binary' });
    }
    const { added, deleted } = compareText(
      await readSide(before),
      await readSide(after),
      this.env.diffTimeoutMs,
    );
    return list({ added, deleted, binary: false }, { before, after });
  }
}

function freshState(): TurnState {
  return {
    captures: new Map(),
    lastToolResultSeq: -1,
    attemptedAfterSeq: -1,
    recordedAfterSeq: -1,
    paused: false,
  };
}

/** 一側的文字；缺席是 `null`。 */
async function readSide(source: ContentSource, signal?: AbortSignal): Promise<string | null> {
  return source.kind === 'absent'
    ? null
    : readFile(source.file, { encoding: 'utf8', ...(signal !== undefined && { signal }) });
}

/** 這一側是不是二進位。 */
function isBinary(capture: Capture): boolean {
  return capture.kind === 'file' && capture.binary;
}

interface Counts {
  readonly added: number;
  readonly deleted: number;
  readonly binary: boolean;
  readonly oversized?: boolean;
}

function changedFile({ cwd, home }: Paths, absolute: string, counts: Counts): WorkspaceChangedFile {
  return {
    path: durablePathOf(absolute, cwd),
    display: displayPathOf(absolute, cwd, home),
    added: counts.added,
    deleted: counts.deleted,
    ...(counts.binary && { binary: true as const }),
    ...(counts.oversized === true && { oversized: true as const }),
  };
}
