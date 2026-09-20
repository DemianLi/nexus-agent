/**
 * 一份 root 會話的輪次記錄器：輪開始與收尾的 git 快照、檔案工具改檔前的副本、收尾時的比較、事件，以及
 * 留到會話結束的摘要。
 *
 * 照 dsh `workspace-changes/src/recorder.ts`（`ddefc45`）。工作區在 git repo 裡時，比較兩棵快照樹，連使用者
 * 自己改的、`submit_record` 寫的、MCP 工具在外面改的檔都涵蓋；快照蓋不到的路徑（被忽略的、repo 外的）照舊
 * 用副本比。不在 repo 裡、或沒有 git 時，只列檔案工具改過的檔（[#461](https://github.com/DemianLi/nexus-agent/issues/461)
 * 之前的第一刀就是這條模式）。
 *
 * ## 跟 dsh 不一樣的四處
 *
 * 1. **沒有 `turn`**。dsh 每一輪一個狀態物件，靠輪號對上 `tool/result` 與 `turn/end`。我們的日誌沒有輪號，
 *    事件也不帶（同 #441），在日誌上由 `seq` 往前找最近一顆不是 resume 的 `turn/start` 認輪，web 由折疊出來
 *    那一格的位置認。所以一顆事件**必須落在它那一輪的 `turn/start` 之後、下一輪的 `turn/start` 之前**：
 *    - 正常收尾在輪內記（{@link TurnRecorder.stopping}，由 `afterAgent` 叫，對應 dsh 的 `agent/turn-stopping`）。
 *    - 中止、失敗的在 `turn/end`／`turn/failed` 之後補記（{@link TurnRecorder.end}，同 dsh）。**這時如果
 *      下一輪已經開始，就不記**，留一行 warn——記下去會被算進下一輪。dsh 有輪號，不必丟。
 * 2. **停在核准點不是收尾**。我們的核准把一輪切成兩段（`turn/end` ＋ 一顆 resume 的 `turn/start`），dsh 的
 *    核准在同一輪裡等。所以 `interrupt/raised` 之後那顆 `turn/end` 不記，resume 接著用同一份狀態：基準快照與
 *    副本都還是這一輪開始時的。
 * 3. **接上時重播的舊輪不拍快照**。dsh 的記錄器在 `session/event` 上只收活的事件；我們的 `observe` 會先重播
 *    接上當下已經在的事件，一份有 N 輪的 thread 接上就會跑 N 次 `git add --all`。所以重播出來的一輪基準
 *    **延後**（`'deferred'`），只有活的 resume 接回那一輪時（serve 重開之後在核准點接著跑）才補拍——那一刻
 *    的工作樹就是那一輪剩下那一段的起點。
 * 4. **擷取的路徑先從虛擬路徑對到磁碟**（`hostPathOf`），見 `paths.ts`。
 *
 * @module
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import type { SessionLog } from '@nexus/core';
import type { WorkspaceChangedFile, WorkspaceChangesSummary, WorkspaceFileDiff } from '@nexus/wire';

import { captureFile, mutationPath, sameCapture } from './capture.js';
import type { Capture } from './capture.js';
import { compareText } from './compare.js';
import {
  blobText,
  diffTrees,
  gitlinkPaths,
  ignoredPaths,
  locateGitWorkspace,
  snapshotTree,
  treeBlob,
} from './git.js';
import type { GitRunner, GitWorkspace } from './git.js';
import {
  canonicalPath,
  compareDisplay,
  displayPathOf,
  durablePathOf,
  hostPathOf,
  isInside,
  isTemporaryPath,
  temporaryRoots,
  toPosix,
} from './paths.js';

/** 同一個 plugin 實例的每一個記錄器共用的東西。 */
export interface RecorderEnvironment {
  /** 解出 runner；沒有 git 時是 `null`，不拍快照。 */
  readonly git: Promise<GitRunner | null>;
  /** 每份會話的暫存目錄建在哪裡。 */
  readonly tempRoot: string;
  /** 一份摘要最多帶幾個檔。 */
  readonly maxFiles: number;
  /** 一份副本、以及比較時從快照讀的一個 blob 的位元組上限（含）。 */
  readonly maxFileBytes: number;
  /** 逐行比較可以跑多久，超過就退成整檔替換。 */
  readonly diffTimeoutMs: number;
  /** 失敗回報；失敗的那一輪什麼都不記，下一輪重來。 */
  readonly warn: (message: string) => void;
}

/** 每次比較與顯示用的標準路徑，一份會話解一次。 */
interface Paths {
  /** 標準化的工作區根；git 報的是解開符號連結的路徑，所以每次比較都用這個寫法。 */
  readonly cwd: string;
  /** 標準化的家目錄，顯示時縮成 `~`。 */
  readonly home: string;
  /** 工作區外、這底下的檔永遠不進摘要。 */
  readonly temporaryRoots: readonly string[];
}

/** 包住工作區的 repo 與拍它快照的 runner。 */
interface Repository {
  readonly git: GitRunner;
  readonly workspace: GitWorkspace;
}

/** 一個找到的 repo 在輪開始時的快照。 */
interface Baseline extends Repository {
  readonly tree: string;
}

/** 一個列出的檔可讀的一側。 */
type ContentSource =
  /** 快照樹裡的一個路徑；在不在、多大、內容，要用時才從 git 讀。 */
  | {
      readonly kind: 'snapshot';
      readonly repository: Repository;
      readonly tree: string;
      readonly path: string;
    }
  | Exclude<Capture, { kind: 'oversized' }>;

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
  /**
   * 輪開始的快照。`null` 是沒有 repo 或沒有 git，這一輪只列檔案工具的副本；`'failed'` 是 repo 在、快照
   * 失敗了，這一輪什麼都不記；`'deferred'` 是重播出來的一輪，見檔頭第 3 點。
   */
  baseline: Baseline | null | 'failed' | 'deferred';
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

/** 快照那一側超過位元組上限。 */
const OVERSIZED = Symbol('oversized');

/**
 * 把一份會話的記錄工作排成一列：輪開始的快照、每次改檔前的整檔副本、收尾時的快照與比較，以及寫進日誌的
 * `workspace/changes`，那顆事件指到的摘要與比較由這個記錄器保管。快照物件與副本放在記錄器自己的暫存目錄裡，
 * 收掉時連同摘要一起刪。工具執行前會等排著的工作做完，所以快照與副本不會被改檔搶先。
 */
export class TurnRecorder {
  #chain: Promise<void> = Promise.resolve();
  /** 目前這一輪；第一顆 `turn/start` 之前沒有。 */
  #state: TurnState | undefined;
  #paths: Paths | undefined;
  /** 找到的 repo，找到之後每一輪共用；`null` 時每一輪重找。 */
  #repository: Repository | null = null;
  /** 這份會話的暫存目錄，第一次要用時才建。 */
  #scratch: Promise<string> | undefined;
  /** 依宣告它的那顆事件的 `seq`。 */
  readonly #records = new Map<number, TurnRecord>();
  readonly #lifetime = new AbortController();

  /**
   * @param log - root 那一份日誌，事件寫在這裡。
   * @param root - 工作區根（`--workspace`）。
   * @param env - runner、上限與回報。
   */
  constructor(
    private readonly log: SessionLog,
    private readonly root: string,
    private readonly env: RecorderEnvironment,
  ) {}

  /**
   * 一輪開始（不是 resume 的 `turn/start`）：換一份新的狀態，排它的基準快照。
   * @param live - `false` 是接上時重播出來的舊輪：基準延後，見檔頭第 3 點。
   */
  start(live: boolean): void {
    const state = freshState();
    this.#state = state;
    if (live) this.#queueBaseline(state);
    else state.baseline = 'deferred';
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

  /**
   * 從核准點接回來（resume 的 `turn/start`）：同一輪，同一份狀態。
   * @param live - 活的 resume 接回一輪延後的基準時，這時才拍，見檔頭第 3 點。
   */
  resume(live: boolean): void {
    const state = this.#state;
    if (state === undefined) return;
    state.paused = false;
    if (live && state.baseline === 'deferred') this.#queueBaseline(state);
  }

  /**
   * 在輪內記下這一輪的改動，`turn/end` 之前。
   * @returns 事件寫進去、或這次嘗試失敗之後。
   */
  stopping(): Promise<void> {
    const state = this.#state;
    if (state === undefined) return Promise.resolve();
    return this.#enqueue((signal) => this.#record(state, signal));
  }

  /** `turn/end`／`turn/failed` 之後補記，除非停在核准點，或最後一顆結果之後已經試過一次。 */
  end(): void {
    const state = this.#state;
    if (state === undefined || state.paused) return;
    if (state.attemptedAfterSeq >= state.lastToolResultSeq) return;
    void this.#enqueue((signal) => this.#record(state, signal));
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
   * @throws 記錄器還活著時讀取失敗。
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
        this.#readSide(sources.before, combined),
        this.#readSide(sources.after, combined),
      ]);
      if (before === OVERSIZED || after === OVERSIZED) return { kind: 'oversized', path, display };
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
   * 中止排著的工作、忘掉每一份摘要、刪掉暫存目錄（含快照的私有物件庫）。
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

  /** 這份會話的暫存目錄。`mkdtemp` 建出來就是 `0700`：多人共用主機上別人讀不到副本與快照物件。 */
  scratchDirectory(): Promise<string> {
    this.#scratch ??= mkdtemp(join(this.env.tempRoot, 'nexus-workspace-changes-'));
    return this.#scratch;
  }

  async #captures(): Promise<string> {
    return join(await this.scratchDirectory(), 'captures');
  }

  #enqueue(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const run = this.#chain.then(async () => {
      if (this.#lifetime.signal.aborted) return;
      try {
        await task(this.#lifetime.signal);
      } catch (error: unknown) {
        // 收掉之後的失敗是預期中的取消，不講。
        if (!this.#lifetime.signal.aborted) this.env.warn(`workspace-changes: ${String(error)}`);
      }
    });
    this.#chain = run;
    return run;
  }

  /** 排一輪的基準快照；在這之前解好標準路徑。 */
  #queueBaseline(state: TurnState): void {
    state.baseline = null;
    void this.#enqueue(async (signal) => {
      try {
        this.#paths ??= {
          cwd: await realpath(this.root),
          home: await canonicalPath(homedir()),
          temporaryRoots: await temporaryRoots(),
        };
        const repository = await this.#locate(this.#paths.cwd, signal);
        if (repository === null) return;
        const tree = await snapshotTree(repository.git, repository.workspace, signal);
        state.baseline = { ...repository, tree };
      } catch (error: unknown) {
        // repo 在、快照失敗的一輪，不能當成沒有 repo 來摘要。
        state.baseline = 'failed';
        throw error;
      }
    });
  }

  /** 包住工作區的 repo，找到一次就留著；`null` 時每一輪重找。 */
  async #locate(cwd: string, signal: AbortSignal): Promise<Repository | null> {
    if (this.#repository !== null) return this.#repository;
    const git = await this.env.git;
    if (git === null) return null;
    const workspace = await locateGitWorkspace(git, cwd, () => this.scratchDirectory(), signal);
    if (workspace === null) return null;
    this.#repository = { git, workspace };
    return this.#repository;
  }

  /** 一側的文字；缺席是 `null`，快照那一側超過上限是 {@link OVERSIZED}。 */
  async #readSide(
    source: ContentSource,
    signal: AbortSignal,
  ): Promise<string | null | typeof OVERSIZED> {
    switch (source.kind) {
      case 'absent':
        return null;
      case 'file':
        return readFile(source.file, { encoding: 'utf8', signal });
      case 'snapshot': {
        const { git, workspace } = source.repository;
        const blob = await treeBlob(git, workspace, source.tree, source.path, signal);
        if (blob === null) return null;
        if (blob.size > this.env.maxFileBytes) return OVERSIZED;
        return blobText(git, workspace, blob.oid, this.env.maxFileBytes, signal);
      }
    }
  }

  async #record(state: TurnState, signal: AbortSignal): Promise<void> {
    const paths = this.#paths;
    const { baseline } = state;
    if (paths === undefined || state.lastToolResultSeq < 0) return;
    if (baseline === 'failed' || baseline === 'deferred') return;
    state.attemptedAfterSeq = state.lastToolResultSeq;
    // 沒有快照時，工作區本身就是邊界。
    const root = baseline?.workspace.root ?? paths.cwd;
    const listed = new Map<string, Listed>();
    if (baseline !== null) {
      const after = await snapshotTree(baseline.git, baseline.workspace, signal);
      const repository: Repository = { git: baseline.git, workspace: baseline.workspace };
      const entries = await diffTrees(
        baseline.git,
        baseline.workspace,
        baseline.tree,
        after,
        signal,
      );
      for (const entry of entries) {
        const absolute = resolve(root, entry.path);
        listed.set(absolute, {
          file: changedFile(paths, root, absolute, entry),
          sources: entry.binary
            ? { refusal: 'binary' }
            : {
                before: {
                  kind: 'snapshot',
                  repository,
                  tree: baseline.tree,
                  path: entry.oldPath ?? entry.path,
                },
                after: { kind: 'snapshot', repository, tree: after, path: entry.path },
              },
        });
      }
    }
    // 快照蓋不到的已擷取路徑，用副本比。
    const captured = [...state.captures.keys()].filter((absolute) => !listed.has(absolute));
    const workTreePath = (absolute: string): string => toPosix(relative(root, absolute));
    let inWorkspace = captured.filter((absolute) => isInside(root, absolute));
    if (baseline !== null && inWorkspace.length > 0) {
      // 巢狀 repo 與 submodule 是 gitlink：裡面的內容不進摘要。
      const gitlinks = [...(await gitlinkPaths(baseline.git, baseline.workspace, signal))];
      inWorkspace = inWorkspace.filter(
        (absolute) => !gitlinks.some((link) => isInside(resolve(root, link), absolute)),
      );
    }
    // 快照蓋得到工作樹裡除了被忽略的每一個檔；沒有快照時，每一次檔案工具的改動都算。
    const uncoveredInWorkspace =
      baseline === null
        ? new Set(inWorkspace.map(workTreePath))
        : await ignoredPaths(
            baseline.git,
            baseline.workspace,
            inWorkspace.map(workTreePath),
            signal,
          );
    for (const absolute of captured) {
      // 工作樹外，暫存目錄底下的草稿不列。
      const uncovered = isInside(root, absolute)
        ? uncoveredInWorkspace.has(workTreePath(absolute))
        : !isTemporaryPath(absolute, paths.temporaryRoots);
      if (!uncovered) continue;
      const before = state.captures.get(absolute)!;
      const after = await captureFile(absolute, await this.#captures(), this.env.maxFileBytes);
      if (after === undefined || sameCapture(before, after)) continue;
      listed.set(absolute, await this.#compared(paths, root, absolute, before, after));
    }
    const sorted = [...listed.values()].sort((a, b) => compareDisplay(a.file, b.file));
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
    root: string,
    absolute: string,
    before: Capture,
    after: Capture,
  ): Promise<Listed> {
    const list = (counts: Counts, sources: FileSources): Listed => ({
      file: changedFile(paths, root, absolute, counts),
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
      await readCapture(before),
      await readCapture(after),
      this.env.diffTimeoutMs,
    );
    return list({ added, deleted, binary: false }, { before, after });
  }
}

function freshState(): TurnState {
  return {
    baseline: null,
    captures: new Map(),
    lastToolResultSeq: -1,
    attemptedAfterSeq: -1,
    recordedAfterSeq: -1,
    paused: false,
  };
}

/** 一份副本的文字；缺席是 `null`。 */
async function readCapture(
  capture: Exclude<Capture, { kind: 'oversized' }>,
): Promise<string | null> {
  return capture.kind === 'absent' ? null : readFile(capture.file, 'utf8');
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

function changedFile(
  { cwd, home }: Paths,
  root: string,
  absolute: string,
  counts: Counts,
): WorkspaceChangedFile {
  return {
    path: durablePathOf(absolute, cwd),
    display: displayPathOf(absolute, cwd, root, home),
    added: counts.added,
    deleted: counts.deleted,
    ...(counts.binary && { binary: true as const }),
    ...(counts.oversized === true && { oversized: true as const }),
  };
}
