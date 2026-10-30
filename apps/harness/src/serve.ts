#!/usr/bin/env node
/**
 * 把 agent 掛上 HTTP，給 `apps/web` 連。
 *
 *   pnpm --filter @nexus/harness run serve             # 假模型
 *   pnpm --filter @nexus/harness run serve:live        # 換成真實供應商
 *
 * **組裝跟 CLI 共用同一份**（`assembly-root.ts` 的 `createCliAgent`）：同一份預設 plugin 清單、同一個
 * `--live` 開關、同一個 `--workspace`。理由是這裡沒有新的組裝決定要做——「web 要跑
 * 哪些 plugin」與「CLI 要跑哪些 plugin」是同一個問題，而它的答案住在同一份清單上：出貨的
 * `cordis.yml`，疊上 `$NEXUS_AGENT_HOME/cordis.patch.yml` 與 `--patch`
 * （[#454](https://github.com/DemianLi/nexus-agent/issues/454)、
 * [#455](https://github.com/DemianLi/nexus-agent/issues/455)）。
 *
 * **一個 thread 一個 agent，關掉 server 時一起清。** `createNexusAgent` 回的
 * `dispose` 在這裡才真的有意義——這是一個長命的行程，漏了不會有任何錯誤訊息。**MCP 的連線不在這裡面**：
 * 整台 serve 一份連線池，一份設定一個 stdio 子行程，所有 thread 共用，關掉 server 時才收（#1677）。啟動時另外先組一份、驗完就收（#749），清單上哪一列壞了
 * 在綁 port 之前就講，不等第一條 thread；那一次掉了的列，之後每條 thread 都直接算沒掛（#751）。
 *
 * 假模型下的限制與 CLI 的 REPL 一樣：`CLI_SCRIPT` 只有四輪，問到後面
 * `ScriptedChatModel` 會當場失敗而不是靜默重播。**那個失敗會以
 * `lifecycle failed` 上線**，所以瀏覽器那端看得到原因，不是一片空白。
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { THREADS_PATH } from '@nexus/wire';
import { approvalPolicyOnResume, errorChain, TokenAnchorBook } from '@nexus/core';
import { HARNESS_VERSION } from './harness-version.js';
import { singleDigitModelIds } from './model-catalog.js';
import type {
  PluginEntry,
  ResumedStoredSession,
  SessionEvent,
  SessionLog,
  SessionRegistry,
  SessionStore,
} from '@nexus/core';
import { AssemblyDropError } from './agent-factory.js';
import {
  assertPersistenceFlags,
  parseSandboxMode,
  formatGoalDriverDisclosure,
  goalDriverPort,
  serveGoalDriver,
  resolveInvariantLogPath,
  assertLaunchPathsOutsideWorkspace,
  assertPatchesOutsideWorkspace,
  resolveSessionLogDir,
  resolveWorkspaceRoot,
  SESSION_LOG_OFF_DISCLOSURE,
  describeDelegationNarrowing,
  describePermissionNarrowing,
} from './assembly-root.js';
import type { WorkspaceRootOf } from './assembly-root.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot, NexusAssembly } from './cordis-root.js';
import { createServerLog } from './server-log.js';
import { createSkillCatalog } from './skill-catalog-wire.js';
import type { ServerLog } from './server-log.js';
import { turnFailedFields, turnFailedMessage } from './turn-failed-log.js';
import { formatConversationRestore, restoreConversation } from './conversation-restore.js';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import { createColdChildStore } from './background-cold.js';
import {
  isListedThread,
  isSubagentSessionHeader,
  listStoredThreads,
  readStoredSubagentSession,
} from './session-list.js';
import { ThreadOrganization } from './thread-organization.js';
import {
  attachSessionPersistence,
  readColdSession,
  resumeClosingInterruptedTurn,
  SESSION_LOG_FORMAT_VERSION,
  sessionPersistencePlugin,
  SessionFormatUnsupportedError,
  SessionLogOffset,
  SessionNotFoundError,
} from '@nexus/core';
import type { StoredSessionHeader } from '@nexus/core';
import { assertSameCwd } from './resume-guards.js';
import { McpConnectionPool } from '@nexus/plugin-mcp';
import { recordedSandboxMode } from '@nexus/plugin-sandbox-policy';
import { installLaunchProxy } from './http-proxy-boot.js';
import { createCredentialService } from './credentials.js';
import { processLaunchEnv } from './launch-env.js';
import { DEFAULT_LIVE_MODEL_ID, loadLiveLaunchEnv } from './live-model.js';
import type { LiveLaunch } from './live-model.js';
import type { PumpAgent } from './thread-pump.js';
import type { SandboxMode } from './contained-backend.js';
import { BrowserAuth } from './browser-auth.js';
import { loadOrCreateBrowserSessionSecret } from './browser-session-secret.js';
import {
  createSessionHeaderMetadataResolver,
  hmacHashOf,
  loadConfigHashKey,
} from './session-header-metadata.js';
import { installFailLoud } from './fail-loud.js';
import type { FailLoudProcess } from './fail-loud.js';
import { forkAncestors, inheritedStashNames } from './fork-stash.js';
import { createProcessShutdown } from './process-shutdown.js';
import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import {
  assertThreadRootsBaseSeparate,
  verifyThreadRootsBase,
  createFixedThreadPlacer,
  createThreadPlacer,
  resolveThreadRootsBase,
  SHARED_WORKSPACE_PREFIX,
} from './thread-roots.js';
import { HARNESS_HOME_ENV, resolveHarnessHome } from './harness-home.js';
import { acquireHomeLock } from './home-lock.js';
import type { TryLock } from './kernel-file-lock.js';
import { createInvariantLog } from './invariant-log.js';
import { createWebStaticHandler } from './web-static.js';
import { createWireHandler, SubagentSessionError } from './wire-handler.js';
import type { ThreadForkSeed, WireHandler } from './wire-handler.js';
import { parseCompressionFlags, startWireServer } from './wire-server.js';
import type { WireCompression, WireServer } from './wire-server.js';
import { runDumpConfigSchema } from './config-schema-dump.js';
import {
  composeDefaultEntries,
  describePrepareJournal,
  loadDefaultPlugins,
  prepareJournal,
  renderLayeredConfigDump,
  renderShippedConfigDump,
} from './plugin-config.js';
import {
  assemblyDropsOf,
  auditStartupEntries,
  describeDrop,
  describeWarnings,
  dropReasonsOf,
  optionalEntriesOf,
  StartupError,
  startupErrorFrom,
  startupWarning,
} from './startup-audit.js';
import { hostActor } from './plugin-change.js';
import { createFailureRecorder, failedRowsOf } from './plugin-failure-recorder.js';
import { PLUGIN_JOURNAL_FILE_NAME } from './plugin-journal.js';
import { browserSessionPlugin } from './settings/browser-session.js';
import { deliverableFilesPlugin } from './settings/deliverable-files.js';
import { createRequestGate } from './request-gate.js';
import { formatRipgrepDisclosure, ripgrepStatus } from './rg-path.js';
import { productSandboxStatus, reportSandboxTo } from './tool-launcher.js';
import { liveModelPlugin } from './settings/live-model.js';
import { startupEntryMounted, startupSetting } from './settings/startup.js';
import { STARTUP_READ_PLUGINS } from './plugin-row-classes.js';
import {
  createPluginSnapshotWriter,
  describeSnapshot,
  pluginSnapshotPath,
} from './plugin-snapshot.js';
import { createThreadPluginList } from './thread-plugin-list.js';
import { backgroundSubagentsPlugin } from './settings/background-subagents.js';
import { subagentModelSelectionPlugin } from './settings/subagent-model-selection.js';
import { assertAllowedModelsInCatalog, modelSelectionPolicyFor } from './model-selection-policy.js';
import { spillPolicyPlugin } from './settings/spill-policy.js';
import { resolveToolResultStashRoot, toolResultStashPlugin } from './settings/tool-result-stash.js';
import { toolTextPlugin } from './settings/tool-text.js';
import { launchToolResultStashSweep } from './tool-result-stash-sweep.js';
import { projectionFlushPlugin } from './settings/projection-flush.js';
import { threadTitlePlugin } from './settings/thread-title.js';
import { threadTitleLlmPlugin } from './settings/thread-title-llm.js';
import { downlinkPlugin } from './settings/downlink.js';
import { startMemoryGauge } from './memory-gauge.js';
import { loadOrCreateMetricsToken, METRICS_TOKEN_FILE } from './metrics-token.js';
import { createOpsEndpoints, isOpsPath, OpsMetrics, surfaceOf } from './ops-endpoints.js';
import type { OpsEndpoints } from './ops-endpoints.js';
import type { MemoryGaugeDeps } from './memory-gauge.js';
import {
  createMemoryPressureWatch,
  heapUsageSource,
  memoryUsageSource,
} from './memory-pressure.js';
import { memoryGaugePlugin } from './settings/memory-gauge.js';
import { opsEndpointsPlugin } from './settings/ops-endpoints.js';
import { loggerConsolePlugin } from './settings/logger-console.js';
import { attachmentImagesPlugin } from './settings/attachment-images.js';
import { threadCapacityPlugin } from './settings/thread-capacity.js';
import { GOAL_ROUND_CAP_SOURCE, goalRoundCapPlugin } from './settings/goal-round-cap.js';
import type { GoalRoundCap } from './goal-driver.js';
import { turnTimeoutPlugin } from './settings/turn-timeout.js';
import type { TurnClock } from './turn-clock.js';
import { sessionReferencePlugin } from './settings/session-reference.js';
import { threadSearchPlugin } from './settings/thread-search.js';
import { SessionReferenceCandidates } from './session-reference-candidates.js';
import { ThreadSearch } from './thread-search.js';
import { formatTelemetryDisclosure } from './telemetry-disclosure.js';
import { sessionLogBudgetFromSetting } from './session-log-budget.js';
import type { SessionLogBudget } from './session-log-budget.js';
import { formatTracingDisclosure, readTracingDisclosure } from './tracing.js';

/** 預設 port。挑一個不常撞的，`--port` 蓋得掉。 */
export const DEFAULT_PORT = 8787;

export interface ServeInvocation {
  readonly live: boolean;
  readonly port: number;
  /** gzip 壓縮（#1570）：只在 `--compression gzip` 時有值；省略就是不壓，跟以前完全一樣。 */
  readonly compression?: WireCompression;
  readonly workspace?: string;
  /** 見 `assembly-root.ts` 的 `CliInvocation.sandbox`。**兩個入口共用同一個旗標名、同一份驗證、同一個預設**。 */
  readonly sandbox?: SandboxMode;
  /** 見 `assembly-root.ts` 的 `CliInvocation.patches`。**兩個入口共用同一個旗標名、同一份驗證、同一份疊加。** */
  readonly patches?: readonly string[];
  /** 見 `assembly-root.ts` 的 `CliInvocation.sessionLog`：換位置用，省略即 harness home 底下的 `sessions`。 */
  readonly sessionLog?: string;
  /** 見 `assembly-root.ts` 的 `CliInvocation.goalDriver`。**兩個入口共用同一個旗標名；預設不同**：serve 開、CLI 關（#445）。 */
  readonly goalDriver: boolean;
  /** 見 `assembly-root.ts` 的 `CliInvocation.dumpConfig`。**兩個入口印的是同一份設定**。 */
  readonly dumpConfig: boolean;
  /** 見 `assembly-root.ts` 的 `CliInvocation.dumpConfigSchema`。**兩個入口印的是同一份規格表**。 */
  readonly dumpConfigSchema: boolean;
  /** 見 `assembly-root.ts` 的 `CliInvocation.dumpDefaultConfig`。**兩個入口印的是同一份出貨設定**。 */
  readonly dumpDefaultConfig: boolean;
  readonly help: boolean;
  /** 只印版本就退出（#1502）。 */
  readonly version: boolean;
}

const USAGE = `用法：
  pnpm --filter @nexus/harness run serve [選項]

選項：
  --live               換成真實供應商（預設 ${DEFAULT_LIVE_MODEL_ID}），需要 API key
  --patch <file>       把這個 patch 檔疊在出貨的 cordis.yml 上（可以給多次，後面的蓋前面的）
                       另一層是變更紀錄 $NEXUS_AGENT_HOME/plugin-journal.jsonl（用 plugin 寫入口改），它排在 --patch 之前
  --dump-config        把三層疊完的 plugin 設定印出來就退出（不開 server、不載 plugin）
  --dump-config-schema 把疊完的 plugin 設定欄位規格表（JSON Schema 2020-12）印出來就退出（不開 server）
                       標準輸出只有那份 JSON，診斷走標準錯誤；有任何一列轉不完整（或載不起來）退出碼是 1
                       停用的列也收。不能配 --dump-config
  --dump-default-config
                       只印出貨那一層的設定就退出（不開 server）：不讀 $NEXUS_AGENT_HOME 的變更紀錄，也不收 --patch
                       覆寫檔壞了連 --dump-config 都印不出來時，用它拿一份對照
                       不能配 --dump-config、--dump-config-schema 或 --patch
  --workspace <dir>    把檔案落在這個目錄底下（省略即虛擬檔案系統）
  --sandbox <mode>     圍堵強度：read-only｜workspace-write｜danger-full-access
                       預設 workspace-write（可寫根之內放行）；要配 --workspace
                       danger-full-access 出廠的權限表沒有，要先在表裡加回那一組，否則起不來
  --session-log <dir>  把會話日誌改寫到這個目錄
                       （預設 $NEXUS_AGENT_HOME/sessions，沒設就是 ~/.nexus-agent/sessions）
                       要完全不落盤，在 patch 裡把 session-persistence 那一列寫成 disabled: true
  --port <n>           監聽的 port，預設 ${DEFAULT_PORT}
  --compression <mode> none｜gzip，預設 none（不壓，跟以前一樣）。gzip：網頁 bundle、CSS 與 JSON 回應在瀏覽器支援時壓縮再送；
                       SSE 下行與帶 content-range 的回應照原樣送
  --compression-level <0-9>
                       gzip 等級，預設 1
  --compression-threshold <bytes>
                       已知長度小於這個位元組數就不壓，預設 1024；
                       目前只對自帶 content-length 的回應有效
  --no-goal-driver     關掉自動續行：一個 active 的目標沒達成時，預設會自己再開一輪
                       （上限是那個目標自己的 max_goal_rounds）；關掉之後一輪結束就結束
  --goal-driver        明講要開（預設就是開；與 --no-goal-driver 不能一起給）
  --help               印這段話
  --version            印這個 harness 的版本就退出

環境變數：
  ${HARNESS_HOME_ENV}  瀏覽器會話密鑰所在的 harness home（預設 ~/.nexus-agent）

啟動時印出的網址帶著這次行程的登入 token：只給自己用，別轉存到別人讀得到的檔。
網頁要先 build（pnpm build）。按 Ctrl-C 結束——收線時會把每個 thread 的 agent 一起清掉。`;

export function parseServeArgs(argv: readonly string[]): ServeInvocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        live: { type: 'boolean', default: false },
        patch: { type: 'string', multiple: true },
        workspace: { type: 'string' },
        sandbox: { type: 'string' },
        'session-log': { type: 'string' },
        port: { type: 'string' },
        compression: { type: 'string' },
        'compression-level': { type: 'string' },
        'compression-threshold': { type: 'string' },
        'goal-driver': { type: 'boolean', default: false },
        'no-goal-driver': { type: 'boolean', default: false },
        'dump-config': { type: 'boolean', default: false },
        'dump-config-schema': { type: 'boolean', default: false },
        'dump-default-config': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }

  const { values } = parsed;
  if (values.workspace !== undefined && values.workspace.trim() === '') {
    throw new Error(`--workspace 要給一個目錄路徑。\n\n${USAGE}`);
  }
  const patches = values.patch;
  if (patches !== undefined) {
    if (patches.some((patch) => patch.trim() === '')) {
      throw new Error(`--patch 要給一個檔案路徑。\n\n${USAGE}`);
    }
  }
  if (values['session-log'] !== undefined && values['session-log'].trim() === '') {
    throw new Error(`--session-log 要給一個目錄路徑。\n\n${USAGE}`);
  }

  const sandbox = parseSandboxMode(values.sandbox, values.workspace, USAGE);

  if (values['goal-driver'] === true && values['no-goal-driver'] === true) {
    throw new Error(
      `--goal-driver 與 --no-goal-driver 不能一起給：一個要開、一個要關。\n\n${USAGE}`,
    );
  }

  const dumpConfig = values['dump-config'] === true;
  const dumpConfigSchema = values['dump-config-schema'] === true;
  if (dumpConfigSchema && dumpConfig) {
    throw new Error(`--dump-config-schema 不能配 --dump-config：一次只印一種。\n\n${USAGE}`);
  }

  // 見 `cli.ts` 的同一段：三種印法互斥，只印出貨那一層時 `--patch` 沒有意思。
  const dumpDefaultConfig = values['dump-default-config'] === true;
  if (dumpDefaultConfig) {
    if (dumpConfig) {
      throw new Error(`--dump-default-config 不能配 --dump-config：一次只印一種。\n\n${USAGE}`);
    }
    if (dumpConfigSchema) {
      throw new Error(
        `--dump-default-config 不能配 --dump-config-schema：一次只印一種。\n\n${USAGE}`,
      );
    }
    if (patches !== undefined) {
      throw new Error(
        `--dump-default-config 不能配 --patch：它只印出貨那一層，不讀任何覆寫檔。\n\n${USAGE}`,
      );
    }
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port 要給 0 到 65535 之間的整數，收到 "${values.port}"。\n\n${USAGE}`);
  }

  // 壓縮旗標的驗證（照 dsh 的 schema）；不合法是 usage error，在任何檔案寫入之前失敗。
  let compression: WireCompression | undefined;
  try {
    compression = parseCompressionFlags({
      compression: values.compression,
      level: values['compression-level'],
      threshold: values['compression-threshold'],
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }

  return {
    live: values.live === true,
    port,
    ...(compression !== undefined && { compression }),
    ...(patches !== undefined && { patches }),
    ...(values.workspace !== undefined && { workspace: values.workspace }),
    ...(sandbox !== undefined && { sandbox }),
    ...(values['session-log'] !== undefined && { sessionLog: values['session-log'] }),
    // **serve 預設開，CLI 預設關**（#445）：要核准的工具在 serve 上是停下來等人，CLI 的
    // `HEADLESS_APPROVALS` 則確定性拒絕、續行只會一再撞同一個拒絕空轉。`--goal-driver` 留著
    // 當成「明講要開」，與 CLI 共用同一個旗標名；`--no-goal-driver` 關掉。
    goalDriver: values['no-goal-driver'] !== true,
    dumpConfig,
    dumpConfigSchema,
    dumpDefaultConfig,
    help: values.help === true,
    version: values.version === true,
  };
}

export interface RunServeOptions {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly log?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * 網頁 `dist` 的目錄，只給測試用。產品路徑不設：照 dsh `web-app` 的 `resolveDistIndex`，
   * 位置由前端套件的 manifest 反查，不是設定（dsh 同樣有一個「production never mutates」的測試鉤子）。
   */
  readonly webDist?: string;
  /**
   * home 鎖拿鎖的那一下，只給測試用（#1503）：「這個平台拿不到」與 `EACCES` 兩條路在 macOS 與 CI 的 Linux 上走不到，
   * 不換就是沒驗過就出貨。產品路徑不設，用 dsh 的 `tryLockExclusive`。
   */
  readonly homeLock?: TryLock;
  /**
   * 記憶體量具讀外界的縫，只給測試用（#1493）：用量警告要「70% → 80% → 69%」這樣的讀數序列，不靠真的把記憶體吃到 75%。
   * 產品路徑不設，量具讀真的 `/proc`、`/sys/fs/cgroup` 與 `process`。
   */
  readonly memoryGaugeDeps?: MemoryGaugeDeps;
  /**
   * 「thread → 可寫根」（{@link WorkspaceRootOf}，#1774），只給測試用：A 回 X、B 回 Y，才量得出每一格都跟著 thread 走而不是行程級的同一個根。
   * 產品路徑不設，用 `thread-roots.ts` 的 `createThreadPlacer`（#1775：新 thread 配私有根，`--workspace` 唯讀共用）。給了這一支就換成
   * `createFixedThreadPlacer`：沒有私有根、沒有 `/shared`，續接守衛逐字比。**有沒有圍堵仍由 `--workspace` 決定**（行程級），這一支只回根的值。
   */
  readonly workspaceRootOf?: WorkspaceRootOf;
  /**
   * 會話日誌的位元組額度（#2115），只給測試用：換一本小的，才量得出「太大的拒收、小的照常」而不必造幾百 MiB 的日誌。
   * 產品路徑不設，照 `thread-capacity` 的 `sessionLogBudgetMiB` 開一本（不寫就自動算）。serve 自己的存放處與引用候選逐格開的都記在這一本。
   */
  readonly sessionLogBudget?: SessionLogBudget;
}

export interface RunningServe {
  readonly url: string;
  /**
   * 帶著這個行程登入 token 的網址——啟動時印的就是這一個（#424）。在瀏覽器開它，換到會話 cookie。
   */
  readonly authenticatedUrl: string;
  /**
   * 收尾。`drain: false` 跳過 `/readyz` 的時間窗（#1787）：致命例外的收尾只有 fail-loud 那 2 秒（`fail-loud.ts`），
   * 時間窗最多也是 2 秒，兩個加起來 dispose 會被 `exit(1)` 切掉（thread 收尾與落盤正是 #1501 要保住的）；
   * 而且那一段時間 serve 還在收新回合，跟「不讓壞掉的 serve 存活」衝突。預設（省略）照舊等時間窗，SIGTERM／SIGINT 走這條。
   */
  close(options?: { readonly drain?: boolean }): Promise<void>;
}

/**
 * 網頁 `dist` 的位置：照 dsh `packages/bundle/web-app/src/index.ts` 的 `resolveDistIndex`（`ddefc45`），
 * 從前端套件的 manifest 反查，不做成設定。**存不存在是請求當下的事**（`web-static.ts`）。
 */
function resolveWebDist(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@nexus/web/package.json')), 'dist');
}

/**
 * 按路徑把請求分給三個面（[#424](https://github.com/DemianLi/nexus-agent/issues/424)、[#1535](https://github.com/DemianLi/nexus-agent/issues/1535)）。
 *
 * `/livez`、`/readyz`、`/metrics` 給探針與指標（先過信任圍欄，見 `ops-endpoints.ts`）——**排在 `/threads` 的判斷之前**；
 * `/threads` 與它底下的路徑給 wire——圍欄、會話 cookie、JSON 閘門都在那裡；其他給網頁的靜態服務。
 * 換 token 的 `GET /?token=` 因此碰不到 wire 的 JSON 閘門（瀏覽器導覽不帶 `content-type`），照 dsh：
 * index 走 `frontend-static` 的 `authorizeIndex`，API 走 `requestRejection`。
 */
function routeBySurface(
  wire: WireHandler,
  web: (request: Request) => Promise<Response>,
  ops: OpsEndpoints,
): WireHandler {
  return {
    handle: (request) => {
      const { pathname } = new URL(request.url);
      if (isOpsPath(pathname)) return ops.handle(request);
      return pathname === THREADS_PATH || pathname.startsWith(`${THREADS_PATH}/`)
        ? wire.handle(request)
        : web(request);
    },
    close: () => wire.close(),
  };
}

/**
 * 這條 thread 以前在這個會話根寫過的話接回來；沒寫過回 `undefined`，由呼叫端開新的。
 *
 * **只有「找不到」准退到新開**（{@link SessionNotFoundError}）。壞檔（壞行之後還有收尾事件的那種；
 * 尾端沒收尾的壞行是當機的尾巴，續接時丟掉、不算壞檔，#1508）、版本太新、別的行程
 * 握著都照拋：退到新開的話 `create` 會撞上已存的檔——以前要等第一次寫才撞、在協調器的背景路徑上被收成一行 warn，
 * 那條 thread 的日誌就這樣沒了；#1559 之後 `create` 當下就拋，thread 建不起來，但拋的是「已經存在」而不是真正的原因。
 *
 * @param store - 這個專案的會話根。
 * @param threadId - 就是 root 會話的 id。
 * @returns 讀回來的那份，或沒寫過時的 `undefined`。
 */
async function resumeThread(
  store: SessionStore,
  threadId: string,
): Promise<ResumedStoredSession | undefined> {
  try {
    // 當掉那一輪的收尾在這裡寫回檔上（#721）；交回的 events 已含補結，`storedCount` 跟著算進去。
    return await resumeClosingInterruptedTurn(store, threadId);
  } catch (error: unknown) {
    if (error instanceof SessionNotFoundError) return undefined;
    throw error;
  }
}

/**
 * 起一台 server。
 *
 * @returns 它的位址與收掉它的方法；`--help` 時回 undefined（只印用法）。
 */
export async function runServe(options: RunServeOptions): Promise<RunningServe | undefined> {
  const log = options.log ?? ((line: string) => console.log(line));
  const invocation = parseServeArgs(options.argv);
  if (invocation.help) {
    log(USAGE);
    return undefined;
  }
  if (invocation.version) {
    log(HARNESS_VERSION);
    return undefined;
  }

  await assertPatchesOutsideWorkspace({
    workspace: invocation.workspace,
    cwd: options.cwd ?? process.cwd(),
    patches: invocation.patches,
  });

  // **在開 server 之前印完就走**，同 `cli.ts`：印設定不需要綁 port，也不該因為 port 被佔住
  // 就看不到設定。
  if (invocation.dumpConfigSchema) {
    // 同 `cli.ts`：標準輸出只放那份 JSON，診斷走標準錯誤；不完整時文件印完之後拋 `ConfigSchemaIncompleteError`。
    await runDumpConfigSchema(
      () =>
        composeDefaultEntries({
          serve: true,
          env: options.env ?? process.env,
          ...(invocation.patches !== undefined && { patches: invocation.patches }),
        }),
      {
        out: (text) => {
          log(text.trimEnd());
        },
        err: (text) => {
          process.stderr.write(`${text.trimEnd()}\n`);
        },
      },
    );
    return undefined;
  }
  // 只印出貨那一層（#740）：同 `cli.ts`，不讀 home 覆寫檔，所以覆寫檔壞了也印得出來。
  if (invocation.dumpDefaultConfig) {
    log(renderShippedConfigDump({ serve: true }).trimEnd());
    return undefined;
  }
  if (invocation.dumpConfig) {
    log(
      renderLayeredConfigDump({
        serve: true,
        env: options.env ?? process.env,
        ...(invocation.patches !== undefined && { patches: invocation.patches }),
      }).trimEnd(),
    );
    return undefined;
  }

  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  // **key 來源與 home 不能跟 `--workspace` 重疊**（#1620）：排在 home 鎖之前——拿鎖會先 `mkdir` home，排在後面的話被拒的
  // 那一次已經在工作區裡建出 `home/serve.lock`；也排在讀 `.env` 之前，工作區裡那一份不先載入就拒絕。印設定那幾個分支不寫 home，不受影響。
  await assertLaunchPathsOutsideWorkspace({ workspace: invocation.workspace, cwd, env });
  // **同一個 home 只能起一個 serve**（#1503）：排在印設定那幾個分支之後（它們不寫 home），其餘一切之前——
  // 讀 `.env`、裝代理、遷移變更紀錄、清暫存、寫快照、建密鑰、讀釘選檔，這些都碰 home。第二台在這裡就被拒，
  // 一個檔都沒寫。起不來的每一條路都放鎖，正常 `close()` 在最後一步放（下面）。
  // 平台拿不到 flock 時照常起來、講一聲（Q1 (a)，同會話寫租約）；`EACCES` 這類其餘的錯原樣往外拋。
  const homeLock = await acquireHomeLock(resolveHarnessHome(env), options.homeLock);
  // **Cordis 根由這裡持有**（#1401），照 dsh launcher 的 `app.current`；它的 logger 是伺服器日誌的出口（#1534），所以**在第一行日誌之前**就要在：
  // 樹的 context 是第一次叫才建（`plugin-tree.ts` 的 `context()`），這裡先叫。exporter 要讀完清單才知道設定，
  // 晚掛上時先回放緩衝，所以排在它前面的幾行（home 鎖、代理、變更紀錄遷移）一樣印得出來；起不來的路徑掛出廠設定（`mountDefault`）。
  // 預設答題管道由入口給（#1458 Q1 (c)）：serve 有人在（web 收得到問題），組裝時也不傳 `approvals`——同一個決定。
  // 「有沒有圍堵」也由入口給（#1491 Q4 (a)、#1774）：跟每條 thread 組裝時算的是同一支 `resolveWorkspaceRoot`、同一個 cwd，整台一份。可寫根不在這裡：逐條 thread。
  let root: CordisRoot | undefined;
  let serverLog: ServerLog | undefined;
  let started: RunningServe;
  try {
    // 行程級只留「有沒有圍堵」（#1774）：可寫根是逐條 thread 的，每條 thread 組裝時才依 thread 取。
    const contained = resolveWorkspaceRoot(invocation.workspace, cwd) !== undefined;
    root = createCordisRoot({
      channel: entryApprovalChannel(undefined),
      ...(contained && { contained }),
    });
    serverLog = createServerLog(await root.tree.context(), log);
    if ('unavailable' in homeLock) {
      serverLog.serve.warn(
        `[home 鎖] 這個平台拿不到 home 鎖，不擋第二個 serve：${homeLock.unavailable}`,
      );
    }
    started = await startUnderHomeLock(options, invocation, env, cwd, serverLog, root);
  } catch (error) {
    // 根在這裡收掉（`dispose` 冪等，`startUnderHomeLock` 自己收過也沒關係）；收之前先掛 exporter，收尾拋的錯才印得出來。
    serverLog?.mountDefault();
    await root?.dispose().catch(() => {});
    if (!('unavailable' in homeLock)) await homeLock.release().catch(() => undefined);
    throw error;
  }
  return {
    ...started,
    close: async (options) => {
      // 放鎖是 `close()` 的最後一步，排在 server、thread、日誌、根、代理都收完之後：鎖放掉之後，
      // 下一台才可以碰這些檔。收尾失敗也要放；兩邊都失敗時以收尾的為主（放鎖只是關一個 fd）。
      let closeFailure: { readonly error: unknown } | undefined;
      try {
        await started.close(options);
      } catch (error: unknown) {
        closeFailure = { error };
      }
      try {
        if (!('unavailable' in homeLock)) await homeLock.release();
      } catch (error: unknown) {
        closeFailure ??= { error };
      }
      if (closeFailure !== undefined) throw closeFailure.error;
    },
  };
}

/** {@link runServe} 在 home 鎖就位之後的其餘部分：啟動環境、代理、載清單、組裝、綁 port。 */
async function startUnderHomeLock(
  options: RunServeOptions,
  invocation: ServeInvocation,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  serverLog: ServerLog,
  root: CordisRoot,
): Promise<RunningServe> {
  // **真模型路徑的啟動環境：兩層 `.env`**（#730），排在讀清單與建密鑰之前：壞的 `.env` 與舊位置搬家訊息在
  // server 還沒起來的時候就講。沒帶 `--live` 不讀任何 `.env`。
  const liveLaunch = invocation.live ? loadLiveLaunchEnv({ cwd, env, store: true }) : undefined;
  // **對外代理：啟動流程的第一件事**（#746），排在載完環境之後、第一顆外掛載入之前。假模型路徑沒有 `.env`，
  // 用只有行程環境的那一層。server 起不來就當場還原；起來了，收尾跟著 `close()` 走。
  const disposeProxy = await installLaunchProxy(
    liveLaunch?.launchEnv ?? processLaunchEnv(),
    (message) => {
      serverLog.serve.warn(message);
    },
  );
  // **MCP 連線池整台一份**（#1677）：試組與每條 thread 都從它取，一份設定一份連線。起不來與關掉時都在這裡收，排在 server 自己的
  // 收尾（thread 都撤了）之後、卸載根之前（池最後那句「關閉確認不到」要印得出來）。
  const mcpPool = new McpConnectionPool({
    log: (message) => {
      serverLog.logger('mcp').warn(message);
    },
    // dsh 是 error 級的那幾句（關閉確認不到）：伺服器日誌有 error，照 dsh 接過去（`supervisor.ts` 檔頭偏離 6）。
    error: (message) => {
      serverLog.logger('mcp').error(message);
    },
  });
  // **根（上面 `runServe` 建的）起不來與關掉時都在這裡卸載**（#1401），排在 server 自己的收尾之後、還原代理之前。
  let running: RunningServe;
  try {
    running = await startServer(options, invocation, liveLaunch, serverLog, root, mcpPool);
  } catch (error) {
    serverLog.mountDefault();
    await mcpPool.close();
    await root.dispose().catch(() => {});
    await disposeProxy();
    throw error;
  }
  return {
    ...running,
    close: async (options) => {
      try {
        try {
          try {
            await running.close(options);
          } finally {
            await mcpPool.close();
          }
        } finally {
          await root.dispose();
        }
      } finally {
        await disposeProxy();
      }
    },
  };
}

/** {@link runServe} 在啟動環境與代理都就位之後的其餘部分：載清單、組裝、綁 port。 */
async function startServer(
  options: RunServeOptions,
  invocation: ServeInvocation,
  liveLaunch: LiveLaunch | undefined,
  serverLogOut: ServerLog,
  root: CordisRoot,
  mcpPool: McpConnectionPool,
): Promise<RunningServe> {
  // `goalDriver` 那個閉包的參數也叫 `log`（它是讀日誌的 getter），所以伺服器日誌的三支在這裡另取名字，不讓兩個 `log` 在同一段裡打架。
  // **每一行伺服器日誌都帶等級**（#1534）：`log` 是狀態披露（info），`warn` 是要人處理的，`fail` 是起不來與收不了的（error）。
  // 傳給別的函式當 `log`／`warn` 回呼時，照那個回呼講的是哪一種接哪一支。
  const log = (line: string): void => {
    serverLogOut.serve.info(line);
  };
  const warn = (line: string): void => {
    serverLogOut.serve.warn(line);
  };
  const fail = (line: string): void => {
    serverLogOut.serve.error(line);
  };
  const invariantLogger = serverLogOut.logger('invariant');
  const cwd = options.cwd ?? process.cwd();
  // **瀏覽器會話的密鑰也從這一份 env 解 home**（#424）：日誌根與密鑰落在同一個 home 底下。
  // 密鑰在下面讀：權限過寬、記錄壞掉，都該在 server 還沒起來的時候就講。每次啟動只讀這一次，
  // 之後在記憶體裡驗。
  const env = options.env ?? process.env;
  // **沒帶 `--live` 也建一份憑證服務**（#1989）：MCP 設定裡的憑證引用跟模型 key 同一條規則（受管檔 > 啟動環境），只是沒有 `.env`
  // 那兩層。受管檔不在這裡檢查，引用它的列連線時才讀：從沒讀成功過就壞了，只讓引用它的那幾列連不上；讀成功過之後再壞，照憑證服務的
  // 規則續用上一份並警告。
  const credentials =
    liveLaunch?.credentials ??
    createCredentialService({
      home: resolveHarnessHome(env),
      launchEnv: processLaunchEnv(),
      store: true,
    });
  // **清單只有一個來源：出貨的 `cordis.yml` 加上使用者那兩層**（#454、#455），與 CLI 同一條
  // 路：同一個函式、同一個 home 層、同一組 `--patch`。
  //
  // **它排在瀏覽器會話之前，那是承重的**（[#529](https://github.com/DemianLi/nexus-agent/issues/529)）：
  // cookie 的有效期由清單上 `#settings/browser-session` 那一列講，密鑰讀出來的那一刻就要有它。
  // **serve 多疊一層專屬的出貨清單**（`cordis.serve.yml`，#669 第 4 步）：每一輪改了哪些檔那一列只在這裡。
  //
  // **清單的第二層是變更紀錄，不是 `cordis.patch.yml`**（#1412）：讀清單之前先確保紀錄在、必要時把舊的 patch 檔遷進去。
  // 遷移那一步在鎖裡做，serve 與 CLI 同時第一次啟動只會遷一次（`plugin-config.ts` 的 `prepareJournal`）。
  const prepared = await prepareJournal({ env });
  const preparedLine = describePrepareJournal(prepared);
  if (preparedLine !== undefined) log(preparedLine);
  // **掛不上的列記進變更紀錄**（#1414）：紀錄裡有被接受的改動指到它才記，紀錄檔不在就什麼都不做；等鎖上限 2 秒、
  // 不擋 thread，只有「必掛的掉了、要拋之前」才等它寫完。規則與去重見 `plugin-failure-recorder.ts`。
  const failureRecorder = createFailureRecorder({
    path: join(resolveHarnessHome(env), PLUGIN_JOURNAL_FILE_NAME),
    effective: hostActor(env).effective,
    log,
    warn,
  });
  // **插件自己停用了自己也記一筆**（#1424）：Loader 自我停用那一格的呼叫點發的事件，由樹轉進來；只記不折，閃動由樹的記憶止住。
  root.tree.onSelfDisable = (event) => failureRecorder.noteSelfDisabled(event);
  const loaded = await loadDefaultPlugins(
    {
      serve: true,
      env,
      ...(invocation.patches !== undefined && { patches: invocation.patches }),
    },
    { tree: root.tree },
  );
  // **伺服器日誌的 exporter 在清單讀完的這一刻掛上**（#1534）：設定來自 `#settings/logger-console` 那一列，掛上時先回放緩衝，
  // 排在它前面的幾行（home 鎖、代理、變更紀錄遷移）與下面「必掛的掉了」那一段的話都印得出來。
  const plugins: readonly PluginEntry[] = loaded.plugins;
  serverLogOut.mount(startupSetting(plugins, loggerConsolePlugin));
  // **掉了哪幾列在這裡判第一次**（#751），同 CLI 那一刻：必掛的掉了就在這裡起不來——還沒建瀏覽器會話密鑰、還沒綁
  // port。可少掛的掉了先不印，等下面試組那一次補完再合成一段。掉了的列在清單上已標成沒掛，每條 thread 組裝時照樣跳過。
  const audit = { live: invocation.live };
  try {
    auditStartupEntries(loaded, audit);
  } catch (error) {
    // 必掛的掉了、起不來：先把那一筆記進紀錄再拋（#1414）。
    if (error instanceof StartupError) {
      // 啟動沒有「上一次」可比，不帶 newlyDropped（#1423：啟動試組不套新規則）。
      failureRecorder.note(failedRowsOf(error.dropped, undefined), 'startup');
      await failureRecorder.flush();
    }
    throw error;
  }
  failureRecorder.note(failedRowsOf(loaded.dropped, undefined), 'startup');
  const optionalEntries = optionalEntriesOf(loaded, audit);
  // **起動期解一次、往下傳一份**：這兩顆都有消費者跑在任何 agent 出生之前（冷讀清單、`BrowserAuth`），那時
  // 還沒有註冊表可以讀服務。標題那兩個數字也往下傳給寫標題的 pump（#647），同一份值。理由與偏離登記見
  // `settings/startup.ts` 的檔頭。
  const browserSession = startupSetting(plugins, browserSessionPlugin);
  const threadTitle = startupSetting(plugins, threadTitlePlugin);
  // 交付檔那三個上限（#529）。**它們是 server 的性質，不是一條 thread 的性質**——兩支交付方法
  // 住在 `createWireHandler` 的閉包裡，一個 server 一次，所以值在這裡解、往下傳一份。
  const deliverableLimits = startupSetting(plugins, deliverableFilesPlugin);
  // 落盤的批次窗口（#529）。**同樣是 server 的性質**：`sessionStore` 一台伺服器一份，而窗口
  // 講的是那一顆 store 的寫入節奏——下面每一條 thread 各自接上去的協調器都吃這同一個數字。
  const persistenceWindow = startupSetting(plugins, sessionPersistencePlugin);
  // **落盤掛不掛也由清單講**（#612，照 dsh 的 `session-persistence-jsonl` 那一列）。關掉的話
  // 下面一個 store 都不建、日誌根也不解析，`--session-log` 跟它矛盾就當場拋——同 CLI 那一份檢查。
  const persistenceMounted = startupEntryMounted(plugins, sessionPersistencePlugin);
  assertPersistenceFlags(
    invocation,
    persistenceMounted,
    dropReasonsOf(loaded, sessionPersistencePlugin),
  );
  // **在開 server 之前解析**，同 `cli.ts` 那條的理由：一個指錯地方的日誌根該在什麼都還沒起來的
  // 時候就講。同一個函式，所以「日誌不能落在 `--workspace` 底下」那條檢查兩個入口共用一份，預設值
  // （harness home 底下的 `sessions`，#444）也是同一份。
  const sessionLogDir = persistenceMounted ? resolveSessionLogDir(invocation, cwd, env) : undefined;
  // 工具結果 meta 與壓縮摘要放上線的上限（#538；結果文字自 #736 起不截）。**同樣是 server 的性質**：兩個消費點（即時的
  // `ThreadPump`、重播的 `historyPage`）都住在 `createWireHandler` 的閉包底下，一個 server 一次。
  const toolTextLimits = startupSetting(plugins, toolTextPlugin);
  // 插件投影 frame 的合併視窗（#1071）。同樣是 server 的性質：每條 thread 的 pump 吃同一個數字。
  const projectionFlush = startupSetting(plugins, projectionFlushPlugin);
  // 過大工具結果的暫存（#734）：根與保留天數是 server 的性質，解一次；啟動時清一次超過保留期的檔，
  // 別人改得動的根不清，失敗只記一筆不擋啟動。**清掃在背景跑**（#1553 N0952，照 dsh `spill-local/src/index.ts:90-101`）：
  // 歸根所有，server 不等它就開始服務；卸載根（`close()` 與起不來的那幾條路）時等它收斂。
  const stashConfig = startupSetting(plugins, toolResultStashPlugin);
  const stashRoot = resolveToolResultStashRoot(stashConfig, env);
  launchToolResultStashSweep(
    await root.tree.context(),
    stashRoot,
    stashConfig.cleanupPeriodDays,
    warn,
  );
  // 外溢層的預算（#719）：server 的性質，解一次；省略就是不掛。
  const spillPolicy = startupSetting(plugins, spillPolicyPlugin);
  // 背景續行子代理（#841）：server 的性質，解一次；`one-shot` 就不傳，回到基座的 `task`。
  const backgroundSubagents = startupSetting(plugins, backgroundSubagentsPlugin);
  // 真實供應商的五個連線值（#545）。**model 是一條 thread 一顆**（下面每次 `createCliAgent` 各建
  // 一顆），但設定是 server 的性質：解在這裡，設定寫壞的話在 server 起來之前就失敗，而不是等到
  // 第一條 thread；啟動時印的模型名也從這一份來。
  const liveModel = startupSetting(plugins, liveModelPlugin);
  // 這一把 key 來自哪一層（#1540 Q2 (a)）：只講名字與來源、不含值；名字是 `live-model` 那一列的 `apiKeyEnv`（#1604），所以讀完設定才印。
  // 仍排在拿到 home 鎖之後（`runServe` 先拿鎖才進 `startServer`）、任何模型建構與請求之前；日誌裡出現的順序比以前往後挪。
  // 舊位置搬家檢查也在這裡、用同一個名字（#1604）：設定要的那把找不到、而舊位置的 `.env` 還在才失敗；在 `startServer` 裡拋，鎖與根照一般的起不來路徑收。
  liveLaunch?.assertKeyLocated(liveModel.apiKeyEnv);
  const keySource = liveLaunch?.keySourceOf(liveModel.apiKeyEnv);
  if (keySource !== undefined) log(keySource);
  // 全機的模型請求並行閘（#1505）：起動期建一份，每條 thread 的組裝共用；沒設 `maxConcurrentRequests` 就沒有。
  // 排隊逾時的那一行走獨立的 `warn`，不借別處的。
  const requestGate = createRequestGate(liveModel, warn);
  // 子代理逐次選模型（#875）：server 的性質，解一次、對著型錄驗一次（起不來就在 server 起來之前）。
  // 每個新會話在 `createAgent` 裡各自取樣，續接的會話讀日誌那一份。
  const modelSelection = startupSetting(plugins, subagentModelSelectionPlugin);
  assertAllowedModelsInCatalog(modelSelection, liveModel.models);
  // LLM 標題那一列（#650），理由同上：標題模型一條 thread 一顆，設定是 server 的性質。沒帶 `--live` 也解——
  // 寫壞的設定不因為這一次用不到就放過，同 `live-model` 那一列。
  const threadTitleLlm = startupSetting(plugins, threadTitleLlmPlugin);
  // 會話內容搜尋那一列（#631）。**掛沒掛與設定分開問**，同 `thread-title-llm`：`disabled: true` 是沒掛（搜尋一律回
  // 失敗），`openAt: never` 是掛了不開（沒東西可搜時回空）。出廠是後者，見 `settings/thread-search.ts`。
  const threadSearchMounted = startupEntryMounted(plugins, threadSearchPlugin);
  const threadSearchConfig = startupSetting(plugins, threadSearchPlugin);
  // 跨會話引用那一列（#1573 N0862）：候選上限在下面建 `SessionReferenceCandidates` 時給，引用上限與預算經 handler 交給每條 thread 的 pump。
  // 這一列在必掛名單上（寫壞整個起不來）也關不掉，所以 `startupSetting` 讀到的一定是清單上那一列，不會是「關掉的列回預設」。
  const sessionReference = startupSetting(plugins, sessionReferencePlugin);
  // thread 數上限（#1476，保險絲第 2 級）。**server 的性質**：`threads` 表一台伺服器一張，檢查在 `createWireHandler` 的
  // `threadFor` 裡，所以值在這裡解、往下傳一份。出廠開著、關不掉（#1619，`settings/thread-capacity.ts`）。
  const threadCapacity = startupSetting(plugins, threadCapacityPlugin);
  // 會話日誌額度（#2115）：serve 的存放處與引用候選逐格開的共用這一本。`thread-capacity` 的 `sessionLogBudgetMiB` 不寫就自動算——
  // 等第一次用到（最晚是下面起動披露那一行）才算，起動披露之前沒有請求讀過日誌的話，那時 RSS 是 serve 起動完的底；
  // 寫了就固定，`0` 是不限。
  const configuredLogBudgetMiB = threadCapacity.sessionLogBudgetMiB;
  const sessionLogBudget =
    options.sessionLogBudget ?? sessionLogBudgetFromSetting(configuredLogBudgetMiB);
  // 目標續行的操作者上限（#1623）：人每授權一次最多續行幾輪。關掉那一列就只剩目標自己那條；`--no-goal-driver` 時不起作用。
  // **掛沒掛先問**：`startupSetting` 對關掉的列回 schema 預設，不先問會把關掉讀成 20。
  const goalRoundCap: GoalRoundCap | undefined = startupEntryMounted(plugins, goalRoundCapPlugin)
    ? { limit: startupSetting(plugins, goalRoundCapPlugin).limit, source: GOAL_ROUND_CAP_SOURCE }
    : undefined;
  // 一輪的時鐘（#1624）：主對話與背景子代理的每一輪各自起算，到點照停止鍵的路中止。關掉那一列就是不限，同 goal-round-cap 要先問掛沒掛。
  const turnClock: TurnClock | undefined = startupEntryMounted(plugins, turnTimeoutPlugin)
    ? { timeoutMs: startupSetting(plugins, turnTimeoutPlugin).timeoutMs }
    : undefined;
  // 記憶體量具（#1490）：只讀只講，預設關閉（`reportIntervalMs: 0`），開了才在起動尾端起，見 `memory-gauge.ts`。
  const memoryGaugeConfig = startupSetting(plugins, memoryGaugePlugin);
  // 下行串流的心跳間隔與每條線的位元組上限（#1504）。**兩個消費點在兩處**：心跳間隔交給 `startWireServer`（socket 那一層），位元組上限交給
  // `createWireHandler`（訂閱者佇列）。預設開、關不掉（`plugin-config.ts` 的 `PROTECTED_ENTRY_REASONS`）。
  const downlink = startupSetting(plugins, downlinkPlugin);
  // 探針與指標（#1535）：探針預設開，指標預設關。路由與披露在下面，token 檔在瀏覽器密鑰之後讀。
  const opsConfig = startupSetting(plugins, opsEndpointsPlugin);
  // 圖片轉碼的併發上限（#2033）：一個行程一份限流器，交給下面的附件儲存。出廠 2、關不掉（`settings/attachment-images.ts`）。
  const attachmentImages = startupSetting(plugins, attachmentImagesPlugin);
  // **先照每條 thread 那一次組一份，組完就收**（#749）。上面那幾列只驗了自己的設定；其餘每一列的設定、重名、
  // `requires` 缺件、`apply` 裡的值檢查（例如 `tool-result-pruner` 的門檻），不組一次就不會發生，而 serve 的
  // agent 是每條 thread 才組的——不先組這一次，伺服器照樣起來，每個開對話的人才各撞一次，伺服器日誌一行都沒有。
  // 跟下面 `createAgent` 同一個函式、同一組參數，不帶續接，失敗的處理跟 CLI 那一刻（`assembly-root.ts` 的 `createCliAgent`）
  // 同一套：可少掛的列掉了印警告、照樣起來，其餘原樣拋（見下面「判第二次」那段）。
  //
  // **偏離登記**：dsh 的 `boot()` 把 plugin 樹掛一次、一直用下去，驗證是掛載順帶發生的
  // （dsh `packages/boot/app-boot/README.zh.md:92`，`477b4f4`）。我們的 Cordis 樹（#1401）上只有相容層與入口兩列，清單上的
  // 列不在樹上：agent 一條 thread 一份（見檔頭），這個形狀在這之前就在，不是基座表達不出來。退到這裡：形狀不動，
  // 啟動時多組一次、驗完就收，錯誤出現的時刻跟 dsh
  // 一樣在啟動時，代價是每一列的 `apply` 多跑一遍。
  //
  // **位置是承重的**：在讀或建瀏覽器會話密鑰與綁 port 之前，起不來的那一次什麼都還沒留下。收掉失敗也拋，同 CLI
  // 那條：組得起來卻收不乾淨，可能有子行程還活著（`cli-dispose-failure.fixture.ts`）。
  //
  // **掉了哪幾列在這裡判第二次**（#751），同 CLI 那一次組裝：清單上可少掛的列 `apply` 失敗、`requires` 缺件、撞名，
  // 只讓它掉；必掛的、組裝點自己加的外掛掉了，換成跟第一次同一種 `StartupError`。兩次合起來印一段到伺服器日誌，
  // 只印這一次，在綁 port 之前。
  // **錨定估算的帳（#702）**：一台 server 一本，下面每條 thread 的組裝都傳同一本，借錨才跨得過 thread。
  // 型錄上宣告逐位切詞的模型（#1102）按位數估，其餘照 o200k。
  const tokenAnchorBook = new TokenAnchorBook({
    singleDigitModels: singleDigitModelIds(liveModel.models),
  });
  // **不變量的量測記錄（#976）**：一台 server 一份，每條 thread 的組裝傳同一個 tap。違規本身走伺服器日誌的 `invariant` logger（error 等級，
  // #1534；以前走 runner 預設的 `console.error`），這份只是另外留一份可數的紀錄；試組那一次不接線所以不傳。
  // 落盤關掉或 home 在工作區底下時不寫，理由見 `resolveInvariantLogPath`。
  const invariantLogPath = resolveInvariantLogPath(
    invocation.workspace,
    persistenceMounted,
    cwd,
    env,
  );
  const invariantTap =
    invariantLogPath === undefined ? undefined : createInvariantLog(invariantLogPath);
  // **組 agent 經 Cordis 樹上的相容層**（#1401）：根在試組之前才建，前面每一個錯誤的時刻與字都不變；每條 thread 用同一份服務。
  const assembly = await root.boot('serve', {
    plugins,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
  });
  // `skill.list` 在每條 thread 的閉包裡讀它（#1574）：`root` 是 `let`，進閉包就失去收窄。
  const tree = root.tree;
  const trial = await assembly
    .create(
      {
        ...invocation,
        liveModel,
        ...(requestGate !== undefined && { requestGate }),
        credentials,
        threadTitle,
        threadTitleLlm,
        optionalEntries,
      },
      { session: { mcpPool } },
    )
    .catch(async (error: unknown) => {
      if (!(error instanceof AssemblyDropError)) throw error;
      const startupError = startupErrorFrom(loaded, error, audit);
      failureRecorder.note(failedRowsOf(startupError.dropped, undefined), 'startup');
      await failureRecorder.flush();
      throw startupError;
    });
  await trial.dispose();
  failureRecorder.note(failedRowsOf(assemblyDropsOf(loaded, trial.dropped), undefined), 'startup');
  for (const line of startupWarning(
    loaded,
    assemblyDropsOf(loaded, trial.dropped),
    trial.warnings,
  )) {
    warn(line);
  }
  // **試組掉了的列帶進每條 thread 的組裝，直接算沒掛**（卡上第 6 項）：不再重試、不再每條各印一次。照 dsh：樹只掛
  // 一次，沒起來的條目一直不在，直到改設定重載。我們的「重載」是每條 thread 重讀清單（#1405）：那一列的設定一改，
  // 下一條 thread 重新試它；沒改就照樣標成 `disabled: true`，跟讀清單那一次設定驗不過的列同一個做法。
  const trialDropped = new Set(trial.dropped.map(({ entry }) => entry));
  // **每條 thread 組裝時重讀清單**（#1405）：同一個函式、同一組參數，新 thread 看得到 home 層改過的列與組裝期設定。
  // 起動期讀一次的列照舊到重啟才生效，重讀時看到值變了就記「已儲存，待重啟」；這份名單就是上面 `startupSetting`／
  // `startupEntryMounted` 讀的那幾列。規則與偏離登記見 `thread-plugin-list.ts`。
  //
  // **已儲存 vs 執行中的對照寫成 home 底下一份 JSON 檔**（#1406）：啟動時一次、之後每次重讀一次。不開 wire 路由——
  // 還沒有管理員身分，`/threads` 底下每個登入的人都看得到。檔裡不帶設定值也不帶 drop 原文，理由與偏離登記見
  // `plugin-snapshot.ts`；路徑與讀法見 `docs/operations.md`。
  const snapshotWriter = createPluginSnapshotWriter({ path: pluginSnapshotPath(env), log, warn });
  // **活著的設定版本的版本字串用 `config-hash-key.json` 那把鍵**（#1442 Q2 (a)），跟會話日誌 header 的 `configHash` 同一把：
  // 設定值不進檔，改了又改回來是同一版。**落盤關掉就不取**（同 `headerMetadataOf`：關掉落盤的啟動不該在 home 底下建鍵檔），
  // 鍵讀不到或落在工作區底下也只講一次、不帶 `live`；快照其餘照舊。
  const liveVersionKey =
    sessionLogDir === undefined
      ? undefined
      : await loadConfigHashKey({
          env,
          ...(invocation.workspace !== undefined && { workspace: invocation.workspace }),
          cwd,
        }).catch((error: unknown) => {
          warn(
            `[對照快照] 這一次不列活著的設定版本：${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        });
  const threadPluginList = createThreadPluginList({
    load: (warn) =>
      loadDefaultPlugins(
        {
          serve: true,
          env,
          ...(invocation.patches !== undefined && { patches: invocation.patches }),
          warn,
        },
        { tree: root.tree },
      ),
    startup: loaded,
    trialDropped,
    trialDrops: assemblyDropsOf(loaded, trial.dropped),
    recorder: failureRecorder,
    audit,
    // 起動期讀的那幾列：名單與分類表同一份（`plugin-row-classes.ts`），上面 `startupSetting` 那幾行讀的就是它們。
    startupRead: STARTUP_READ_PLUGINS,
    log,
    warn,
    publishSnapshot: async (snapshot) => {
      await snapshotWriter.publish(snapshot);
    },
    ...(liveVersionKey !== undefined && {
      liveVersions: { sign: (signature: string) => hmacHashOf(signature, liveVersionKey) },
    }),
  });
  // 啟動那一份先寫下去（檔在 server 起來之前就在），摘要留到下面啟動那幾行印完再記，不插在網址前面。
  const startupSnapshot = threadPluginList.snapshot();
  const startupSnapshotWritten = await snapshotWriter.publish(startupSnapshot, { announce: false });
  // 啟動那幾行裡的「plugin：」不列掉了的列，兩次掉的都不列。
  const droppedEntries = new Set([
    ...loaded.dropped.flatMap((drop) => drop.entry ?? []),
    ...trialDropped,
  ]);
  // 遙測的答案也在這一次定下來，印在下面啟動那幾行裡：每條 thread 掛的是同一份清單，答案每條都一樣。
  const telemetrySharing = trial.telemetrySharing;
  const auth = new BrowserAuth(
    await loadOrCreateBrowserSessionSecret(resolveHarnessHome(env)),
    browserSession.maxAgeDays,
  );
  // 指標的 bearer token（#1535）：只有打開指標才讀或建，**在綁 port 之前**——權限過寬、內容認不得就讓 serve 起不來，不覆寫，同上面那把瀏覽器密鑰。
  const metricsTokenFile = join(resolveHarnessHome(env), METRICS_TOKEN_FILE);
  const metricsToken = opsConfig.metrics.enabled
    ? await loadOrCreateMetricsToken(opsConfig.metrics.tokenFile ?? metricsTokenFile)
    : undefined;
  const webDist = options.webDist ?? resolveWebDist();
  // 釘選與封存兩個集合（#633）：home 底下一個檔，**啟動時就讀**——壞檔（版本、格式、權限）讓 serve 起不來，不覆寫，
  // 跟上面那把瀏覽器密鑰同一個處置。沒落盤時不開：釘選一條重啟就消失的 thread 沒有意義，見下面 `createWireHandler` 的註解。
  const threadOrganization =
    sessionLogDir === undefined
      ? undefined
      : await ThreadOrganization.open(resolveHarnessHome(env));
  // 上傳的檔案存在 harness home 底下、會話日誌之外（#732）。只解析路徑，第一次上傳才建目錄。
  // home 以上的祖先開不了、略過那一層 fsync 時，講在伺服器日誌（#1528 Q1 (b)）。
  const attachmentStore = new AttachmentStore(attachmentsRootOf(resolveHarnessHome(env)), {
    warn,
    imageCompressionConcurrency: attachmentImages.imageCompressionConcurrency,
  });

  // **會話根按目錄分，一個專案一格**——照 dsh 的 `projectDir(root, cwd)`
  // （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 拍板的第 3 件）。一條
  // thread 一個檔落在那一格裡，檔名就是 thread id，所以重開 server 之後同一條 thread 找得
  // 回自己那一份。CLI 那條仍然每次開一個 run 目錄：它的 root 固定叫 `cli`，放在固定的
  // 地方會每次都撞；serve 的 root 是 thread id，本來就全域唯一。subagent 那幾份的 id 是
  // `<thread>/<LangGraph task id>`，而 task id 由當下那顆 checkpoint 的 id 算出來
  // （`uuid5(…, checkpoint.id)`，checkpoint id 是帶時間與亂數的 `uuid6`），跨行程不會重複。
  const sessionStore =
    sessionLogDir === undefined
      ? undefined
      : openJsonlSessionStore({
          directory: join(sessionLogDir, projectKey(cwd)),
          logBudget: sessionLogBudget,
          // 後端講話（例如這個平台拿不到寫租約）走伺服器日誌，前綴同協調器那條。
          warn: (message) => {
            warn(`[會話日誌] ${message}`);
          },
        });
  // 落盤確認（#1606）讀回比對用的 store：樹上 `session-durability` 那一列在讀清單時依清單掛上，做法在被呼叫當下才讀它。
  if (sessionStore !== undefined) root.tree.bindDurableStore(sessionStore);
  // **每條新 thread 的私有可寫根與唯讀共用區**（#1775）。「thread（連同它的 header）→ 放在哪裡」整台一份：新 thread 在基底底下配一個目錄，
  // 續接照 header 分類（`thread-roots.ts` 檔頭有表）。測試接縫 `workspaceRootOf` 給了就換成固定的那一支（沒有私有根，續接守衛逐字比）。
  const sharedWorkspaceRoot = resolveWorkspaceRoot(invocation.workspace, cwd);
  const threadRootsBase = resolveThreadRootsBase(env);
  if (options.workspaceRootOf === undefined && sharedWorkspaceRoot !== undefined) {
    // 基底不能跟 `--workspace`、工具結果暫存根、附件根、會話日誌目錄重疊（兩個方向）；排在綁 port 之前，起不來的訊息點名是哪一對。
    await assertThreadRootsBaseSeparate({
      base: threadRootsBase,
      others: [
        { label: '--workspace', path: sharedWorkspaceRoot },
        { label: '工具結果暫存根', path: stashRoot },
        { label: '附件根', path: attachmentsRootOf(resolveHarnessHome(env)) },
        ...(sessionLogDir === undefined ? [] : [{ label: '會話日誌目錄', path: sessionLogDir }]),
      ],
    });
    // 基底（或還沒有基底時的 home）的擁有者與權限現在就驗，壞了起不來，不等第一條新 thread 才拋。
    verifyThreadRootsBase(threadRootsBase);
    // 落盤關掉（#612）：沒有 header、不能續接、沒有會話鑰匙，新 thread 的可寫根是記憶體，`--workspace` 照樣唯讀掛成共用區（PM 裁決 (f)，偏離 2 的延伸）。
    // **照實講**，不靜靜收下：`--sandbox` 在這個組合下一個位元組都影響不到（可寫根不在磁碟上，共用區固定唯讀），所以直接拒絕（同 `parseSandboxMode`
    // 沒配 `--workspace` 的理由）；其餘不適用的（`present`、`@` 列檔、改動摘要、`/permission` 的檔案政策）跟沒給 `--workspace` 一樣，在這一行講明。
    if (sessionStore === undefined) {
      if (invocation.sandbox !== undefined) {
        throw new Error(
          '--sandbox 要配落盤：會話日誌落盤關掉時，每條 thread 的可寫根是記憶體（--workspace 只以唯讀共用區掛上），' +
            '圍堵那道 fence 不在路徑上，這個模式一個位元組都影響不到。要嘛開著落盤，要嘛不要給 --sandbox。',
        );
      }
      warn(
        '[私有根] 會話日誌落盤關掉（沒有 header、不能續接）：每條 thread 的可寫根只在記憶體裡，重啟就沒了；--workspace 以唯讀共用區掛在 ' +
          `${SHARED_WORKSPACE_PREFIX}（偏離 2 的延伸，#1775）。檔案不落磁碟、沒有圍堵：present、@ 列檔、改動摘要與檔案政策（--sandbox、/permission）跟沒給 --workspace 一樣不適用。`,
      );
    }
  }
  const placeThread =
    options.workspaceRootOf !== undefined
      ? createFixedThreadPlacer(options.workspaceRootOf)
      : createThreadPlacer({
          sharedRoot: sharedWorkspaceRoot,
          base: threadRootsBase,
          sessionKeyOf:
            sessionStore === undefined
              ? undefined
              : (threadId) => `${sessionStore.directory}\0${threadId}`,
        });
  // **新建的 header 帶建置版本、插件清單與設定雜湊**（#1025）：鍵與建置版本是 server 的性質，起動期讀一次；清單與雜湊
  // 是那條 thread 組裝時重讀的那一份（#1405），跟 `--dump-config` 同源。落盤關掉就不算。
  const headerMetadataOf =
    sessionStore === undefined
      ? undefined
      : await createSessionHeaderMetadataResolver({
          env,
          ...(invocation.workspace !== undefined && { workspace: invocation.workspace }),
          cwd,
          warn: (message) => {
            warn(`[會話日誌] ${message}`);
          },
        });

  // 一台 server 一份索引：對帳與查詢在它裡面排隊。沒接落盤時照樣建，搜尋回空（沒有東西可搜）。
  const threadSearch = threadSearchMounted
    ? new ThreadSearch({
        cwd,
        openAt: threadSearchConfig.openAt,
        ...(sessionStore !== undefined && { store: sessionStore }),
        // 活的 thread 讀記憶體（#1599）：表在下面建的 handler 手上，搜尋只經 handler 進來，叫到時它一定在了（同 `OpsMetrics` 那一支）。
        liveThreads: () => handler.liveThreads(),
      })
    : undefined;
  // `startup` 在這裡載入 `node:sqlite`，載不起來就不開 server：設定說要一起來，那就在什麼都還沒起來時講。
  await threadSearch?.open();

  const sessionReferenceCandidates =
    sessionLogDir === undefined
      ? undefined
      : new SessionReferenceCandidates({
          rootDir: sessionLogDir,
          cwd,
          title: threadTitle,
          limit: sessionReference.candidateLimit,
          warn,
          openStore: (directory: string) =>
            openJsonlSessionStore({ directory, logBudget: sessionLogBudget }),
          liveEvents: (sessionId) => handler.liveSessionEvents(sessionId),
        });

  // 閒置逐出（#1484）：沒有 `sessionStore` 就是沒落盤，撤掉的 thread 回不來，所以一律不逐出；設成 0 是管理者關掉逐出（#1619，
  // 照 dsh `unattendedTimeoutMs` 的 0）。兩種都不把 T 傳下去——handler 收到 0 會把每條閒著的 thread 在下一次掃描就撤掉。
  // 下面啟動那一段會講是哪一種。
  const idleEvictMs =
    sessionStore === undefined || threadCapacity.idleEvictAfterMs === 0
      ? undefined
      : threadCapacity.idleEvictAfterMs;

  /**
   * 冷讀一條會話的 header（`open(id, 'read')`：不拿租約、不寫檔）；**只吞「找不到」**（回 `undefined`），其他讀不了的原樣拋，
   * 不吞成別的意思。子代理會話閘（#1544）的兩個入口共用：`createAgent` 的第一道、`run.cancel` 的檢查。
   */
  const coldSessionHeader = async (threadId: string): Promise<StoredSessionHeader | undefined> => {
    if (sessionStore === undefined) return undefined;
    try {
      return (await sessionStore.open(threadId, 'read')).header;
    } catch (error: unknown) {
      if (error instanceof SessionNotFoundError) return undefined;
      throw error;
    }
  };

  /**
   * 這一版讀不懂的日誌（{@link SessionFormatUnsupportedError}）：原始檔在哪裡記進伺服器日誌，錯原樣往外拋（#1559 N0646）。
   * **路徑只到這裡**：錯誤訊息會進協定錯誤送到瀏覽器（`wire-handler.ts` 的 `threadOrError`），多人共用的主機不把目錄結構
   * 交給每一個打開那條 thread 的人（偏離 dsh 的訊息帶路徑，理由 2，#1558 Q1 (a)）。
   */
  const noteRefusedLog =
    (threadId: string) =>
    (error: unknown): never => {
      if (error instanceof SessionFormatUnsupportedError && error.location !== undefined) {
        warn(
          `[會話日誌] thread ${threadId} 的日誌這一版讀不了，原始日誌在 ${error.location.path}：${error.message}`,
        );
      }
      throw error;
    };

  // serve 自己的 `close()` 開始了沒：`/readyz` 在 server 關掉之前就要回 503（#1535）。
  let closing = false;
  // 指標的計數與取樣（#1535）：只有打開才建（關著的時候不起事件圈取樣、不計數）。thread 數與上限抓取當下才現算。
  const opsMetrics = opsConfig.metrics.enabled
    ? new OpsMetrics(() => ({
        threads: handler.threadCount() - handler.closingCount(),
        threadsClosing: handler.closingCount(),
        maxThreads: threadCapacity.maxThreads,
      }))
    : undefined;
  const handler = createWireHandler({
    auth,
    // 附件儲存（#732）：上傳路徑存進這裡；每條 thread 的 agent 另外掛一條唯讀路由給模型讀（見下面 `attachments`）。
    attachments: attachmentStore,
    deliverableLimits,
    toolTextLimits,
    threadTitleLimits: threadTitle,
    projectionFlushMs: projectionFlush.flushMs,
    downlinkMaxBytes: downlink.maxQueuedBytes,
    ...(turnClock !== undefined && { turnClock }),
    maxThreads: threadCapacity.maxThreads,
    // 閒置逐出（#1484，保險絲第 1 級）：**只有落盤開著、而且不是 0 才傳**。沒有落盤的日誌只在記憶體裡，撤掉就沒了；啟動時
    // 印一行講是哪一種（下面「thread 上限」那一段）。撤完重寫 `plugin-snapshot.json`：放掉 live 綁定只動記憶體，檔要這裡補。
    ...(idleEvictMs === undefined
      ? {}
      : {
          idleEvictMs,
          onThreadEvicted: () => threadPluginList.republishSnapshot(),
        }),
    // 一頁歷史撐破軟上限時（#479）、退回標題寫不進去時（#647）、模型標題寫不成時（#650）講一聲。
    warn,
    // 閒置逐出把一條 thread 撤出記憶體是正常狀態（#1534）：info，門檻調到 warn 的主機不為它出一行。
    info: log,
    // 一輪失敗（含背景子代理）在伺服器日誌記一行 warn（#1536）：thread、run、日誌第幾筆、失敗碼、供應商請求編號；不含失敗訊息本文。
    // JSON 模式同樣的格另外成鍵。**接線紅燈從 `runServe` 起量**（`turn-failed-log-wiring.test.ts`），拿掉這一行就沒有那一行日誌。
    onTurnFailed: (report) => {
      // 指標的回合失敗計數（#1535）：跟下面那一行日誌共用同一個回呼，不各插一行。指標關著（`opsMetrics` 缺席）就什麼都不做。
      opsMetrics?.recordTurnFailure(report.code);
      serverLogOut.serveWith(turnFailedFields(report)).warn(turnFailedMessage(report));
    },
    // **冷讀那一格**（#302）：讀的是續接那條路寫進去的同一格，只列切得過去的——`cwd` 就是續接時
    // `assertSameCwd` 比的那一個。落盤關掉（#612）就整個不給，列表那時講「列不出來」而不是「沒有」。
    ...(sessionStore === undefined
      ? {}
      : {
          listThreads: (signal: AbortSignal) =>
            listStoredThreads(sessionStore, { cwd, title: threadTitle, signal }),
          // 冷讀一條 thread（#1580 分叉的來源）：中斷的那一輪在記憶體補平（`readColdSession`，#1598），可見規則同列表（`isListedThread`）。
          // 只有「找不到」是 `undefined`；壞檔、版本太新照拋。
          readStoredThread: async (threadId: string) => {
            try {
              const stored = await readColdSession(sessionStore, threadId);
              return isListedThread(stored.header, cwd) ? stored : undefined;
            } catch (error) {
              if (error instanceof SessionNotFoundError) return undefined;
              throw error;
            }
          },
          // 背景子代理自己的落盤日誌（#871）：唯讀冷讀，規則見 `readStoredSubagentSession`。
          readSubagentSession: (threadId: string, runId: string) =>
            readStoredSubagentSession(sessionStore, threadId, runId),
          // 釘選與封存的存放處，與它的存在檢查（#633）：只讀 header 一份，不掃整個目錄；可見規則同列表（`isListedThread`），
          // **能釘的一定列得出來**。只有「找不到」是 `false`；壞檔、版本太新照拋——壞掉的磁碟不是「沒有這條」。
          ...(threadOrganization !== undefined && {
            threadOrganization,
            storedThreadKnown: async (threadId: string) => {
              try {
                const stored = await sessionStore.open(threadId, 'read');
                return isListedThread(stored.header, cwd);
              } catch (error) {
                if (error instanceof SessionNotFoundError) return false;
                throw error;
              }
            },
          }),
        }),
    // `@` 引用別的會話的候選（#713）：冷讀整個會話根，跨專案。落盤關掉就不給，路由那時回 `available: false`。
    ...(sessionReferenceCandidates !== undefined && {
      listSessionReferences: (threadId: string, query: string, signal: AbortSignal) =>
        sessionReferenceCandidates.list(threadId, query, signal),
      // 被 `@` 的會話怎麼讀回來（#713）：同一份索引，pump 領走那句話時用。
      sessionReferenceReader: sessionReferenceCandidates,
    }),
    // 每則訊息最多引用幾條、每條多大（#1573 N0862）；預算跟著每條 thread 下一步會走的模型，見 `createWireHandler`。
    sessionReferenceSettings: sessionReference,
    // 按內容搜（#631）。沒掛那一列就不給，handler 那時一律回「沒掛」。
    ...(threadSearch !== undefined && {
      searchThreads: (query: unknown, signal: AbortSignal) => threadSearch.search(query, signal),
    }),
    // 落盤的子代理會話（#1544）：`run.cancel` 不經 `createAgent`，靠這個問。
    ...(sessionStore !== undefined && {
      isSubagentSession: async (threadId: string) => {
        const header = await coldSessionHeader(threadId);
        return header !== undefined && isSubagentSessionHeader(header);
      },
    }),
    // 一個 thread 一個 agent——各自的 checkpointer、各自的虛擬檔案系統。
    createAgent: async (threadId: string, fork?: ThreadForkSeed) => {
      // **子代理的會話不是 thread**（#1544；判準見 core 的 `isSubagentSessionHeader`，分叉不算，#1579）。
      // **必須在 `resumeThread` 之前、而且只冷讀 header**（`open(…, 'read')`，不拿租約、不寫檔）：續接會先拿寫租約、再把當掉那一輪的
      // 收尾寫回檔上（#721），放在它之後的話，日誌在被拒絕之前就已經被改了。「找不到」往下走（新 thread）；其他讀不了的
      // （header 壞了、權限）`coldSessionHeader` 自己就拋，這條 thread 建不起來、下一次請求重試——不吞成「不是子代理」放行。
      // 分叉出來的子 thread（#1580）id 是剛產生的，磁碟上沒有它，兩道都不必問。
      if (sessionStore !== undefined && fork === undefined) {
        const header = await coldSessionHeader(threadId).catch(noteRefusedLog(threadId));
        if (header !== undefined && isSubagentSessionHeader(header)) {
          throw new SubagentSessionError(threadId);
        }
      }
      // **以前寫過就接回來**（照 dsh：碰到一個已存的 session id 就 resume，不另開）。續接在讀
      // 之前就拿了寫租約，要到落盤接上之後才歸協調器收；這中間拋錯要先放掉，不然
      // `wire-handler.ts` 說好的「下一次請求重試」會撞上自己上一次留下的租約。
      const resumed =
        sessionStore === undefined || fork !== undefined
          ? undefined
          : await resumeThread(sessionStore, threadId).catch(noteRefusedLog(threadId));
      // **這條 thread 從哪一份日誌長出來**：續接的是磁碟上那一份，分叉的是記憶體裡的 seed（#1580）。下面從日誌推的每一樣（目錄守衛、
      // 可寫根、沙箱模式、核准政策、模型選擇、對話重播、交付的錨）都讀這一份，所以分叉出來的子 thread 第一次組裝與重啟後續接走同一套規則。
      // 分叉的 header 是給 placer 與守衛看的：根照抄來源（`thread-roots.ts` 那張表的「分叉的子 thread」那一列），`cwd` 也是來源的。
      // 真正落盤的 header 由落盤接線建（下面的 `rootLineage`），同 dsh 由 `agents.create` 的 `meta` 建。
      const history:
        | { readonly header: StoredSessionHeader; readonly events: readonly SessionEvent[] }
        | undefined =
        fork !== undefined
          ? {
              header: {
                version: SESSION_LOG_FORMAT_VERSION,
                id: threadId,
                createdAt: Date.now(),
                ...(fork.sourceHeader.cwd !== undefined && { cwd: fork.sourceHeader.cwd }),
                ...(fork.sourceHeader.workspaceRoot !== undefined && {
                  workspaceRoot: fork.sourceHeader.workspaceRoot,
                }),
                parentSession: fork.sourceHeader.id,
                isSeeded: true,
              },
              events: fork.seed,
            }
          : resumed;
      let handedOff = false;
      const release = async (): Promise<void> => {
        if (handedOff) return;
        handedOff = true;
        await resumed?.stored.close();
      };
      // **第四個引數傳伺服器日誌的 `invariant` logger，第五個刻意不傳，而且理由不同。**
      //
      // 第四個（不變量違規往哪裡講）：傳進去的是下面 `session.onInvariantViolation`，違規走伺服器日誌的 error 等級
      // （[#1534](https://github.com/DemianLi/nexus-agent/issues/1534)；原先維持 `createInvariantRunner` 預設的 `console.error`，
      // 進的是 stderr、不受門檻與格式管，[#107](https://github.com/DemianLi/nexus-agent/issues/107)）。CLI 那條要繞過 `Printer` 才印得出前綴，
      // 這裡沒有那個問題——伺服器日誌本來就沒有跟誰搶終端機。
      //
      // 第五個（核准政策）：**這裡維持預設的「有人在」**。CLI 與 eval 關掉它是因為那兩個
      // 入口收不了核准決定，而 web 這端真的按得下去（[#79](https://github.com/DemianLi/nexus-agent/pull/79)
      // 的核准迴圈，`serve.test.ts` 的「核准那份清單」整條走過一遍）。關掉它會把一個
      // 做得出來的功能關掉（[#113](https://github.com/DemianLi/nexus-agent/issues/113)）。
      let built: Awaited<ReturnType<NexusAssembly['create']>>;
      let threadList: Awaited<ReturnType<typeof threadPluginList.read>>;
      // 組裝失敗時 catch 要用這一份清單換算掉了的列（`threadList` 在 catch 裡還沒有保證已賦值）。
      let assembledFrom: typeof threadList | undefined;
      try {
        // 冷讀與續接之間檔案被換掉的窄縫：接回來的那份再核一次（照 dsh `session-controller/src/agent.ts:231-234`，續接之後核對）。
        // **撞上這道縫時，日誌在被拒絕之前已經被動過**：`resumeThread` 已拿了寫租約、把當掉那一輪的補結寫回檔上（#721）；
        // 這一道只保證不往下組裝、不開出一條 thread，並由下面的 catch 放掉租約。要日誌一個位元組都不動只有第一道（冷讀）做得到。
        if (resumed !== undefined && isSubagentSessionHeader(resumed.header)) {
          throw new SubagentSessionError(threadId);
        }
        // 讀不起來、必掛的列掉了：只有這一條建不起來，伺服器照常，下一條再讀一次（#1405 Q1）。
        threadList = await threadPluginList.read();
        assembledFrom = threadList;
        if (history !== undefined) assertSameCwd('serve', threadId, history.header, cwd);
        // **這條 thread 的可寫根只在這裡取一次**（#1774、#1775）：「thread（連同 header）→ 放在哪裡」回來的值**同時**交給組裝點與下面的續接分類，兩邊不會分岔。
        // 新 thread 在這裡配私有根；續接照 header 分類（header 的根是這一次的 `--workspace`、沒記、或在基底底下就照用，其餘拋 `ResumeWorkspaceConflictError`），
        // 順序與理由逐字同 CLI 的 `--resume`：目錄先認，這一道在沙箱那一道之前（#504）。
        const placement = await placeThread({
          entry: 'serve',
          threadId,
          resumedHeader: history?.header,
        });
        const threadWorkspaceRoot = placement.root;
        // 同 CLI 的 `--resume`：模式從日誌來；日誌記著模式就表示上一次有 fence，這一次沒有
        // `--workspace` 的話那道 fence 不在路徑上，接回來的 `read-only` 會靜靜蒸發。
        const resumedSandbox =
          history === undefined ? undefined : recordedSandboxMode(history.events);
        if (resumedSandbox !== undefined && invocation.workspace === undefined) {
          throw new Error(
            `thread "${threadId}" 接不回來：上一次跑在 --workspace 底下（日誌記著沙箱模式 ` +
              `${resumedSandbox}），這台 server 沒給 --workspace，那道 fence 不在路徑上，` +
              `接回來的模式一個位元組都影響不到。`,
          );
        }
        // 核准政策同樣從日誌來（#437），續接就給滿（日誌沒記的照 `ask`，見 `approvalPolicyOnResume`）。
        const resumedApprovalPolicy =
          history === undefined ? undefined : approvalPolicyOnResume(history.events);
        const effective = {
          ...invocation,
          ...(resumedSandbox !== undefined && { sandbox: resumedSandbox }),
          ...(resumedApprovalPolicy !== undefined && { approvalPolicy: resumedApprovalPolicy }),
        };
        // 子代理選模型的政策（#875）：沒有歷史的新會話從設定取樣一次，有歷史的只讀日誌那一份。
        const modelSelectionPolicy = modelSelectionPolicyFor({
          resumedEvents: history?.events,
          setting: modelSelection,
        });
        // 分叉來的（第一次組裝或重啟後續接都一樣）：前綴裡的預覽指著祖先目錄裡的檔，讀取沿祖先找（#1580 Q1 (a)，`fork-stash.ts`）。
        const inheritedStash =
          sessionStore !== undefined && history?.header.isSeeded === true
            ? {
                names: inheritedStashNames(history.events),
                sessions: (await forkAncestors(history.header, coldSessionHeader, warn)).map(
                  (ancestor) => `${sessionStore.directory}\0${ancestor}`,
                ),
              }
            : undefined;
        built = await assembly.create(
          {
            ...effective,
            // 這條 thread 的可寫根（#1774）：入口**明著交**，連 `undefined`（沒有圍堵）也交——鍵在就不退回 `--workspace`（#1775）。
            workspaceRoot: threadWorkspaceRoot,
            // 有私有可寫根時，`--workspace` 退成唯讀共用區（#1775）；舊 thread、沒有圍堵不給。
            ...(placement.sharedRoot !== undefined && {
              sharedWorkspaceRoot: placement.sharedRoot,
            }),
            // 舊 thread 的可寫根就是新 thread 讀的共用區（#1960）。
            ...(placement.rootIsShared === true && { rootIsShared: true }),
            // 插話（#710）：只有 serve 有，見 `createCliAgent` 那一格。
            stepInbox: true,
            ...(modelSelectionPolicy !== undefined && { modelSelectionPolicy }),
            // 背景續行（#841）：只有 serve 有可以叫醒的一輪，見 `createCliAgent` 那一格。
            ...(backgroundSubagents.backgroundMode === 'continuable' && {
              backgroundSubagents: {
                maxActive: backgroundSubagents.maxActiveSubagents,
                // 重啟之前派出的背景子代理，收到話才接回來（#1271）；落盤關掉（#612）就沒有東西可接。
                ...(sessionStore !== undefined && { cold: createColdChildStore(sessionStore) }),
              },
            }),
            liveModel,
            ...(requestGate !== undefined && { requestGate }),
            credentials,
            threadTitle,
            threadTitleLlm,
            optionalEntries: threadList.optionalEntries,
            // 附件（#732）：模型讀上傳檔案的唯讀路由；儲存是這台 server 一份，每條 thread 的 agent 各掛一條路由。
            attachments: attachmentStore,
            // 會話鑰匙：這台 server 的專案日誌目錄加 thread id——重開之後同一條 thread 回到同一個目錄
            // （`resumeThread` 用的也是這兩個）。沒有會話日誌就不能續接，暫存維持記憶體。
            ...(sessionStore !== undefined && {
              toolResultStash: {
                rootDir: stashRoot,
                session: `${sessionStore.directory}\0${threadId}`,
                warn,
                ...(inheritedStash !== undefined && { inherited: inheritedStash }),
              },
              ...(spillPolicy.maxInlineTokens !== undefined && {
                spillPolicy: { maxInlineTokens: spillPolicy.maxInlineTokens },
              }),
            }),
          },
          {
            plugins: threadList.plugins,
            // 帳是這台 server 的，不是這條 thread 的：第二條 thread 的第一次借第一條的（#702）。
            // 不變量違規走伺服器日誌的 error 等級（#1534）：logger 名 `invariant`，文字就是 runner 預設 `console.error` 印的那一句。
            session: {
              tokenAnchorBook,
              mcpPool,
              onInvariantViolation: (error) => {
                invariantLogger.error(error.message);
              },
              ...(invariantTap !== undefined && { invariantTap }),
            },
          },
        );
      } catch (error) {
        // 這一條組裝時必掛的列掉了：這條 thread 建不起來之前，先把那一筆記進紀錄（#1414；等鎖上限 2 秒）。
        if (error instanceof AssemblyDropError && assembledFrom !== undefined) {
          // 「新掉」同重讀那一支的判斷（#1423）：上一次組裝或重讀還掛著、這一次掉了。
          const fresh = threadPluginList.noteAssemblyFailure(error.dropped);
          failureRecorder.note(
            failedRowsOf(assemblyDropsOf(assembledFrom.loaded, error.dropped), fresh),
            'thread-assembly',
          );
          await failureRecorder.flush();
        }
        await release().catch(() => {});
        throw error;
      }
      const newlyDropped = threadPluginList.noteDropped(threadList, built.dropped);
      failureRecorder.note(
        failedRowsOf(assemblyDropsOf(threadList.loaded, built.dropped), newlyDropped),
        'thread-assembly',
      );
      // **啟動時沒掉、這一條組裝時才掉的列**（卡上第 6 項，例如跟這條 thread 的工作區有關的 `apply`）：同一套規則，
      // 只作用在這一條——可少掛的在這條 thread 裡不掛、伺服器日誌記一筆；不能少掛的已經在上面讓這條 thread 建不起來。
      for (const drop of assemblyDropsOf(threadList.loaded, built.dropped)) {
        warn(`[組裝] thread "${threadId}" 這一條沒掛上：${describeDrop(drop)}`);
      }
      // 外掛交出的警告同理逐條記（例如 MCP 連不上）：連線池在背景重試，還沒連上的期間每條組裝都記一行，連上之後組的就不記。
      for (const line of describeWarnings(threadList.loaded, built.warnings)) {
        warn(`[組裝] thread "${threadId}" 警告：${line}`);
      }
      // 續接時日誌記的檔案政策比權限表裡每一組都寬，接上日誌時會被收回預設組（#1621）：伺服器日誌留一行，部署方看得出為什麼這條對話的權限變了。
      if (built.permissionNarrowed !== undefined) {
        warn(
          `[權限] thread "${threadId}" ${describePermissionNarrowing(built.permissionNarrowed)}`,
        );
      }
      // 冷復活的背景子代理叫醒時，委派快照比權限表裡每一組都寬就收回預設組（#1739）：叫醒發生在組裝之後，所以是訂閱；每個子代理一個行程只留一行。
      built.onDelegationNarrowed((event) => {
        // 權限被收回：一律 warn（與上面 thread 層的 `[權限]` 同一條規則，PM 定），門檻調到 warn 的共用主機看得到。
        warn(`[權限] thread "${threadId}" ${describeDelegationNarrowing(event)}`);
      });
      // 組裝之後這條 thread 的外掛執行期交出的話（例如 MCP 掉線重連的進度，#1099）同樣逐條記；組裝收掉時註冊表一起沒了。
      built.onWarning((warning) => {
        for (const line of describeWarnings(threadList.loaded, [warning])) {
          warn(`[外掛] thread "${threadId}"：${line}`);
        }
      });
      // **對話從日誌推回模型**（#306），同 CLI 的 `--resume`，在這條 thread 的第一輪之前。灌不進去就讓它
      // 起不來（理由見 `conversation-restore.ts`）：剛建好的 agent 與續接那把租約都要收掉，下一次請求才重試得了。
      if (history !== undefined) {
        try {
          const replay = await restoreConversation(built.agent, threadId, history.events);
          log(
            fork !== undefined
              ? `[會話日誌] thread "${threadId}" 從 "${fork.sourceHeader.id}" 分叉出來：${formatConversationRestore(replay)}`
              : `[會話日誌] thread "${threadId}" 接回來了：${formatConversationRestore(replay)}`,
          );
        } catch (error) {
          await built.dispose().catch(() => {});
          await release().catch(() => {});
          throw error;
        }
      }
      // **組裝與續接都成功了才綁**（#1442）：這條 thread 握著的那一份宣告，進「活著的設定版本」那張表。只綁 root thread id，
      // 子代理沿用這一份清單。放掉只動記憶體（下面 `dispose`）：關機時整批拆掉，不各自寫一次快照。
      const releaseLiveVersions = await threadPluginList.bindThread(
        threadId,
        threadList,
        built.dropped,
      );
      const {
        agent,
        commands,
        projections,
        dispose,
        attachSessions,
        feedback,
        workspaceChanges,
        permissionPresets,
        subagentKinds,
        modelSelection: threadModelSelection,
        goals,
        workspaceRoot,
        attachTitle,
        stepInbox,
        spillStore,
      } = built;
      return {
        agent: agent as unknown as PumpAgent,
        stepInbox,
        // 外溢存檔服務（#1553 N0948）：引用別的會話被截斷時全文存這裡。沒開會話日誌就沒有暫存，缺席。
        ...(spillStore !== undefined && { spillStore }),
        // **`createCliAgent` 一直都回著這個註冊點，這條路以前把它丟掉了。**
        // 撿起來就是 web 那端打得到 `/plan` 的全部
        // （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）；發派面本身在
        // `wire-handler.ts` 的 `threadFor`，一條 thread 一個執行器。
        commands,
        // 插件投影（#1026）：pump 即時折、歷史路由折同一份清單。
        projections,
        // 評分與評語（#278）：沒掛 plugin 的組裝就缺席，那時三個回饋 method 回 `not_supported`。
        ...(feedback !== undefined && { feedback }),
        // 每一輪的改動摘要（#443）：沒給 `--workspace` 就缺席，兩條 `changes` 路由一律 404。
        ...(workspaceChanges !== undefined && { workspaceChanges }),
        // 權限組合的目錄（#437）：沒圍堵就缺席，`permission.catalog` 回 `not_supported`。
        ...(permissionPresets !== undefined && { permissionPresets }),
        // 可點名的子代理（#328 第 2 項）：`subagent.list` 與 `run.start` 的 `mention` 驗證讀這一份。
        subagentKinds,
        // `/名字` 叫得出的技能（#1574 N0929）：來源、backend 與「有沒有磁碟根」都讀這條 thread 的 fs 把手（#1919），在 `skill.list` 打進來的當下。
        skillCatalog: createSkillCatalog({
          fs: () => tree.threadSessions.fsForThread(threadId),
          warn: (message) => warn(`[技能] thread "${threadId}" ${message}`),
        }),
        // 每會話模型選擇（#723）：沒帶 `--live` 就缺席，`model.catalog`／`model.select` 回 `not_supported`。
        ...(threadModelSelection !== undefined && { modelSelection: threadModelSelection }),
        // 交付讀檔方法的錨（#452）：沒給 `--workspace` 就缺席，兩支方法一律 no-anchor。
        // **這個值由 `createCliAgent` 算、從這裡原樣轉交**，呼叫端不再寫一次 `resolve(cwd, ...)`。
        ...(workspaceRoot !== undefined && { workspaceRoot }),
        // 續接線**以下**那些交付的錨（#519）：**來自磁碟上那份 header，不是這一次的
        // `--workspace`**。沒續接、或那份 header 沒記那一格（13 以前的日誌都沒有，而且續接
        // 不回填）就整個不給，那時線以下的每一顆照舊 404——判準是那一格在不在，不是
        // `header.version`，理由見 `wire-handler.ts` 的 `locateAt`。
        ...(history?.header.workspaceRoot !== undefined && {
          resumedWorkspaceRoot: history.header.workspaceRoot,
        }),
        // 落盤沒接上就被收掉（建 thread 途中失敗）的話，續接那個把手還在這裡，要自己放。
        dispose: async () => {
          releaseLiveVersions();
          // 放不掉不該擋住收 agent——它底下可能有子行程。
          await release().catch(() => {});
          await dispose();
        },
        ...(history !== undefined && { rootSeed: history.events }),
        attachSessions,
        // LLM 標題（#650）：沒帶 `--live` 或那一列關掉就缺席，只剩退回標題。
        ...(attachTitle !== undefined && { attachTitle }),
        // **落盤的答案不在 `createCliAgent` 的回傳值裡**，它來自呼叫方式而不是 plugin
        // 清單，所以在這個閉包裡接（見 `wire-handler.ts` 的 `attachPersistence`）。
        // **旗標決定給不給，不是給一個關著的**：`goalDriver` 缺席就是「這條 thread 不
        // 自己排輪次」，同 `attachPersistence` 用缺席表達「沒開落盤」的規矩。
        // 人改目標的把手（`goal.pause`，#1516）：**不看 `--no-goal-driver`**，暫停是 goal 服務自己的事，不經排程器（dsh 同）。
        ...(goals !== undefined && {
          goalControl: (log: () => SessionLog) => {
            const port = goalDriverPort(
              goals,
              log,
              () => Promise.resolve(),
              () => undefined,
            );
            return { goal: port.goal, pause: port.pause };
          },
        }),
        ...(invocation.goalDriver
          ? {
              // **`goals` 是這一條 thread 自己那一次組裝的**：`createCliAgent` 每條
              // thread 各跑一次（`:341`），所以兩條 thread 的目標從此分得開（#459）。
              // 轉進 `waitForChildren` 的那一層是具名的 `serveGoalDriver`，有自己的測試（#1575 W4）。
              goalDriver: serveGoalDriver(goals, warn, goalRoundCap),
            }
          : {}),
        // 落盤關掉（#612）就不給：日誌只在註冊表的記憶體裡，同 CLI 那一支。
        ...(sessionStore === undefined
          ? {}
          : {
              attachPersistence: (sessions: SessionRegistry) => {
                const persistence = attachSessionPersistence(sessions, sessionStore, {
                  cwd,
                  // 這條 thread 實際掛的那一份清單（#1405），不是啟動那一份。
                  ...(headerMetadataOf !== undefined && {
                    buildMetadata: headerMetadataOf(threadList.loaded.entries),
                  }),
                  // 模型型錄 id 只進 root（#1025）；假模型不是型錄裡的一筆，不寫。
                  ...(invocation.live && { rootModelEntryId: liveModel.modelId }),
                  // 批次窗口：起動期解出來的那一份（`runServe` 頂上那一行），一台伺服器一個節奏。
                  windowMs: persistenceWindow.windowMs,
                  // 錨（#504）：同 CLI，取的是這一次組裝真的用的那一個（上面從 `built`
                  // destructure 出來的）。沒給 `--workspace` 就不寫那一格。
                  ...(workspaceRoot !== undefined && { workspaceRoot }),
                  // 續接：root 那一份往原檔續寫，只寫還沒存的後綴（第一筆就是 `session/end-seed`）。
                  ...(resumed !== undefined && {
                    resumedRoot: {
                      stored: resumed.stored,
                      storedCount: SessionLogOffset(resumed.events.length),
                      // 讀回來的 header 交給 `rootHeader()`：搜尋拿它跟盤上那份比（#1599）。
                      header: resumed.header,
                    },
                  }),
                  // 分叉（#1580）：新建的 header 標來源與 `isSeeded`。seed 不另外寫：協調器沒有已存筆數，第一次 flush 把整份寫出去
                  // （同 dsh 發佈時 `appendUnstoredSuffix` 從 0 寫起）。
                  ...(fork !== undefined && {
                    rootLineage: { parentSession: fork.sourceHeader.id, isSeeded: true },
                  }),
                  // CLI 那條走 `Printer` 是為了前綴分得出誰在講話；這裡沒有那個問題，
                  // 伺服器日誌本來就沒有跟誰搶終端機（同不變量那條的理由）。
                  warn: (message) => {
                    warn(`[會話日誌] ${message}`);
                  },
                });
                // **協調器真的接上之後**，續接那個把手才歸它收（它的 `dispose` 會關）。先設的話，這一步
                // 拋錯時旗標已經說「交出去了」，`release()` 變成 no-op，租約留到行程結束。
                handedOff = true;
                return persistence;
              },
            }),
      };
    },
  });

  const opsEndpoints = createOpsEndpoints({
    isClosing: () => closing || handler.isClosing(),
    probes: opsConfig.probes.enabled,
    ...(opsMetrics !== undefined &&
      metricsToken !== undefined && {
        metrics: { token: metricsToken, render: () => opsMetrics.render() },
      }),
  });

  let server: WireServer;
  try {
    server = await startWireServer({
      handler: routeBySurface(
        handler,
        createWebStaticHandler({ distRoot: webDist, auth }),
        opsEndpoints,
      ),
      port: invocation.port,
      ...(invocation.compression !== undefined && { compression: invocation.compression }),
      // 一個請求處理失敗（畸形的網址、讀檔錯誤）：記進伺服器日誌、回 400，行程照跑。見 `wire-server.ts`。
      // 方法與 pathname 一起記（#1536）：管理者才對得回是哪一個請求；pathname 不含 query，權杖不進日誌。
      warn: (error, request) => {
        warn(`[請求] ${request.method} ${request.path} 處理失敗，回 400：${error.message}`);
      },
      // 下行串流的心跳間隔與斷線的那一行 warn（#1504）。**另開一個選項，不借上面的 `warn`**：那一個會把每則訊息包成「處理失敗，回 400」。
      heartbeatIntervalMs: downlink.heartbeatIntervalMs,
      warnDisconnect: warn,
      // 請求計數（#1535）：回完每個請求算一次，面按路徑分（跟路由同一份判斷）。
      ...(opsMetrics !== undefined && {
        onResponse: ({ path, status }: { path: string; status: number }) =>
          opsMetrics.recordRequest(surfaceOf(path), status),
      }),
    });
  } catch (error) {
    // 啟動失敗的收尾：先保住原本的錯（收尾的錯記進伺服器日誌，不蓋掉它），`threadSearch` 照樣收（#1511）。
    try {
      await handler.close();
    } catch (closeError: unknown) {
      fail(`[啟動失敗] 收尾也出錯：${errorChain(closeError)}`);
    }
    // 等已接受的搜尋靜止才關（#1552 N0836）；它不 reject，蓋不掉原本的錯。
    await threadSearch?.close();
    throw error;
  }

  // **這一行是敏感輸出**（dsh 決策筆記「后果」）：token 在這個行程活著的期間都換得到 cookie。
  // 只印這一次，別處不重複。
  const authenticatedUrl = auth.authenticatedUrl(server.url);
  log(`nexus-agent 在 ${authenticatedUrl}`);
  // 印的是這一次真的用的那一個（#545），不是預設值。
  log(`模型：${invocation.live ? liveModel.modelId : '假模型（ScriptedChatModel）'}`);
  log(
    `plugin：${
      plugins
        .filter((entry) => !droppedEntries.has(entry))
        .map((entry) => entry.plugin.name)
        .join('、') || '（空）'
    }`,
  );
  log(
    existsSync(join(webDist, 'index.html'))
      ? `網頁：${webDist}`
      : `網頁：${webDist}（還沒 build——先跑 pnpm build，不然開網址只會看到 404）`,
  );
  // grep 用的是產物內附的 ripgrep（#1502 刀 4）：講出是哪一支。缺了壞了不讓啟動失敗（照 dsh，rg 路徑是延遲解析的），
  // 但每一次 grep 都會以 SEARCH_FAILED 失敗、沒有退路——管理者要在啟動這一行就看得到，不必等模型第一次搜尋。
  log(formatRipgrepDisclosure(await ripgrepStatus()));
  reportSandboxTo(log);
  // 同上：沒有沙箱時 grep、glob 與改動卡的 git 跑不了，別等到模型第一次用它們才知道。
  log(await productSandboxStatus());
  // **披露，不是設定。** 每一條 thread 的對話都會寫上磁碟（#444 起預設就寫），寫去哪裡
  // 不該要讀文件才知道；清單把落盤關掉（#612）時，講的是「只在記憶體裡」與是哪一列關的。
  log(
    sessionStore === undefined ? SESSION_LOG_OFF_DISCLOSURE : `會話日誌：${sessionStore.directory}`,
  );
  // 同一條規矩底下的另一行：**這一輪結束之後還會不會有下一輪**。這台 server 上它是
  // per-thread 的行為，但旗標是整個 process 的，所以講在這裡。
  log(formatGoalDriverDisclosure(invocation.goalDriver, goalRoundCap, 'serve'));
  // 上限講出來（#1476）：一律印數字（#1619 起出廠就有值），管理者從這一行分得出出廠值和自己改過的值。
  log(
    `thread 上限：${String(threadCapacity.maxThreads)}（到了拒收新 thread，${
      idleEvictMs === undefined ? '要重啟 serve 才釋放' : '閒置的 thread 被撤掉才釋放名額'
    }）`,
  );
  // 轉碼併發講出來（#2033）：讀的是附件儲存手上那一份限流器，不是設定值。
  log(`圖片轉碼併發：${String(attachmentStore.compression.concurrency)} 張（超過的排隊）`);
  // 一輪的時鐘講出來（#1624）：出廠就有值，關掉那一列是管理者明著拿掉的，兩種都印。
  log(
    turnClock === undefined
      ? '一輪的時鐘：不限（turn-timeout 那一列關掉了）'
      : `一輪的時鐘：${String(turnClock.timeoutMs)} 毫秒（主對話與背景子代理的每一輪各自起算，到點照停止鍵的路中止）`,
  );
  // 探針與指標講出來（#1535）：不印 token 本身，只印在哪個檔。
  log(
    `探針：${opsConfig.probes.enabled ? '/livez、/readyz（免登入、只回狀態字）' : '關'}；指標：${
      metricsToken === undefined
        ? '關'
        : `開 /metrics（要 Authorization: Bearer，token 在 ${opsConfig.metrics.tokenFile ?? metricsTokenFile}）`
    }`,
  );
  // 模型請求並行上限講出來（#1505）：不設就印「不限」。沒連真實供應商（假模型）時閘不會被用到，也照實講出設定值。
  log(
    requestGate === undefined
      ? '模型請求並行上限：不限'
      : `模型請求並行上限：${String(requestGate.maxConcurrent)}（整台 serve 共用；名額滿了排隊，等超過 ${String(liveModel.maxWaitMs)} 毫秒以 LOCAL_CAPACITY 失敗、不重試）`,
  );
  // 閒置逐出講出來（#1484）：一律印一行，三種之一（#1619）。設成 0 先講——那是管理者明著關的，有沒有落盤都一樣不逐出。
  // 沒落盤那一句是中性的：出廠就有 T，沒落盤的部署每次啟動都會印它，不是管理者設錯了什麼。
  log(
    threadCapacity.idleEvictAfterMs === 0
      ? 'thread 閒置逐出：idleEvictAfterMs 是 0，不逐出'
      : idleEvictMs === undefined
        ? 'thread 閒置逐出：沒有落盤，不逐出（會話日誌只在記憶體裡，撤掉的 thread 回不來）'
        : `thread 閒置逐出：閒置 ${String(idleEvictMs)} 毫秒後撤出記憶體（日誌在磁碟上，再開這條 thread 會照重啟後的路徑重組）`,
  );
  for (const line of formatTracingDisclosure(readTracingDisclosure(env))) {
    log(line);
  }
  // **遙測披露印在啟動時**（#749），同 CLI 緊接在追蹤那一行後面、分兩行講（理由見 `telemetry-disclosure.ts`）。
  // 以前印在第一條 thread 組起來時，因為那之前沒有人知道掛了什麼；上面那一次試組之後答案就在了，管理的人起
  // serve 的那一刻就看得到，不必等第一個人開對話。
  for (const line of formatTelemetryDisclosure(telemetrySharing)) log(line);
  // 會話日誌的位元組額度講出來（#2115）：自動算的最晚在這裡算；起動披露之前沒有請求讀過日誌的話，「現在的 RSS」就是
  // serve 起動完的底。
  // 沒落盤就沒有日誌要讀，不印。
  if (sessionStore !== undefined) {
    const { limitBytes } = sessionLogBudget;
    log(
      limitBytes === Number.POSITIVE_INFINITY
        ? '會話日誌額度：不限（thread-capacity 的 sessionLogBudgetMiB 是 0；大日誌可能把整個行程撐死）'
        : `會話日誌額度：${(limitBytes / 1024 / 1024).toFixed(1)} MiB（同時開著與正在讀的會話日誌合計，超過的在讀之前拒收；${
            configuredLogBudgetMiB === undefined || options.sessionLogBudget !== undefined
              ? '照容器記憶體上限與 --max-old-space-size 自動算'
              : 'thread-capacity 的 sessionLogBudgetMiB 設的'
          }）`,
    );
  }
  // 已儲存 vs 執行中的對照（#1406）：寫成功才講，寫不進去的警告已經在上面記過。
  if (startupSnapshotWritten) log(describeSnapshot(startupSnapshot, pluginSnapshotPath(env)));

  // 記憶體量具（#1490）：放在所有起動披露之後，讓第一行讀數是 serve 全部起來之後的樣子。關著（預設）就一個字都不印、不建計時器。
  const memoryGauge =
    memoryGaugeConfig.reportIntervalMs === 0
      ? undefined
      : startMemoryGauge({
          intervalMs: memoryGaugeConfig.reportIntervalMs,
          log,
          warn,
          ...(options.memoryGaugeDeps === undefined ? {} : { deps: options.memoryGaugeDeps }),
          // 用量警告（#1493，保險絲第 0 級）：跟著取樣開關走，取樣關著這一整段不建。
          onReading: createMemoryPressureWatch({
            thresholdPercent: memoryGaugeConfig.warnAtPercent,
            sources: [memoryUsageSource, heapUsageSource],
            context: () => ({
              threadCount: handler.threadCount(),
              maxThreads: threadCapacity.maxThreads,
            }),
          }).observe,
        });

  return {
    url: server.url,
    authenticatedUrl,
    close: async (options) => {
      // `/readyz` 在 server 關掉之前就回 503（#1535）：監管程式看到 closing 就別再送新請求。
      closing = true;
      // 會開新一輪的命令從這一刻起回 `server_closing`（#1787）：立旗與時間窗之間不留縫，窗裡才不會再收新的一輪、在窗末被切斷。
      // 致命例外的收尾（`drain: false`）一樣先停准入。
      handler.stopAdmission();
      // **時間窗**（#1777）：立旗之後 listener 要再照常在聽一小段，探針才抓得到 503。`server.close()` 一開頭就 `closeAllConnections()`
      // （`wire-server.ts`），不留這一段，旗標只在同一個 macrotask 裡亮過，沒有任何請求看得到。**只有 `/readyz` 被抓過才等**：
      // 沒有監控在看，等了也沒人聽（測試與一次性使用不付這個代價）。時間窗屬於整體 5 秒收尾上限（#599），所以設定上限 2000。
      // 致命例外的收尾（`drain: false`）不等：理由見 {@link RunningServe.close}。旗標照立，`/readyz` 照回 503。
      if (
        options?.drain !== false &&
        opsConfig.probes.enabled &&
        opsConfig.probes.drainMs > 0 &&
        opsEndpoints.readyzProbed()
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, opsConfig.probes.drainMs));
      }
      // **每一步各自接住，全部跑完才拋**（#1511）：`handler.close()` 現在會拒絕（thread 收尾失敗），
      // 不能讓它擋住 `threadSearch` 與 `failureRecorder.flush()`。錯誤交給 `main` 印。
      const failures: unknown[] = [];
      const attempt = async (run: () => void | Promise<void>): Promise<void> => {
        try {
          await run();
        } catch (error: unknown) {
          failures.push(error);
        }
      };
      await attempt(() => memoryGauge?.stop());
      await attempt(() => opsMetrics?.stop());
      await attempt(() => server.close());
      await attempt(() => handler.close());
      await attempt(() => threadSearch?.close());
      // 背景還在寫的 `failed`：收完再回，不然關掉之後（測試刪暫存目錄）才落地。不 reject。
      await attempt(() => failureRecorder.flush());
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `serve 收尾有 ${String(failures.length)} 步失敗：${failures.map(errorChain).join('; ')}`,
        );
      }
    },
  };
}

/** {@link installServeProcessLifecycle} 需要的那一片 `process`：fail-loud 那幾個事件，加上兩個訊號與退出碼。 */
export type ServeProcess = FailLoudProcess & {
  on(event: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
  exitCode: number | string | null | undefined;
};

/** {@link installServeProcessLifecycle} 交回的把手。 */
export interface ServeProcessLifecycle {
  /** `runServe` 起來之後交進來。之前的訊號與致命例外沒有東西可收，直接結束。 */
  attach(running: RunningServe): void;
  /** 解除 fail-loud 的兩個 handler（訊號的不解除，行程結束前都在）。 */
  uninstall(): void;
}

/**
 * 行程層的收尾：**訊號與致命例外共用同一份、記住自己的 dispose**（[#1501](https://github.com/DemianLi/nexus-agent/issues/1501)，
 * 照 dsh `apps/cli/src/profile-boot.ts:282-311`）。
 *
 * - 訊號（`SIGTERM` 回 0、`SIGINT` 回 130）走 {@link createProcessShutdown}：5 秒上限、收尾中再來一次就當場結束（#599）。
 * - 未處理的 rejection／未捕捉的例外走 {@link installFailLoud}：印一行帶標籤的診斷，最多等 2 秒走**同一份** dispose，
 *   然後以 1 結束。**不讓 serve 存活**：一條 thread 的半套狀態被其他人繼續用，比全部重連更糟。
 * - 兩邊等同一顆 promise，所以收尾進行中來另一邊，`running.close()` 只跑一次；退出碼以**先到的**為準
 *   （誰先開始收尾，誰的 `.then` 先掛在那顆 promise 上、先叫 `exit`；兩個 handler 的註冊順序不影響，同 dsh）。
 *
 * **在 `main()` 裡、`runServe` 之前裝，不在 `runServe` 裡裝**：`runServe` 被許多測試在 vitest 行程裡直接叫，它們自己掛
 * `unhandledRejection` 計數，裝在裡面會搶走那些測試的判準、還會叫真的 `process.exit`。
 *
 * @param proc - 要註冊的行程；測試注入假的。
 * @returns 把手：`runServe` 起來之後 `attach`。
 */
export function installServeProcessLifecycle(proc: ServeProcess = process): ServeProcessLifecycle {
  let running: RunningServe | undefined;
  let disposal: Promise<void> | undefined;
  // **誰先開始收尾誰決定要不要等 `/readyz` 時間窗**：訊號等（#1777），致命例外不等（#1787）。兩邊仍共用同一顆 promise，
  // 所以訊號先到、致命隨後時，致命路徑也在同一個收尾裡（它自己的 2 秒上限仍在 `installFailLoud`）。
  const disposeWith = (drain: boolean): Promise<void> =>
    (disposal ??= (async () => {
      if (running === undefined) return;
      try {
        await running.close({ drain });
      } catch (error) {
        // 控制器在收尾失敗時只強制結束、不講原因；會話日誌寫不下去是這裡最該聽見的那種。
        console.error(error instanceof Error ? error.message : String(error));
        throw error;
      }
    })());
  // Ctrl-C 要走完 dispose：子行程與檔案控制代碼都掛在那裡。**第二次訊號當場結束**、
  // 收尾有上限，照 dsh（`process-shutdown.ts`，#599）。所以用 `on` 不用 `once`：`once`
  // 用掉之後第二次落回預設動作，是同一個結果但不是政策。
  const shutdown = createProcessShutdown(
    () => disposeWith(true),
    (code) => {
      proc.exit(code);
    },
    (code) => {
      proc.exitCode = code;
    },
  );
  // SIGTERM 是監管者的一般停止要求，回 0；SIGINT 是使用者中斷，回 130（同 dsh 的 `profile-boot.ts`）。
  proc.on('SIGTERM', () => {
    shutdown.interrupt(0);
  });
  proc.on('SIGINT', () => {
    shutdown.interrupt(130);
  });
  const uninstall = installFailLoud('nexus-agent serve', proc, () => disposeWith(false));
  return {
    attach(next) {
      running = next;
    },
    uninstall,
  };
}

async function main(): Promise<void> {
  const lifecycle = installServeProcessLifecycle();
  try {
    const running = await runServe({ argv: process.argv.slice(2) });
    if (running === undefined) {
      lifecycle.uninstall();
      return;
    }
    lifecycle.attach(running);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// 用 `import.meta.main`，不比路徑（照 dsh `apps/cli/src/bin.ts:76-78`）：裝好之後經 `node_modules/.bin` 的符號連結啟動時，
// `argv[1]` 是連結、`import.meta.url` 是真實路徑，比路徑會靜靜不執行、以 0 結束。
if (import.meta.main) {
  await main();
}
