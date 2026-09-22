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
 * - dsh 的 `eligible` 看會話 header 的 `cwd`；我們的「沒有工作區」＝沒給 `--workspace`，而 Config 要的正是那個根。
 *   所以**不合格由缺席表達**：組裝點只在有根的時候把這個 plugin 放進清單，沒有執行期判斷。
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
 * 6. **Config 多三格資料**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）。dsh 的 `Config` 只有五個
 *    上限（`src/index.ts:50-56`，`ddefc45`），我們逐格照抄，另外多了 `root`、`tempRoot`、`git` 三格：
 *    - `root`：dsh 每一份會話各自從 header 的 `cwd` 拿根（`src/index.ts:58-61` 的 `eligible`），**一顆 plugin
 *      服務得了整台 Host 的每一份會話**；我們的根是 `--workspace` 解析出來的一個值。退到最接近的實作：
 *      根是資料，寫在 Config 裡。
 *
 *      **這一條的前提換過一次，結論沒換。** 原本寫的是「會話本身不帶它」——
 *      [#504](https://github.com/DemianLi/nexus-agent/issues/504) 之後不成立了：格式 13 起
 *      `StoredSessionHeader` 有 `workspaceRoot` 那一格。但那一格在**持久化那一側**，
 *      `SessionLog` 不帶 header（`session-store.ts` 的檔頭：header 不進 `SessionEventMap`），
 *      而 plugin 手上只有日誌——所以「每份會話各自從自己的 header 拿根」對一顆 plugin 而言
 *      仍然表達不出來。另一半也還在：dsh 那顆 plugin 服務整台 Host，我們的 `createCliAgent`
 *      **每條 thread 各跑一次**，一次組裝本來就只有一個根。
 *    - `tempRoot`：dsh 寫死 `tmpdir()`（`src/index.ts:134`）。
 *    - `git`：dsh 經 `subprocess` 能力找執行檔（`src/index.ts:74`），我們沒有那個服務（偏離 1），所以「用哪一個
 *      執行檔／當成沒有 git」攤成資料。
 * 7. **`warn`／`info` 退成預設回呼**。dsh 講話走 `ctx.logger`（`src/index.ts:123`、`:136`）；我們的
 *    {@link PluginRegistry} 十五個註冊點沒有說話管道。**退的是載體不是紀律**：「沒有 git 只講一次 `info`、
 *    每一次失敗 `warn`」照抄，只有承載它的東西換成 `console.*`。它們是函式不是資料，所以**不進 Config**，
 *    走 {@link createWorkspaceChanges} 的縫，同 `@nexus/plugin-goal` 的 `now`／`newGoalId`。
 *
 * @module
 */

import { tmpdir } from 'node:os';

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { z } from 'zod';

import type { NexusPlugin, PluginEntry, PluginRegistry, SessionLog } from '@nexus/core';
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
 * 上限的預設值，照 dsh `workspace-changes` 的 Config 預設（`src/index.ts:50-56`，`ddefc45`）。
 *
 * {@link workspaceChangesConfigSchema} 的 `.default()` 逐格讀這裡，所以預設值只有這一個出處。
 */
export const WORKSPACE_CHANGES_LIMITS: WorkspaceChangesLimits = {
  timeoutMs: 30_000,
  outputMaxBytes: 8 * 1024 * 1024,
  maxFiles: 500,
  maxFileBytes: 2 * 1024 * 1024,
  diffTimeoutMs: 100,
};

/**
 * 設定，**全是資料**：五個上限逐格照 dsh 的 `Config`，另外三格見檔頭偏離 6。
 *
 * 上限的合法性**不在這裡驗**，在 {@link workspaceChangesPlugin} 的 `apply` 裡驗，照 dsh
 * （`src/index.ts:95-100`，`ddefc45`）——訊息原文照抄，而 schema 驗的話那句話就換了出處。
 *
 * **有一種攔不住：`NaN`**。zod 4 的 `z.number()` 自己就不收它，所以那一種在 `apply` 之前就被
 * 載體擋下、訊息是 schema 的。dsh 的載體（schemastery）收 NaN，所以那句話在它那邊管得到四種。
 * 載入一樣失敗，差的只有訊息出處；絆索見 `index.test.ts` 上限那一條。
 */
export const workspaceChangesConfigSchema = z.strictObject({
  /** 工作區根（`--workspace` 解析過的那個）。見檔頭偏離 6。 */
  root: z.string(),
  timeoutMs: z.number().default(WORKSPACE_CHANGES_LIMITS.timeoutMs),
  outputMaxBytes: z.number().default(WORKSPACE_CHANGES_LIMITS.outputMaxBytes),
  maxFiles: z.number().default(WORKSPACE_CHANGES_LIMITS.maxFiles),
  maxFileBytes: z.number().default(WORKSPACE_CHANGES_LIMITS.maxFileBytes),
  diffTimeoutMs: z.number().default(WORKSPACE_CHANGES_LIMITS.diffTimeoutMs),
  /** 每份會話的暫存目錄建在哪裡，省略是 `os.tmpdir()`。 */
  tempRoot: z.string().optional(),
  /**
   * git 執行檔。省略是在 `PATH` 裡找（見 `git.ts` 的 `resolveGitExecutable`）；`null` 是當成沒有 git，
   * 行為同 dsh 在沒有 git 的 Host 上。
   */
  git: z.string().nullable().optional(),
});

/** 驗過的設定。 */
export type WorkspaceChangesConfig = z.infer<typeof workspaceChangesConfigSchema>;

/**
 * **這一次組裝**講話的地方。
 *
 * 不是部署協作者，是**測試縫**：生產路徑一次都沒有傳過它們（`apps/harness/src/cli.ts`），走的是
 * `console.*`。它們是函式，所以不進 Config——見檔頭偏離 7。
 */
export interface WorkspaceChangesSeams {
  /** 失敗往哪裡講，省略是 `console.warn`。 */
  readonly warn?: (message: string) => void;
  /** 「沒有 git」這類一次性的消息往哪裡講，省略是 `console.info`。 */
  readonly info?: (message: string) => void;
}

/** {@link createWorkspaceChanges} 收的東西：設定的輸入形狀，外加兩道縫。 */
export type WorkspaceChangesOptions = z.input<typeof workspaceChangesConfigSchema> &
  WorkspaceChangesSeams;

/** 服務名。`registry.services` 上這個字串就是改動紀錄的位址，同 dsh 的 `ctx.workspaceChanges`。 */
export const WORKSPACE_CHANGES_SERVICE = 'workspaceChanges';

/** 兩條路由讀的服務，對到 dsh 的 `ctx.workspaceChanges`。一次組裝一條 thread，所以不帶會話 id。 */
export interface WorkspaceChanges {
  /**
   * 一顆 `workspace/changes` 宣告的摘要。
   * @param seq - 那顆事件在 root 日誌裡的 `seq`。
   * @returns 摘要；會話已經收掉、或這次組裝從沒記過時是 `undefined`。
   */
  summary(seq: number): WorkspaceChangesSummary | undefined;
  /**
   * 一個列出的檔在這一輪開始與結束時的比較。
   * @param seq - 那顆事件的 `seq`。
   * @param index - 它在摘要 `files` 裡的位置。
   * @param signal - 取消讀取。
   * @returns 比較；會話已經收掉、這次組裝從沒記過、或沒有那個位置時是 `undefined`。
   * @throws 會話還活著時讀檔失敗。
   */
  diff(seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>;
}

declare module '@nexus/core' {
  interface NexusServices {
    /** 這次組裝記下的改動。見 {@link WORKSPACE_CHANGES_SERVICE}。 */
    workspaceChanges: WorkspaceChanges;
  }
}

/**
 * 一次掛載。**每一次組裝各跑一遍，狀態全在這個函式的閉包裡**——模組層級一格都沒有。
 *
 * 這一點是承重的：服務答的是**這一次組裝**的 root，而 `serve.ts` 每條 thread 各跑一次
 * `createCliAgent`（`:341`）。從前用一顆 `applied` 旗標擋「一份只能掛一次組裝」，是因為狀態住在
 * 工廠的閉包裡、沒有地方交出控制面；現在狀態住在這裡，而重複提供由
 * `registry.services.provide` 自己擋（重名拋錯，訊息指名前一個提供者）。
 *
 * @param registry - 這一次組裝的註冊點。
 * @param config - 驗過的設定。
 * @param seams - 兩道測試縫，生產路徑是空的。
 * @throws 上限不是正的安全整數，同 dsh 在載入時驗。
 */
function applyWorkspaceChanges(
  registry: PluginRegistry,
  config: WorkspaceChangesConfig,
  seams: WorkspaceChangesSeams,
): void {
  // 照 dsh `src/index.ts:95-100`：上限在 `apply` 當下驗，訊息原文照抄。
  for (const field of [
    'timeoutMs',
    'outputMaxBytes',
    'maxFiles',
    'maxFileBytes',
    'diffTimeoutMs',
  ] as const) {
    const value = config[field];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`workspace-changes requires a positive integer ${field}`);
    }
  }
  const info =
    seams.info ??
    ((message: string) => {
      console.info(message);
    });
  /** 找 git 延到第一份記錄器要用時，一個實例找一次，同 dsh 的 `gitRunner`。 */
  let runner: Promise<GitRunner | null> | undefined;
  const git = (): Promise<GitRunner | null> => {
    runner ??= (
      config.git === undefined ? resolveGitExecutable() : Promise.resolve(config.git)
    ).then((executable) => {
      if (executable === null) {
        info('workspace-changes: 沒有 git，只列檔案工具的改動');
        return null;
      }
      return new GitRunner(executable, {
        timeoutMs: config.timeoutMs,
        outputMaxBytes: config.outputMaxBytes,
      });
    });
    return runner;
  };
  const env = {
    tempRoot: config.tempRoot ?? tmpdir(),
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
    diffTimeoutMs: config.diffTimeoutMs,
    warn:
      seams.warn ??
      ((message: string) => {
        console.warn(message);
      }),
  };
  /** root 那一份的記錄器；接上之前、收掉之後都沒有。 */
  let current: TurnRecorder | undefined;
  const recorders = new Map<SessionLog, TurnRecorder>();
  /** 已經開始收、還沒刪完暫存目錄的那些；組裝收掉時要等它們。 */
  const disposing = new Set<Promise<void>>();
  registry.sessions.join((subject) => {
    // 照 dsh 的 `eligible`：子代理的會話不記。
    if (subject.address.kind !== 'root') return;
    const recorder = new TurnRecorder(subject.log, config.root, { ...env, git: git() });
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
  // 照 dsh `src/index.ts:114-118`：控制面是一個服務。**晚綁**——`provide` 跑在 `apply` 當下，
  // 而記錄器要到 `sessions.join` 才出生，所以交出去的是讀 `current` 的兩顆方法，不是記錄器本身。
  registry.services.provide(WORKSPACE_CHANGES_SERVICE, {
    summary: (seq) => current?.summary(seq),
    diff: (seq, index, signal) => current?.diff(seq, index, signal) ?? Promise.resolve(undefined),
  } satisfies WorkspaceChanges);
  registry.middleware.use(createWorkspaceChangesMiddleware(registry, recorders));
}

/**
 * 改動紀錄的 plugin。
 *
 * **模組層級的一顆常數**，給 [#454](https://github.com/DemianLi/nexus-agent/issues/454) 從設定檔 import；
 * 設定全是資料（{@link workspaceChangesConfigSchema}），控制面走 {@link WORKSPACE_CHANGES_SERVICE} 交出去。
 */
export const workspaceChangesPlugin: NexusPlugin<WorkspaceChangesConfig> = {
  name: 'workspace-changes',
  Config: workspaceChangesConfigSchema,
  apply: (registry, config) => applyWorkspaceChanges(registry, config, {}),
};

export default workspaceChangesPlugin;

/**
 * 建一個條目。**薄薄一層**：沒有縫的時候回的就是 {@link workspaceChangesPlugin} 本人。
 *
 * 那個身分是承重的，不是省一顆物件：兩道縫幾乎只有測試在用，而生產路徑（`apps/harness/src/cli.ts`）
 * 一道都不傳。包一層新的 plugin 物件就會讓「測試量到的」與「出廠跑的」是兩顆不同的東西——
 * 相似品，不是交付物。絆索見 `index.test.ts` 的身分那一條。
 *
 * @param options - 設定，形狀見 {@link workspaceChangesConfigSchema}；外加 {@link WorkspaceChangesSeams} 兩道縫。
 * @returns 可以放進組裝點清單的條目。
 */
export function createWorkspaceChanges(options: WorkspaceChangesOptions): PluginEntry {
  const { warn, info, ...config } = options;
  if (warn === undefined && info === undefined) return { plugin: workspaceChangesPlugin, config };
  const seams: WorkspaceChangesSeams = {
    ...(warn === undefined ? {} : { warn }),
    ...(info === undefined ? {} : { info }),
  };
  return {
    plugin: {
      name: 'workspace-changes',
      Config: workspaceChangesConfigSchema,
      apply: (registry, resolved) => applyWorkspaceChanges(registry, resolved, seams),
    } satisfies NexusPlugin<WorkspaceChangesConfig>,
    config,
  };
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
