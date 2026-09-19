/**
 * 每一輪改了工作區哪些檔（[#443](https://github.com/DemianLi/nexus-agent/issues/443)），照 dsh
 * `@deepseek-ai/dsh-workspace-changes`（`packages/deliverables/workspace-changes`，`ddefc45`）。
 *
 * 工作區在 git repo 裡時，輪開始與收尾各拍一次工作樹快照，兩棵樹比出這一輪改了什麼——連檔案工具以外的改動
 * （使用者自己改的、`submit_record` 寫的、MCP 工具在外面改的）都在（[#461](https://github.com/DemianLi/nexus-agent/issues/461)）。
 * 檔案工具（`write_file`、`edit_file`、`delete`）改一個檔之前，另外把那個檔整份複製一份，每一輪每個路徑只複製
 * 第一次、收尾時再複製一次，快照蓋不到的路徑（被忽略的、repo 外的）用這兩份比；不在 repo 裡、或沒有 git 時，
 * 只有這兩份。有改的話，root 日誌寫一顆 `workspace/changes`，摘要與逐檔比較留在記錄器裡，經
 * {@link WorkspaceChanges} 服務到會話結束。模型看不到任何東西：這一條只寫日誌，web 讀。
 *
 * ## 掛法：只在 serve、只在有 `--workspace` 的時候
 *
 * - dsh 由 web-app bundle 出廠掛（`packages/bundle/web-app/cordis.patch.yml:300`），終端機那側不掛；我們同樣
 *   只在 serve 掛（`createCliAgent` 的 `workspaceChanges` 選項），CLI 沒有人讀摘要。
 * - dsh 的 `eligible` 看會話 header 的 `cwd`；我們的「沒有工作區」＝沒給 `--workspace`，而工廠要的正是那個根。
 *   所以**不合格由缺席表達**：組裝點只在有根的時候建這個 plugin，沒有執行期判斷。
 * - dsh 跳過子代理的會話；我們在 `sessions.join` 只接 root 那一份。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **git 用 `node:child_process` 跑**，不是 dsh 的 `subprocess` 能力：我們沒有這個服務。能力層附帶的環境淨化、
 *    逾時、輸出上限、找執行檔明著抄過來，見 `git.ts` 檔頭。
 * 2. **事件不帶 `turn`**，時序因此另有要求；接上時重播的舊輪不拍快照。見 `recorder.ts` 檔頭。
 * 3. **擷取的工具換成我們基座的那三個**，見 `capture.ts` 的 `mutationPath`。`delete` 是 dsh 沒有的工具。
 * 4. **掛點**：dsh 的 `tools/pre-execute`、`agent/turn-stopping` 與 `session/event`，在我們這裡是 middleware 的
 *    `wrapToolCall`、`afterAgent` 與 `sessions.join` 的 `observe`。`afterAgent` 是圖裡的一個節點，每一輪多走一步
 *    （root 與子代理都是，子代理那一步直接返回）；選它是因為它在輪內、在 pump 寫 `turn/end` 之前，而且只在
 *    正常收尾時才跑——停在核准點、中止、失敗都不會走到，那幾種由 `turn/end` 之後的補記收。
 * 5. **子代理改的檔算進 root 這一輪**。dsh 不記子代理的會話（`eligible`），這一點照做：事件與摘要只在 root。
 *    dsh 的主路徑是 git 快照，子代理在這一輪裡改的檔本來就會出現在 root 的摘要裡；只有快照蓋不到的路徑、
 *    與「沒有 git」那條模式漏掉它們。所以子代理的檔案工具呼叫也在本體前擷取，記在 root 的記錄器上——
 *    結果在每一條路上都與 dsh 主路徑一樣。
 * 6. **Config 值的載體**：dsh 是 schemastery Config；我們的設定機制是 [#46](https://github.com/DemianLi/nexus-agent/issues/46)，
 *    在那之前預設值寫在 {@link WORKSPACE_CHANGES_LIMITS} 一處，工廠照 dsh 在建立時驗。
 *
 * @module
 */

import { tmpdir } from 'node:os';

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

import type { NexusPlugin, PluginRegistry, SessionLog } from '@nexus/core';
import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@nexus/wire';

import { GitRunner, resolveGitExecutable } from './git.js';
import { TurnRecorder } from './recorder.js';

export { mutationPath } from './capture.js';
export { GitRunner, resolveGitExecutable, scrubbedParentEnv } from './git.js';
export { TurnRecorder } from './recorder.js';
export type { RecorderEnvironment } from './recorder.js';

/** middleware 的名字。 */
export const WORKSPACE_CHANGES_MIDDLEWARE_NAME = 'WorkspaceChanges';

/** 上限，照 dsh 的 Config。 */
export interface WorkspaceChangesLimits {
  /** 一次 git 指令可以跑幾毫秒，超過就放棄這一輪的紀錄。 */
  readonly timeoutMs: number;
  /** 每次指令保留多少位元組的 git 輸出；比較清單更大時放棄這一輪的紀錄。 */
  readonly outputMaxBytes: number;
  /** 一份摘要最多帶幾個檔；`total` 照樣報完整的數目。 */
  readonly maxFiles: number;
  /**
   * 一份副本、以及比較時從快照讀的一個檔的位元組上限（含）。更大的檔沒有比較；檔案工具擷取的那種也列出來但
   * 沒有行數。
   */
  readonly maxFileBytes: number;
  /** 逐行比較可以跑幾毫秒，超過就退成整檔替換。 */
  readonly diffTimeoutMs: number;
}

/**
 * 上限的預設值，照 dsh `workspace-changes` 的 Config 預設（`src/index.ts:48-54`，`ddefc45`）。
 *
 * **寫在這裡是因為還沒有別的地方寫**：dsh 放在 plugin 設定，我們的設定機制是
 * [#46](https://github.com/DemianLi/nexus-agent/issues/46)，前例是 serve 的 `THREAD_TITLE_LIMITS`。
 */
export const WORKSPACE_CHANGES_LIMITS: WorkspaceChangesLimits = {
  timeoutMs: 30_000,
  outputMaxBytes: 8 * 1024 * 1024,
  maxFiles: 500,
  maxFileBytes: 2 * 1024 * 1024,
  diffTimeoutMs: 100,
};

/** 兩條路由讀的服務，對到 dsh 的 `ctx.workspaceChanges`。一次組裝一條 thread，所以不帶會話 id。 */
export interface WorkspaceChanges {
  /**
   * 一顆 `workspace/changes` 宣告的摘要。
   * @param seq - 那顆事件在 root 日誌裡的 `seq`。
   * @returns 摘要；會話已經收掉、或這個行程從沒記過時是 `undefined`。
   */
  summary(seq: number): WorkspaceChangesSummary | undefined;
  /**
   * 一個列出的檔在這一輪開始與結束時的比較。
   * @param seq - 那顆事件的 `seq`。
   * @param index - 它在摘要 `files` 裡的位置。
   * @param signal - 取消讀取。
   * @returns 比較；會話已經收掉、這個行程從沒記過、或沒有那個位置時是 `undefined`。
   * @throws 會話還活著時讀檔失敗。
   */
  diff(seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>;
}

/** 建一份要的東西。 */
export interface WorkspaceChangesOptions {
  /** 工作區根（`--workspace` 解析過的那個）。 */
  readonly root: string;
  /** 蓋掉預設上限的幾格。 */
  readonly limits?: Partial<WorkspaceChangesLimits>;
  /** 每份會話的暫存目錄建在哪裡，省略是 `os.tmpdir()`。 */
  readonly tempRoot?: string;
  /** 失敗往哪裡講，省略是 `console.warn`。 */
  readonly warn?: (message: string) => void;
  /** 「沒有 git」這類一次性的消息往哪裡講，省略是 `console.info`。 */
  readonly info?: (message: string) => void;
  /**
   * git 執行檔。省略是在 `PATH` 裡找（見 `git.ts` 的 `resolveGitExecutable`）；`null` 是當成沒有 git，
   * 行為同 dsh 在沒有 git 的 Host 上。
   */
  readonly git?: string | null;
}

/**
 * 建一份：plugin 與它的服務。**一份只掛一次組裝**——服務沒有會話 id，它答的是掛上的那一次組裝的 root。
 *
 * @param options - 工作區根與上限。
 * @returns plugin，與讀它記下的摘要的服務。
 * @throws 上限不是正的安全整數，同 dsh 在載入時驗。
 */
export function createWorkspaceChanges(options: WorkspaceChangesOptions): {
  readonly plugin: NexusPlugin;
  readonly service: WorkspaceChanges;
} {
  const limits = { ...WORKSPACE_CHANGES_LIMITS, ...options.limits };
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`workspace-changes requires a positive integer ${field}`);
    }
  }
  const info =
    options.info ??
    ((message: string) => {
      console.info(message);
    });
  /** 找 git 延到第一份記錄器要用時，一個實例找一次，同 dsh 的 `gitRunner`。 */
  let runner: Promise<GitRunner | null> | undefined;
  const git = (): Promise<GitRunner | null> => {
    runner ??= (
      options.git === undefined ? resolveGitExecutable() : Promise.resolve(options.git)
    ).then((executable) => {
      if (executable === null) {
        info('workspace-changes: 沒有 git，只列檔案工具的改動');
        return null;
      }
      return new GitRunner(executable, {
        timeoutMs: limits.timeoutMs,
        outputMaxBytes: limits.outputMaxBytes,
      });
    });
    return runner;
  };
  const env = {
    tempRoot: options.tempRoot ?? tmpdir(),
    maxFiles: limits.maxFiles,
    maxFileBytes: limits.maxFileBytes,
    diffTimeoutMs: limits.diffTimeoutMs,
    warn:
      options.warn ??
      ((message: string) => {
        console.warn(message);
      }),
  };
  /** root 那一份的記錄器；接上之前、收掉之後都沒有。 */
  let current: TurnRecorder | undefined;
  let applied = false;
  const plugin: NexusPlugin = {
    name: 'workspace-changes',
    apply(registry: PluginRegistry): void {
      if (applied) {
        throw new Error(
          'createWorkspaceChanges() 的一份只能掛一次組裝：服務答的是那一次組裝的 root',
        );
      }
      applied = true;
      const recorders = new Map<SessionLog, TurnRecorder>();
      /** 已經開始收、還沒刪完暫存目錄的那些；組裝收掉時要等它們。 */
      const disposing = new Set<Promise<void>>();
      registry.sessions.join((subject) => {
        // 照 dsh 的 `eligible`：子代理的會話不記。
        if (subject.address.kind !== 'root') return;
        const recorder = new TurnRecorder(subject.log, options.root, { ...env, git: git() });
        recorders.set(subject.log, recorder);
        current = recorder;
        // 接上當下已經在的事件（續接的 seed）會先重播一遍。**重播出來的輪不拍快照**：一份有 N 輪的 thread
        // 接上就會跑 N 次 `git add --all`，見 `recorder.ts` 檔頭第 3 點。其餘的照樣推動記錄器——副本只在這個
        // 行程裡產生，重播出來的舊輪一個副本都沒有，補記也列不出東西。
        const joinedAt = subject.log.length;
        subject.observe((event) => {
          const live = event.seq >= joinedAt;
          switch (event.type) {
            case 'turn/start':
              if (event.data.kind === 'resume') recorder.resume(live);
              else recorder.start(live);
              break;
            case 'interrupt/raised':
              recorder.pause();
              break;
            case 'tool/result':
              recorder.observe(event.seq);
              break;
            case 'turn/end':
            case 'turn/failed':
              recorder.end();
              break;
            default:
              break;
          }
        });
        return () => {
          recorders.delete(subject.log);
          if (current === recorder) current = undefined;
          // 會話的收尾是同步的；刪目錄是非同步的，交給組裝的收尾去等（見下面的 `onDispose`）。
          const done = recorder.dispose();
          disposing.add(done);
          void done.finally(() => disposing.delete(done));
        };
      });
      registry.lifecycle.onDispose(async () => {
        const all = [...recorders.values()];
        recorders.clear();
        current = undefined;
        await Promise.all([...all.map((recorder) => recorder.dispose()), ...disposing]);
      });
      registry.middleware.use(createWorkspaceChangesMiddleware(registry, recorders));
    },
  };
  const service: WorkspaceChanges = {
    summary: (seq) => current?.summary(seq),
    diff: (seq, index, signal) => current?.diff(seq, index, signal) ?? Promise.resolve(undefined),
  };
  return { plugin, service };
}

/**
 * 工具跑之前擷取、正常收尾時在輪內記錄。**同一份實例會走遍 root 與每個子代理**，所以從這一次呼叫的身分查
 * （`sessions.forCall`）：擷取認得出是這次組裝的呼叫就記到 root 的記錄器（見檔頭偏離 5），收尾只認 root。
 */
function createWorkspaceChangesMiddleware(
  registry: PluginRegistry,
  recorders: ReadonlyMap<SessionLog, TurnRecorder>,
): AgentMiddleware {
  // `recorders` 裡只有 root 那一份（`sessions.join` 只接 root），一次組裝一份。
  const root = (): TurnRecorder | undefined => recorders.values().next().value;
  const recorderFor = (configurable: unknown, scope: 'root' | 'any'): TurnRecorder | undefined => {
    // `forCall` 收的是 handler 的 config 形狀，所以包回一層 `configurable`，同 `@nexus/core` 的 `model-usage.ts`。
    const found = registry.sessions.forCall({ configurable });
    if (found.kind !== 'ok') return undefined;
    if (found.address.kind === 'root') return recorders.get(found.log);
    return scope === 'any' ? root() : undefined;
  };
  return createMiddleware({
    name: WORKSPACE_CHANGES_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      const recorder = recorderFor(
        (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
        'any',
      );
      if (recorder !== undefined) {
        recorder.capture(request.toolCall.name, request.toolCall.args);
        // 照 dsh：每一顆工具都等排著的工作，所以擷取不會被改檔搶先。
        await recorder.settled();
      }
      return handler(request);
    },
    afterAgent: async (_state, runtime) => {
      await recorderFor((runtime as { configurable?: unknown }).configurable, 'root')?.stopping();
      return undefined;
    },
  }) as unknown as AgentMiddleware;
}
