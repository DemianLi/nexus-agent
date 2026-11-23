/**
 * 每一輪改了工作區哪些檔（[#443](https://github.com/DemianLi/nexus-agent/issues/443)），照 dsh
 * `@deepseek-ai/dsh-workspace-changes`（`packages/deliverables/workspace-changes`，`ddefc45`）。
 *
 * 工作區在 git repo 裡時，輪開始與收尾各拍一次工作樹快照，兩棵樹比出這一輪改了什麼——連檔案工具以外的改動
 * （使用者自己改的、`submit_record` 寫的、MCP 工具在外面改的）都在（[#461](https://github.com/DemianLi/nexus-agent/issues/461)）。
 * 檔案工具（`write_file`、`edit_file`、`delete`、`copy_file`）改一個檔之前，另外把那個檔整份複製一份，每一輪每個路徑只複製
 * 第一次、收尾時再複製一次，快照蓋不到的路徑（被忽略的、repo 外的）用這兩份比；不在 repo 裡、或沒有 git 時，
 * 只有這兩份。有改的話，root 日誌寫一顆 `workspace/changes`，摘要與逐檔比較留在記錄器裡，經
 * {@link WorkspaceChanges} 服務到會話結束。模型看不到任何東西：這一條只寫日誌，web 讀。
 *
 * `copy_file` 成功時，`tool/result` 的 `meta` 帶來源、位元組數與 sha256，列出目的地時一起帶上（`copiedFrom`，#2289）。
 * 子代理的 `copy_file` 寫在子代理自己的日誌，從那裡讀，同樣帶上（#2311）。
 *
 * ## 掛法：出貨清單的 serve 專屬層，一列；不合格由工作區根缺席表達
 *
 * - dsh 由 web-app bundle 出廠掛（`packages/bundle/web-app/cordis.patch.yml:300`），終端機那側不掛；我們同樣
 *   只在 serve 掛，做法是 `apps/harness/cordis.serve.yml`（疊在 `cordis.yml` 之上的 serve 專屬出貨層，
 *   [#669](https://github.com/DemianLi/nexus-agent/issues/669)），CLI 不載那一層，沒有人讀摘要。
 * - dsh 的 `eligible` 看會話 header 的 `cwd`，沒有就不記（`src/index.ts:58-61`）；我們的「沒有工作區」＝沒給 `--workspace`，
 *   組裝點只在有根的時候經 host 服務交 {@link WORKSPACE_ROOT_SERVICE}。**這一列在 `apply` 當下讀它，沒有就什麼都不註冊**
 *   （不提供 {@link WORKSPACE_CHANGES_SERVICE}、不掛監聽者、不接會話），消費者據此當作沒有改動紀錄。
 * - dsh 跳過子代理的會話；我們在 `sessions.join` 只替 root 那一份建記錄器，子代理那一份只讀它的 `copy_file`（見偏離 5：子代理改的檔算進 root 這一輪）。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **git 由組裝點注入的 {@link GIT_STARTER_SERVICE} 起**。環境淨化、逾時、輸出上限、找執行檔見 `git.ts` 檔頭。
 * 2. **事件不帶 `turn`**，時序因此另有要求；接上時重播的舊輪不拍快照。見 `recorder.ts` 檔頭。
 * 3. **擷取的工具換成我們基座的那三個**，見 `capture.ts` 的 `mutationPath`。`delete` 是 dsh 沒有的工具。
 * 4. **擷取的位置**：擷取在 `tools/execute`（核准之後、本體之前），路徑由參數算（`capture.ts` 的 {@link mutationPath}）；
 *    `tools/pre-execute` 只等排著的工作；正常收尾聽 `agent/turn-stopping`；會話事件走 `sessions.join` 的 `observe`。
 * 5. **子代理改的檔算進 root 這一輪**。dsh 不記子代理的會話（`eligible`），這一點照做：事件與摘要只在 root。
 *    dsh 的主路徑是 git 快照，子代理在這一輪裡改的檔本來就會出現在 root 的摘要裡；只有快照蓋不到的路徑、
 *    與「沒有 git」那條模式漏掉它們。所以子代理的檔案工具呼叫也在本體前擷取，記在 root 的記錄器上——
 *    結果在每一條路上都與 dsh 主路徑一樣。
 * 6. **Config 多兩格資料**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）。dsh 的 `Config` 只有五個
 *    上限（`src/index.ts:50-56`，`ddefc45`），我們逐格照抄，另外多了 `tempRoot`、`git` 兩格：
 *    - `tempRoot`：dsh 寫死 `tmpdir()`（`src/index.ts:134`）。
 *    - `git`：dsh 經 `subprocess` 能力找執行檔（`src/index.ts:74`），我們沒有那個服務（偏離 1），所以「用哪一個
 *      執行檔／當成沒有 git」攤成資料。
 *
 *    **根不在 Config 裡了**（[#669](https://github.com/DemianLi/nexus-agent/issues/669)）：原本 `root` 是第三格，理由是
 *    dsh 每一份會話各自從 header 的 `cwd` 拿根而我們表達不出來，退到「根是資料」。現在根改走 {@link WORKSPACE_ROOT_SERVICE}
 *    由組裝點交——仍不是 dsh 的「會話 header」，但讓這一列進得了出貨清單（Config 裡不再有組裝點才知道的值）。
 *    **一次組裝只有一個根**這一點不變：dsh 那顆 plugin 服務整台 Host，我們的 `createCliAgent` 每條 thread 各跑一次。
 * 7. **`warn`／`info` 退成預設回呼**。dsh 講話走 `ctx.logger`（`src/index.ts:123`、`:136`）；我們的
 *    {@link PluginRegistry} 十五個註冊點沒有說話管道。**退的是載體不是紀律**：「沒有 git 只講一次 `info`、
 *    每一次失敗 `warn`」照抄，只有承載它的東西換成 `console.*`。它們是函式不是資料，所以**不進 Config**，
 *    走 {@link createWorkspaceChanges} 的縫，同 `@nexus/plugin-goal` 的 `now`／`newGoalId`。
 *
 * @module
 */

import { tmpdir } from 'node:os';

import { z } from 'zod';

import { isLogicalTurnStart, WORKSPACE_ROOT_SERVICE } from '@nexus/core';
import type {
  NexusPlugin,
  PluginEntry,
  PluginRegistry,
  PipelineExecution,
  SessionLog,
} from '@nexus/core';
import type { WorkspaceChangesSummary, WorkspaceFileDiff } from './types.js';

import { copyMetaOf, mutationPath } from './capture.js';
import { GIT_STARTER_SERVICE, GitRunner, resolveGitExecutable } from './git.js';
import { TurnRecorder } from './recorder.js';

export { copyMetaOf, mutationPath } from './capture.js';
export type { CopyMeta } from './capture.js';
export { directGitStarter, GIT_STARTER_SERVICE, GitRunner, resolveGitExecutable } from './git.js';
export type { GitOutcome, GitProcess, GitStart, GitStarter, GitStartFailure } from './git.js';
export { TurnRecorder } from './recorder.js';
export type { RecorderEnvironment } from './recorder.js';

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
 * 設定，**全是資料**：五個上限逐格照 dsh 的 `Config`，另外兩格見檔頭偏離 6。
 *
 * 上限的合法性**不在這裡驗**，在 {@link workspaceChangesPlugin} 的 `apply` 裡驗，照 dsh
 * （`src/index.ts:95-100`，`ddefc45`）——訊息原文照抄，而 schema 驗的話那句話就換了出處。
 *
 * **有一種攔不住：`NaN`**。zod 4 的 `z.number()` 自己就不收它，所以那一種在 `apply` 之前就被
 * 載體擋下、訊息是 schema 的。dsh 的載體（schemastery）收 NaN，所以那句話在它那邊管得到四種。
 * 載入一樣失敗，差的只有訊息出處；絆索見 `index.test.ts` 上限那一條。
 */
export const workspaceChangesConfigSchema = z.strictObject({
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
  // **不合格＝沒有工作區根**（照 dsh 的 `eligible`，見檔頭「掛法」）：上限先驗（設定寫壞不因為這一次用不到就放過），
  // 然後沒有根就什麼都不註冊。
  const root = registry.services.get(WORKSPACE_ROOT_SERVICE);
  if (root === undefined) return;
  const info =
    seams.info ??
    ((message: string) => {
      console.info(message);
    });
  /** 找 git 延到第一份記錄器要用時，一個實例找一次，同 dsh 的 `gitRunner`。 */
  let runner: Promise<GitRunner | null> | undefined;
  const git = (): Promise<GitRunner | null> => {
    const start = registry.services.get(GIT_STARTER_SERVICE);
    runner ??= (
      config.git === undefined ? resolveGitExecutable() : Promise.resolve(config.git)
    ).then((executable) => {
      if (executable === null || start === undefined) {
        info('workspace-changes: 沒有 git，只列檔案工具的改動');
        return null;
      }
      return new GitRunner(
        executable,
        { timeoutMs: config.timeoutMs, outputMaxBytes: config.outputMaxBytes },
        start,
      );
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
    // 子代理的會話不建記錄器、不寫事件。只把它成功的 `copy_file` 記到 root 這一輪（偏離 5），不推動 root 的輪：
    // 它的 `seq` 屬於子代理自己的日誌。接上時重播的舊事件不收：子代理的日誌沒有 root 的輪界，重播出來的舊複製會被記進
    // root 正在跑的這一輪。
    if (subject.address.kind !== 'root') {
      const joinedAt = subject.log.length;
      subject.observe((event) => {
        if (event.type !== 'tool/result' || event.seq < joinedAt) return;
        const copy = copyMetaOf(event.data.meta);
        if (copy === undefined) return;
        current?.copied(copy.destination, {
          source: copy.source,
          bytes: copy.bytes,
          sha256: copy.sha256,
        });
      });
      return;
    }
    const recorder = new TurnRecorder(subject.log, root, { ...env, git: git() });
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
          if (isLogicalTurnStart(event)) recorder.start(live);
          else recorder.resume(live);
          break;
        case 'interrupt/raised':
          recorder.pause();
          break;
        case 'tool/result': {
          recorder.observe(event.seq);
          const copy = copyMetaOf(event.data.meta);
          if (copy !== undefined) {
            recorder.copied(copy.destination, {
              source: copy.source,
              bytes: copy.bytes,
              sha256: copy.sha256,
            });
          }
          break;
        }
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
  listenWorkspaceChanges(registry, recorders);
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
 * 掛三位監聽者：工具跑之前等排著的工作、本體跑之前擷取、這一輪要停時在輪內記錄。插件匯流排上的呼叫都屬於這次組裝，
 * 所以認得出呼叫者（root 或子代理）就記到 root 的記錄器（見檔頭偏離 5）。`recorders` 裡只有 root 那一份
 * （`sessions.join` 只接 root），一次組裝一份。`agent/turn-stopping` 只對 root 派，收尾那一位因此不看呼叫者。
 */
function listenWorkspaceChanges(
  registry: PluginRegistry,
  recorders: ReadonlyMap<SessionLog, TurnRecorder>,
): void {
  const root = (): TurnRecorder | undefined => recorders.values().next().value;
  const recorderFor = (exec: PipelineExecution): TurnRecorder | undefined =>
    exec.agent === undefined ? undefined : root();
  // 每一顆工具都先等排著的工作，不只檔案工具：shell 這類工具也會改檔，不能搶在還沒落定的擷取前面。
  registry.events.on('tools/pre-execute', async (exec, next) => {
    await recorderFor(exec)?.settled();
    return next();
  });
  // 擷取在核准之後、本體之前：被拒絕或被擋下的呼叫不擷取。`mutationPath` 算不出路徑的呼叫（不是檔案工具）不擷取、
  // 不 await，同步往內交。
  registry.events.on('tools/execute', (exec, next) => {
    const recorder = recorderFor(exec);
    if (recorder === undefined || mutationPath(exec.name, exec.args) === undefined) return next();
    recorder.capture(exec.name, exec.args as Parameters<TurnRecorder['capture']>[1]);
    return recorder.settled().then(next);
  });
  registry.events.on('agent/turn-stopping', () => root()?.stopping());
}

declare module '@nexus/core' {
  interface SessionEventMap {
    /**
     * 一輪改了工作區的檔，**摘要留在 server 上**，這一顆只是指標：摘要與逐檔比較由
     * `@nexus/plugin-workspace-changes` 保管，web 拿這一顆的 `seq` 去兩條路由要，會話結束就沒了。
     *
     * 照 dsh 的同名事件（`packages/deliverables/workspace-changes/src/types.ts`，`ddefc45`）。只寫在 root 那一份
     * （dsh 不記子代理的會話）。同一輪可能有不只一顆：後寫的取代先寫的。
     *
     * ## 對 dsh 的偏離：沒有 `turn`
     *
     * 同 `deliverables/presented`：這一筆屬於哪一輪由 `seq` 推，往前找最近一顆開邏輯輪的 `turn/start`（{@link isLogicalTurnStart}）
     * （[#443](https://github.com/DemianLi/nexus-agent/issues/443) 第二則決議）。**所以它一定落在它那一輪的
     * `turn/start` 之後、下一輪的之前**，記錄器為此在輪內記，見那個套件的 `recorder.ts`。
     *
     * 資料是空的，所以進遙測也沒有東西外洩——檔名與內容都不在日誌上。
     */
    'workspace/changes': Record<string, never>;
  }
}
