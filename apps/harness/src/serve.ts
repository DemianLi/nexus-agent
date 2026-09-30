/**
 * 把 agent 掛上 HTTP，給 `apps/web` 連。
 *
 *   pnpm --filter @nexus/harness run serve             # 假模型
 *   pnpm --filter @nexus/harness run serve:live        # 換成真實供應商
 *
 * **組裝完全沿用 CLI 的那一份**（`createCliAgent`）：同一份預設 plugin 清單、同一個
 * `--live` 開關、同一個 `--workspace`。理由是這裡沒有新的組裝決定要做——「web 要跑
 * 哪些 plugin」與「CLI 要跑哪些 plugin」是同一個問題，而它的答案住在同一份清單上：出貨的
 * `cordis.yml`，疊上 `$NEXUS_AGENT_HOME/cordis.patch.yml` 與 `--patch`
 * （[#454](https://github.com/DemianLi/nexus-agent/issues/454)、
 * [#455](https://github.com/DemianLi/nexus-agent/issues/455)）。
 *
 * **一個 thread 一個 agent，關掉 server 時一起清。** `createNexusAgent` 回的
 * `dispose` 在這裡才真的有意義——MCP plugin 底下是 stdio 子行程，而這是一個長命的
 * 行程，漏了不會有任何錯誤訊息。啟動時另外先組一份、驗完就收（#749），清單上哪一列壞了
 * 在綁 port 之前就講，不等第一條 thread；那一次掉了的列，之後每條 thread 都直接算沒掛（#751）。
 *
 * 假模型下的限制與 CLI 的 REPL 一樣：`CLI_SCRIPT` 只有四輪，問到後面
 * `ScriptedChatModel` 會當場失敗而不是靜默重播。**那個失敗會以
 * `lifecycle failed` 上線**，所以瀏覽器那端看得到原因，不是一片空白。
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THREADS_PATH } from '@nexus/wire';
import type {
  PluginEntry,
  ResumedStoredSession,
  SessionLog,
  SessionRegistry,
  SessionStore,
} from '@nexus/core';
import { AssemblyDropError } from './agent-factory.js';
import {
  assertPersistenceFlags,
  createCliAgent,
  parseSandboxMode,
  formatGoalDriverDisclosure,
  goalDriverPort,
  resolveSessionLogDir,
  resolveWorkspaceRoot,
  SESSION_LOG_OFF_DISCLOSURE,
} from './cli.js';
import { formatConversationRestore, restoreConversation } from './conversation-restore.js';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import { listStoredThreads } from './session-list.js';
import {
  attachSessionPersistence,
  sessionPersistencePlugin,
  SessionNotFoundError,
} from '@nexus/core';
import { assertSameCwd, assertSameWorkspaceRoot } from './resume-guards.js';
import { recordedSandboxMode } from '@nexus/plugin-sandbox-policy';
import { installLaunchProxy } from './http-proxy-boot.js';
import { processLaunchEnv } from './launch-env.js';
import { DEFAULT_LIVE_MODEL_ID, loadLiveLaunchEnv } from './live-model.js';
import type { LiveLaunch } from './live-model.js';
import type { PumpAgent } from './thread-pump.js';
import type { SandboxMode } from './contained-backend.js';
import { BrowserAuth } from './browser-auth.js';
import { loadOrCreateBrowserSessionSecret } from './browser-session-secret.js';
import { createProcessShutdown } from './process-shutdown.js';
import { HARNESS_HOME_ENV, resolveHarnessHome } from './harness-home.js';
import { createWebStaticHandler } from './web-static.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';
import { startWireServer } from './wire-server.js';
import type { WireServer } from './wire-server.js';
import { loadDefaultPlugins, renderDefaultConfigDump } from './plugin-config.js';
import {
  assemblyDropsOf,
  auditStartupEntries,
  describeDrop,
  describeWarnings,
  dropReasonsOf,
  optionalEntriesOf,
  startupErrorFrom,
  startupWarning,
} from './startup-audit.js';
import { browserSessionPlugin } from './settings/browser-session.js';
import { deliverableFilesPlugin } from './settings/deliverable-files.js';
import { liveModelPlugin } from './settings/live-model.js';
import { startupEntryMounted, startupSetting } from './settings/startup.js';
import { resolveToolResultStashRoot, toolResultStashPlugin } from './settings/tool-result-stash.js';
import { toolTextPlugin } from './settings/tool-text.js';
import { cleanupToolResultStash } from './tool-result-stash.js';
import { threadTitlePlugin } from './settings/thread-title.js';
import { threadTitleLlmPlugin } from './settings/thread-title-llm.js';
import { threadSearchPlugin } from './settings/thread-search.js';
import { SessionReferenceCandidates } from './session-reference-candidates.js';
import { ThreadSearch } from './thread-search.js';
import { formatTelemetryDisclosure } from './telemetry-disclosure.js';
import { formatTracingDisclosure, readTracingDisclosure } from './tracing.js';

/** 預設 port。挑一個不常撞的，`--port` 蓋得掉。 */
export const DEFAULT_PORT = 8787;

export interface ServeInvocation {
  readonly live: boolean;
  readonly port: number;
  readonly workspace?: string;
  /** 見 `cli.ts` 的 `CliInvocation.sandbox`。**兩個入口共用同一個旗標名、同一份驗證、同一個預設**。 */
  readonly sandbox?: SandboxMode;
  /** 見 `cli.ts` 的 `CliInvocation.patches`。**兩個入口共用同一個旗標名、同一份驗證、同一份疊加。** */
  readonly patches?: readonly string[];
  /** 見 `cli.ts` 的 `CliInvocation.sessionLog`：換位置用，省略即 harness home 底下的 `sessions`。 */
  readonly sessionLog?: string;
  /** 見 `cli.ts` 的 `CliInvocation.goalDriver`。**兩個入口共用同一個旗標名與同一個預設**。 */
  readonly goalDriver: boolean;
  /** 見 `cli.ts` 的 `CliInvocation.dumpConfig`。**兩個入口印的是同一份設定**。 */
  readonly dumpConfig: boolean;
  readonly help: boolean;
}

const USAGE = `用法：
  pnpm --filter @nexus/harness run serve [選項]

選項：
  --live               換成真實供應商（預設 ${DEFAULT_LIVE_MODEL_ID}），需要 API key
  --patch <file>       把這個 patch 檔疊在出貨的 cordis.yml 上（可以給多次，後面的蓋前面的）
                       另一層是 $NEXUS_AGENT_HOME/cordis.patch.yml，它排在 --patch 之前
  --dump-config        把三層疊完的 plugin 設定印出來就退出（不開 server、不載 plugin）
  --workspace <dir>    把檔案落在這個目錄底下（省略即虛擬檔案系統）
  --sandbox <mode>     圍堵強度：read-only｜workspace-write｜danger-full-access
                       預設 workspace-write（可寫根之內放行）；要配 --workspace
  --session-log <dir>  把會話日誌改寫到這個目錄
                       （預設 $NEXUS_AGENT_HOME/sessions，沒設就是 ~/.nexus-agent/sessions）
                       要完全不落盤，在 patch 裡把 session-persistence 那一列寫成 disabled: true
  --port <n>           監聽的 port，預設 ${DEFAULT_PORT}
  --goal-driver        一個 active 的目標沒達成時自己再開一輪（預設關）
                       上限是那個目標自己的 max_goal_rounds
  --help               印這段話

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
        'goal-driver': { type: 'boolean', default: false },
        'dump-config': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
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

  const dumpConfig = values['dump-config'] === true;

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port 要給 0 到 65535 之間的整數，收到 "${values.port}"。\n\n${USAGE}`);
  }

  return {
    live: values.live === true,
    port,
    ...(patches !== undefined && { patches }),
    ...(values.workspace !== undefined && { workspace: values.workspace }),
    ...(sandbox !== undefined && { sandbox }),
    ...(values['session-log'] !== undefined && { sessionLog: values['session-log'] }),
    goalDriver: values['goal-driver'] === true,
    dumpConfig,
    help: values.help === true,
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
}

export interface RunningServe {
  readonly url: string;
  /**
   * 帶著這個行程登入 token 的網址——啟動時印的就是這一個（#424）。在瀏覽器開它，換到會話 cookie。
   */
  readonly authenticatedUrl: string;
  close(): Promise<void>;
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
 * 按路徑把請求分給兩個面（[#424](https://github.com/DemianLi/nexus-agent/issues/424)）。
 *
 * `/threads` 與它底下的路徑給 wire——圍欄、會話 cookie、JSON 閘門都在那裡；其他給網頁的靜態服務。
 * 換 token 的 `GET /?token=` 因此碰不到 wire 的 JSON 閘門（瀏覽器導覽不帶 `content-type`），照 dsh：
 * index 走 `frontend-static` 的 `authorizeIndex`，API 走 `requestRejection`。
 */
function routeBySurface(
  wire: WireHandler,
  web: (request: Request) => Promise<Response>,
): WireHandler {
  return {
    handle: (request) => {
      const { pathname } = new URL(request.url);
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
 * **只有「找不到」准退到新開**（{@link SessionNotFoundError}）。壞檔、版本太新、別的行程
 * 握著都照拋：退到新開的話 `create` 會撞上已存的檔（`wx`），而那個失敗在協調器的背景路徑上
 * 被收成一行 warn——那條 thread 的日誌就這樣沒了，而且沒有人看得到。
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
    return await store.resume(threadId);
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

  // **在開 server 之前印完就走**，同 `cli.ts`：印設定不需要綁 port，也不該因為 port 被佔住
  // 就看不到設定。
  if (invocation.dumpConfig) {
    log(
      renderDefaultConfigDump({
        env: options.env ?? process.env,
        ...(invocation.patches !== undefined && { patches: invocation.patches }),
      }).trimEnd(),
    );
    return undefined;
  }

  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  // **真模型路徑的啟動環境：兩層 `.env`**（#730），排在讀清單與建密鑰之前：壞的 `.env` 與舊位置搬家訊息在
  // server 還沒起來的時候就講。沒帶 `--live` 不讀任何 `.env`。
  const liveLaunch = invocation.live ? loadLiveLaunchEnv({ cwd, env }) : undefined;
  // **對外代理：啟動流程的第一件事**（#746），排在載完環境之後、第一顆外掛載入之前。假模型路徑沒有 `.env`，
  // 用只有行程環境的那一層。server 起不來就當場還原；起來了，收尾跟著 `close()` 走。
  const disposeProxy = await installLaunchProxy(
    liveLaunch?.launchEnv ?? processLaunchEnv(),
    (message) => {
      log(message);
    },
  );
  let running: RunningServe;
  try {
    running = await startServer(options, invocation, liveLaunch, log);
  } catch (error) {
    await disposeProxy();
    throw error;
  }
  return {
    ...running,
    close: async () => {
      try {
        await running.close();
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
  serverLog: (line: string) => void,
): Promise<RunningServe> {
  // `goalDriver` 那個閉包的參數也叫 `log`（它是讀日誌的 getter），所以伺服器日誌在這裡
  // 另取一個名字——同一個函式，只是不讓兩個 `log` 在同一段裡打架。
  const log = serverLog;
  const cwd = options.cwd ?? process.cwd();
  // **瀏覽器會話的密鑰也從這一份 env 解 home**（#424）：日誌根與密鑰落在同一個 home 底下。
  // 密鑰在下面讀：權限過寬、記錄壞掉，都該在 server 還沒起來的時候就講。每次啟動只讀這一次，
  // 之後在記憶體裡驗。
  const env = options.env ?? process.env;
  // **清單只有一個來源：出貨的 `cordis.yml` 加上使用者那兩層**（#454、#455），與 CLI 同一條
  // 路：同一個函式、同一個 home 層、同一組 `--patch`。
  //
  // **它排在瀏覽器會話之前，那是承重的**（[#529](https://github.com/DemianLi/nexus-agent/issues/529)）：
  // cookie 的有效期由清單上 `#settings/browser-session` 那一列講，密鑰讀出來的那一刻就要有它。
  const loaded = await loadDefaultPlugins({
    env,
    ...(invocation.patches !== undefined && { patches: invocation.patches }),
  });
  // **掉了哪幾列在這裡判第一次**（#751），同 CLI 那一刻：必掛的掉了就在這裡起不來——還沒建瀏覽器會話密鑰、還沒綁
  // port。可少掛的掉了先不印，等下面試組那一次補完再合成一段。掉了的列在清單上已標成沒掛，每條 thread 組裝時照樣跳過。
  const audit = { live: invocation.live };
  auditStartupEntries(loaded, audit);
  const plugins: readonly PluginEntry[] = loaded.plugins;
  const optionalEntries = optionalEntriesOf(loaded, audit);
  // **起動期解一次、往下傳一份**：這兩顆都有消費者跑在任何 agent 出生之前（冷讀清單、`BrowserAuth`），那時
  // 還沒有註冊表可以讀服務。標題那兩個數字也往下傳給寫標題的 pump（#647），同一份值。理由與偏離登記見
  // `settings/startup.ts` 的檔頭。
  const browserSession = startupSetting(plugins, browserSessionPlugin);
  const threadTitle = startupSetting(plugins, threadTitlePlugin);
  // 交付檔那三個上限（#529）。**它們是 server 的性質，不是一條 thread 的性質**——兩條交付路由
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
  // 一段工具結果文字放上線的上限（#538）。**同樣是 server 的性質**：兩個消費點（即時的
  // `ThreadPump`、重播的 `historyPage`）都住在 `createWireHandler` 的閉包底下，一個 server 一次。
  const toolTextLimits = startupSetting(plugins, toolTextPlugin);
  // 過大工具結果的暫存（#734）：根與保留天數是 server 的性質，解一次；啟動時清一次超過保留期的會話目錄，
  // 別人改得動的根不清，失敗只記一筆不擋啟動。
  const stashConfig = startupSetting(plugins, toolResultStashPlugin);
  const stashRoot = resolveToolResultStashRoot(stashConfig, env);
  await cleanupToolResultStash(stashRoot, stashConfig.cleanupPeriodDays, { warn: log });
  // 真實供應商的五個連線值（#545）。**model 是一條 thread 一顆**（下面每次 `createCliAgent` 各建
  // 一顆），但設定是 server 的性質：解在這裡，設定寫壞的話在 server 起來之前就失敗，而不是等到
  // 第一條 thread；啟動時印的模型名也從這一份來。
  const liveModel = startupSetting(plugins, liveModelPlugin);
  // LLM 標題那一列（#650），理由同上：標題模型一條 thread 一顆，設定是 server 的性質。沒帶 `--live` 也解——
  // 寫壞的設定不因為這一次用不到就放過，同 `live-model` 那一列。
  const threadTitleLlm = startupSetting(plugins, threadTitleLlmPlugin);
  // 會話內容搜尋那一列（#631）。**掛沒掛與設定分開問**，同 `thread-title-llm`：`disabled: true` 是沒掛（搜尋一律回
  // 失敗），`openAt: never` 是掛了不開（沒東西可搜時回空）。出廠是後者，見 `settings/thread-search.ts`。
  const threadSearchMounted = startupEntryMounted(plugins, threadSearchPlugin);
  const threadSearchConfig = startupSetting(plugins, threadSearchPlugin);
  // **先照每條 thread 那一次組一份，組完就收**（#749）。上面那幾列只驗了自己的設定；其餘每一列的設定、重名、
  // `requires` 缺件、`apply` 裡的值檢查（例如 `tool-result-pruner` 的門檻），不組一次就不會發生，而 serve 的
  // agent 是每條 thread 才組的——不先組這一次，伺服器照樣起來，每個開對話的人才各撞一次，伺服器日誌一行都沒有。
  // 跟下面 `createAgent` 同一個函式、同一組參數，不帶續接，失敗的處理跟 CLI 那一刻（`cli.ts` 的 `createCliAgent`）
  // 同一套：可少掛的列掉了印警告、照樣起來，其餘原樣拋（見下面「判第二次」那段）。
  //
  // **偏離登記**：dsh 的 `boot()` 把 plugin 樹掛一次、一直用下去，驗證是掛載順帶發生的
  // （dsh `packages/boot/app-boot/README.zh.md:92`，`477b4f4`）。我們沒有那棵樹：agent 一條 thread 一份（見檔頭），
  // 這個形狀在這之前就在，不是基座表達不出來。退到這裡：形狀不動，啟動時多組一次、驗完就收，錯誤出現的時刻跟 dsh
  // 一樣在啟動時，代價是每一列的 `apply` 多跑一遍。
  //
  // **位置是承重的**：在讀或建瀏覽器會話密鑰與綁 port 之前，起不來的那一次什麼都還沒留下。收掉失敗也拋，同 CLI
  // 那條：組得起來卻收不乾淨，可能有子行程還活著（`cli-dispose-failure.fixture.ts`）。
  //
  // **掉了哪幾列在這裡判第二次**（#751），同 CLI 那一次組裝：清單上可少掛的列 `apply` 失敗、`requires` 缺件、撞名，
  // 只讓它掉；必掛的、組裝點自己加的外掛掉了，換成跟第一次同一種 `StartupError`。兩次合起來印一段到伺服器日誌，
  // 只印這一次，在綁 port 之前。
  const trial = await createCliAgent(
    {
      ...invocation,
      workspaceChanges: true,
      liveModel,
      ...(liveLaunch !== undefined && { credentials: liveLaunch.credentials }),
      threadTitle,
      threadTitleLlm,
      optionalEntries,
    },
    plugins,
    options.cwd,
  ).catch((error: unknown) => {
    throw error instanceof AssemblyDropError ? startupErrorFrom(loaded, error, audit) : error;
  });
  await trial.dispose();
  for (const line of startupWarning(
    loaded,
    assemblyDropsOf(loaded, trial.dropped),
    trial.warnings,
  )) {
    log(line);
  }
  // **試組掉了的列帶進每條 thread 的組裝，直接算沒掛**（卡上第 6 項）：不再重試、不再每條各印一次。照 dsh：樹只掛
  // 一次，沒起來的條目一直不在，直到改設定重載；我們沒有重載，所以到重啟為止。標成 `disabled: true` 跟讀清單那一次
  // 設定驗不過的列同一個做法，載入器因此記成沒掛。
  const trialDropped = new Set(trial.dropped.map(({ entry }) => entry));
  const threadPlugins = plugins.map((entry) =>
    trialDropped.has(entry) ? { ...entry, disabled: true } : entry,
  );
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
  const webDist = options.webDist ?? resolveWebDist();

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
          // 後端講話（例如這個平台拿不到寫租約）走伺服器日誌，前綴同協調器那條。
          warn: (message) => {
            log(`[會話日誌] ${message}`);
          },
        });

  // 一台 server 一份索引：對帳與查詢在它裡面排隊。沒接落盤時照樣建，搜尋回空（沒有東西可搜）。
  const threadSearch = threadSearchMounted
    ? new ThreadSearch({
        cwd,
        openAt: threadSearchConfig.openAt,
        ...(sessionStore !== undefined && { store: sessionStore }),
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
          warn: serverLog,
        });

  const handler = createWireHandler({
    auth,
    deliverableLimits,
    toolTextLimits,
    threadTitleLimits: threadTitle,
    // 一頁歷史撐破軟上限時（#479）、退回標題寫不進去時（#647）、模型標題寫不成時（#650）講一聲。
    warn: (message) => {
      serverLog(message);
    },
    // **冷讀那一格**（#302）：讀的是續接那條路寫進去的同一格，只列切得過去的——`cwd` 就是續接時
    // `assertSameCwd` 比的那一個。落盤關掉（#612）就整個不給，列表那時講「列不出來」而不是「沒有」。
    ...(sessionStore === undefined
      ? {}
      : {
          listThreads: () => listStoredThreads(sessionStore, { cwd, title: threadTitle }),
        }),
    // `@` 引用別的會話的候選（#713）：冷讀整個會話根，跨專案。落盤關掉就不給，路由那時回 `available: false`。
    ...(sessionReferenceCandidates !== undefined && {
      listSessionReferences: (threadId: string, query: string, signal: AbortSignal) =>
        sessionReferenceCandidates.list(threadId, query, signal),
      // 被 `@` 的會話怎麼讀回來（#713）：同一份索引，pump 領走那句話時用。
      sessionReferenceReader: sessionReferenceCandidates,
    }),
    // 按內容搜（#631）。沒掛那一列就不給，handler 那時一律回「沒掛」。
    ...(threadSearch !== undefined && {
      searchThreads: (query: unknown, signal: AbortSignal) => threadSearch.search(query, signal),
    }),
    // 一個 thread 一個 agent——各自的 checkpointer、各自的虛擬檔案系統。
    createAgent: async (threadId: string) => {
      // **以前寫過就接回來**（照 dsh：碰到一個已存的 session id 就 resume，不另開）。續接在讀
      // 之前就拿了寫租約，要到落盤接上之後才歸協調器收；這中間拋錯要先放掉，不然
      // `wire-handler.ts` 說好的「下一次請求重試」會撞上自己上一次留下的租約。
      const resumed =
        sessionStore === undefined ? undefined : await resumeThread(sessionStore, threadId);
      let handedOff = false;
      const release = async (): Promise<void> => {
        if (handedOff) return;
        handedOff = true;
        await resumed?.stored.close();
      };
      // **第四與第五個引數都刻意不傳，而且理由不同。**
      //
      // 第四個（不變量違規往哪裡講）：這條路徑維持 `createInvariantRunner` 的預設
      // （`console.error`），進的是伺服器日誌。CLI 那條要繞過 `Printer` 才印得出前綴，
      // 這裡沒有那個問題——伺服器日誌本來就沒有跟誰搶終端機
      // （[#107](https://github.com/DemianLi/nexus-agent/issues/107)）。
      //
      // 第五個（核准政策）：**這裡維持預設的「有人在」**。CLI 與 eval 關掉它是因為那兩個
      // 入口收不了核准決定，而 web 這端真的按得下去（[#79](https://github.com/DemianLi/nexus-agent/pull/79)
      // 的核准迴圈，`serve.test.ts` 的「核准那份清單」整條走過一遍）。關掉它會把一個
      // 做得出來的功能關掉（[#113](https://github.com/DemianLi/nexus-agent/issues/113)）。
      let built: Awaited<ReturnType<typeof createCliAgent>>;
      try {
        if (resumed !== undefined) assertSameCwd('serve', threadId, resumed.header, cwd);
        // **再認它跑在哪個工作區底下**（#504）。順序與理由逐字同 CLI 的 `--resume`：目錄先認，
        // 這一道在沙箱那一道之前。根在這裡自己算（`createCliAgent` 還沒跑），走的是同一個
        // `resolveWorkspaceRoot` 與同一個 cwd。
        if (resumed !== undefined) {
          assertSameWorkspaceRoot(
            'serve',
            threadId,
            resumed.header,
            resolveWorkspaceRoot(invocation.workspace, cwd),
          );
        }
        // 同 CLI 的 `--resume`：模式從日誌來；日誌記著模式就表示上一次有 fence，這一次沒有
        // `--workspace` 的話那道 fence 不在路徑上，接回來的 `read-only` 會靜靜蒸發。
        const resumedSandbox =
          resumed === undefined ? undefined : recordedSandboxMode(resumed.events);
        if (resumedSandbox !== undefined && invocation.workspace === undefined) {
          throw new Error(
            `thread "${threadId}" 接不回來：上一次跑在 --workspace 底下（日誌記著沙箱模式 ` +
              `${resumedSandbox}），這台 server 沒給 --workspace，那道 fence 不在路徑上，` +
              `接回來的模式一個位元組都影響不到。`,
          );
        }
        const effective =
          resumedSandbox === undefined ? invocation : { ...invocation, sandbox: resumedSandbox };
        // 每一輪改了哪些檔（#443）：只有 serve 開，見 `createCliAgent` 那一格。
        built = await createCliAgent(
          {
            ...effective,
            workspaceChanges: true,
            // 插話（#710）：只有 serve 有，見 `createCliAgent` 那一格。
            stepInbox: true,
            liveModel,
            ...(liveLaunch !== undefined && { credentials: liveLaunch.credentials }),
            threadTitle,
            threadTitleLlm,
            optionalEntries,
            // 會話鑰匙：這台 server 的專案日誌目錄加 thread id——重開之後同一條 thread 回到同一個目錄
            // （`resumeThread` 用的也是這兩個）。沒有會話日誌就不能續接，暫存維持記憶體。
            ...(sessionStore !== undefined && {
              toolResultStash: {
                rootDir: stashRoot,
                session: `${sessionStore.directory}\0${threadId}`,
                warn: log,
              },
            }),
          },
          threadPlugins,
          options.cwd,
        );
      } catch (error) {
        await release().catch(() => {});
        throw error;
      }
      // **啟動時沒掉、這一條組裝時才掉的列**（卡上第 6 項，例如跟這條 thread 的工作區有關的 `apply`）：同一套規則，
      // 只作用在這一條——可少掛的在這條 thread 裡不掛、伺服器日誌記一筆；不能少掛的已經在上面讓這條 thread 建不起來。
      for (const drop of assemblyDropsOf(loaded, built.dropped)) {
        log(`[組裝] thread "${threadId}" 這一條沒掛上：${describeDrop(drop)}`);
      }
      // 外掛交出的警告同理逐條記（例如 MCP 連不上）：它每條對話都重連一次，這一條連不上不代表上一條也沒連上。
      for (const line of describeWarnings(loaded, built.warnings)) {
        log(`[組裝] thread "${threadId}" 警告：${line}`);
      }
      // **對話從日誌推回模型**（#306），同 CLI 的 `--resume`，在這條 thread 的第一輪之前。灌不進去就讓它
      // 起不來（理由見 `conversation-restore.ts`）：剛建好的 agent 與續接那把租約都要收掉，下一次請求才重試得了。
      if (resumed !== undefined) {
        try {
          const replay = await restoreConversation(built.agent, threadId, resumed.events);
          log(`[會話日誌] thread "${threadId}" 接回來了：${formatConversationRestore(replay)}`);
        } catch (error) {
          await built.dispose().catch(() => {});
          await release().catch(() => {});
          throw error;
        }
      }
      const {
        agent,
        commands,
        dispose,
        attachTelemetry,
        attachInvariants,
        attachSession,
        feedback,
        workspaceChanges,
        goals,
        workspaceRoot,
        attachTitle,
        stepInbox,
      } = built;
      return {
        agent: agent as unknown as PumpAgent,
        stepInbox,
        // **`createCliAgent` 一直都回著這個註冊點，這條路以前把它丟掉了。**
        // 撿起來就是 web 那端打得到 `/plan` 的全部
        // （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）；發派面本身在
        // `wire-handler.ts` 的 `threadFor`，一條 thread 一個執行器。
        commands,
        // 評分與評語（#278）：沒掛 plugin 的組裝就缺席，那時三個回饋 method 回 `not_supported`。
        ...(feedback !== undefined && { feedback }),
        // 每一輪的改動摘要（#443）：沒給 `--workspace` 就缺席，兩條 `changes` 路由一律 404。
        ...(workspaceChanges !== undefined && { workspaceChanges }),
        // 交付讀檔路由的錨（#452）：沒給 `--workspace` 就缺席，兩條路由一律 404。
        // **這個值由 `createCliAgent` 算、從這裡原樣轉交**，呼叫端不再寫一次 `resolve(cwd, ...)`。
        ...(workspaceRoot !== undefined && { workspaceRoot }),
        // 續接線**以下**那些交付的錨（#519）：**來自磁碟上那份 header，不是這一次的
        // `--workspace`**。沒續接、或那份 header 沒記那一格（13 以前的日誌都沒有，而且續接
        // 不回填）就整個不給，那時線以下的每一顆照舊 404——判準是那一格在不在，不是
        // `header.version`，理由見 `wire-handler.ts` 的 `locateRequested`。
        ...(resumed?.header.workspaceRoot !== undefined && {
          resumedWorkspaceRoot: resumed.header.workspaceRoot,
        }),
        // 落盤沒接上就被收掉（建 thread 途中失敗）的話，續接那個把手還在這裡，要自己放。
        dispose: async () => {
          // 放不掉不該擋住收 agent——它底下可能有子行程。
          await release().catch(() => {});
          await dispose();
        },
        ...(resumed !== undefined && { rootSeed: resumed.events }),
        attachTelemetry,
        attachInvariants,
        attachSession,
        // LLM 標題（#650）：沒帶 `--live` 或那一列關掉就缺席，只剩退回標題。
        ...(attachTitle !== undefined && { attachTitle }),
        // **落盤的答案不在 `createCliAgent` 的回傳值裡**，它來自呼叫方式而不是 plugin
        // 清單，所以在這個閉包裡接（見 `wire-handler.ts` 的 `attachPersistence`）。
        // **旗標決定給不給，不是給一個關著的**：`goalDriver` 缺席就是「這條 thread 不
        // 自己排輪次」，同 `attachPersistence` 用缺席表達「沒開落盤」的規矩。
        ...(invocation.goalDriver
          ? {
              goalDriver: (log: () => SessionLog, flush: () => Promise<void>) =>
                // **`goals` 是這一條 thread 自己那一次組裝的**：`createCliAgent` 每條
                // thread 各跑一次（`:341`），所以兩條 thread 的目標從此分得開（#459）。
                goalDriverPort(goals, log, flush, (message) => {
                  serverLog(message);
                }),
            }
          : {}),
        // 落盤關掉（#612）就不給：日誌只在註冊表的記憶體裡，同 CLI 那一支。
        ...(sessionStore === undefined
          ? {}
          : {
              attachPersistence: (sessions: SessionRegistry) => {
                const persistence = attachSessionPersistence(sessions, sessionStore, {
                  cwd,
                  // 批次窗口：起動期解出來的那一份（`runServe` 頂上那一行），一台伺服器一個節奏。
                  windowMs: persistenceWindow.windowMs,
                  // 錨（#504）：同 CLI，取的是這一次組裝真的用的那一個（上面從 `built`
                  // destructure 出來的）。沒給 `--workspace` 就不寫那一格。
                  ...(workspaceRoot !== undefined && { workspaceRoot }),
                  // 續接：root 那一份往原檔續寫，只寫還沒存的後綴（第一筆就是 `session/end-seed`）。
                  ...(resumed !== undefined && {
                    resumedRoot: { stored: resumed.stored, storedCount: resumed.events.length },
                  }),
                  // CLI 那條走 `Printer` 是為了前綴分得出誰在講話；這裡沒有那個問題，
                  // 伺服器日誌本來就沒有跟誰搶終端機（同不變量那條的理由）。
                  warn: (message) => {
                    log(`[會話日誌] ${message}`);
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

  let server: WireServer;
  try {
    server = await startWireServer({
      handler: routeBySurface(handler, createWebStaticHandler({ distRoot: webDist, auth })),
      port: invocation.port,
      // 一個請求處理失敗（畸形的網址、讀檔錯誤）：記進伺服器日誌、回 400，行程照跑。見 `wire-server.ts`。
      warn: (error) => serverLog(`[請求] 處理失敗，回 400：${error.message}`),
    });
  } catch (error) {
    await handler.close();
    threadSearch?.close();
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
  // **披露，不是設定。** 每一條 thread 的對話都會寫上磁碟（#444 起預設就寫），寫去哪裡
  // 不該要讀文件才知道；清單把落盤關掉（#612）時，講的是「只在記憶體裡」與是哪一列關的。
  log(
    sessionStore === undefined ? SESSION_LOG_OFF_DISCLOSURE : `會話日誌：${sessionStore.directory}`,
  );
  // 同一條規矩底下的另一行：**這一輪結束之後還會不會有下一輪**。這台 server 上它是
  // per-thread 的行為，但旗標是整個 process 的，所以講在這裡。
  log(formatGoalDriverDisclosure(invocation.goalDriver));
  for (const line of formatTracingDisclosure(readTracingDisclosure(env))) {
    log(line);
  }
  // **遙測披露印在啟動時**（#749），同 CLI 緊接在追蹤那一行後面、分兩行講（理由見 `telemetry-disclosure.ts`）。
  // 以前印在第一條 thread 組起來時，因為那之前沒有人知道掛了什麼；上面那一次試組之後答案就在了，管理的人起
  // serve 的那一刻就看得到，不必等第一個人開對話。
  for (const line of formatTelemetryDisclosure(telemetrySharing)) log(line);

  return {
    url: server.url,
    authenticatedUrl,
    close: async () => {
      await server.close();
      await handler.close();
      threadSearch?.close();
    },
  };
}

async function main(): Promise<void> {
  try {
    const running = await runServe({ argv: process.argv.slice(2) });
    if (running === undefined) {
      return;
    }
    // Ctrl-C 要走完 dispose：子行程與檔案控制代碼都掛在那裡。**第二次訊號當場結束**、
    // 收尾有上限，照 dsh（`process-shutdown.ts`，#599）。所以用 `on` 不用 `once`：`once`
    // 用掉之後第二次落回預設動作，是同一個結果但不是政策。
    const shutdown = createProcessShutdown(async () => {
      try {
        await running.close();
      } catch (error) {
        // 控制器在收尾失敗時只強制結束、不講原因；會話日誌寫不下去是這裡最該聽見的那種。
        console.error(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    // SIGTERM 是監管者的一般停止要求，回 0；SIGINT 是使用者中斷，回 130（同 dsh 的 `profile-boot.ts`）。
    process.on('SIGTERM', () => {
      shutdown.interrupt(0);
    });
    process.on('SIGINT', () => {
      shutdown.interrupt(130);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
