/**
 * nexus-agent 的命令列入口——**後續 phase 的手動驗證工具**。
 *
 *   pnpm --filter @nexus/harness run cli "把這句話回聲一次。"   # 一次性，跑完就退出
 *   pnpm --filter @nexus/harness run cli                        # REPL
 *   pnpm --filter @nexus/harness run cli:live "..."             # 換成真實供應商
 *
 * 它與 [`spike/cli.ts`](./spike/cli.ts) 的分工：spike 那支綁死 Phase 0 的驗證腳本，
 * 這支收任意一句話、任意一份 plugin 清單。兩支都走 `createNexusAgent`——組裝點只有一個。
 *
 * **三件事刻意留給錯誤自己說話**：plugin 清單起不來（必掛的列、組裝點自己加的外掛掉了；清單上可少掛的列
 * 重名、`requires` 缺件、`apply` 拋錯只讓那一列掉、印一段警告，#751）、fold 的前置條件不成立、基座擋下這份組裝，
 * 全都發生在 agent 跑起來之前，而這裡不吞：訊息原樣進 stderr，行程以非零狀態退出。**那條傳播路徑只有一條**，
 * 它的端到端測試也因此只有一條（見 [`cli.test.ts`](./cli.test.ts)）。
 *
 * **非零狀態有兩個值**：一次性模式撞到 agent 自己的迴圈上限是 `2`，其餘失敗是 `1`
 * （[#362](https://github.com/DemianLi/nexus-agent/issues/362)，見 {@link exitCodeFor}）。
 * 走的是同一條傳播路徑，只在最後一步分岔，所以端到端那組多一條是為了釘住那個分岔，
 * 不是第二條路徑。
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaseMessage } from '@langchain/core/messages';
import type { CommandDescriptor, CommandRegistrationPoint, SessionEventMap } from '@nexus/core';
import { recordedApprovalPolicy } from '@nexus/core';
import { createCommandExecutor } from '@nexus/plugin-commands';
import { RUN_DURABILITY } from './pruned-memory-saver.js';
import { liveModelPlugin } from './settings/live-model.js';
import { startupEntryMounted, startupSetting } from './settings/startup.js';
import { threadTitleConfigSchema, threadTitlePlugin } from './settings/thread-title.js';
import { threadTitleLlmPlugin } from './settings/thread-title-llm.js';
import { spillPolicyPlugin } from './settings/spill-policy.js';
import { resolveToolResultStashRoot, toolResultStashPlugin } from './settings/tool-result-stash.js';
import { cleanupToolResultStash } from './tool-result-stash.js';
import { ensureFallbackTitle } from './session-title.js';
import type { ThreadTitleLimits } from './session-title.js';
import {
  attachSessionPersistence,
  sessionPersistencePlugin,
  humanMessageForTurnStart,
  MAX_TOKENS_TURN_END,
  REPEAT_REMINDER_MARKER,
  REPEAT_REMINDER_MIDDLEWARE_NAME,
  resumeClosingInterruptedTurn,
  turnReachedMaxTokens,
  type SessionLog,
} from '@nexus/core';
import { createJsonlSessionStore, openJsonlSessionStore } from './jsonl-session-store.js';
import { assertSameCwd, assertSameWorkspaceRoot } from './resume-guards.js';
import { PLAN_COMMAND_NAME, recordedPlanMode } from '@nexus/plugin-plan-mode';
import { AssemblyDropError, HEADLESS_APPROVALS } from './agent-factory.js';
import { driveGoalRound } from './goal-driver.js';
import type { GoalDriverPort, GoalRoundRequest } from './goal-driver.js';
import { recordedSandboxMode, SANDBOX_COMMAND_NAME } from '@nexus/plugin-sandbox-policy';
import { installLaunchProxy } from './http-proxy-boot.js';
import { processLaunchEnv } from './launch-env.js';
import { classifyTurnFailure, loadLiveLaunchEnv, DEFAULT_LIVE_MODEL_ID } from './live-model.js';
import type { LiveLaunch } from './live-model.js';
import { formatConversationRestore, restoreConversation } from './conversation-restore.js';
import { runDumpConfigSchema } from './config-schema-dump.js';
import { resolveSessionHeaderMetadata } from './session-header-metadata.js';
import {
  composeDefaultEntries,
  loadDefaultPlugins,
  renderLayeredConfigDump,
  renderShippedConfigDump,
} from './plugin-config.js';
import {
  assemblyDropsOf,
  auditStartupEntries,
  dropReasonsOf,
  optionalEntriesOf,
  startupErrorFrom,
  startupWarning,
} from './startup-audit.js';
import { createInvariantLog } from './invariant-log.js';
import { toAgentInvocation } from './messages.js';
import { formatTelemetryDisclosure } from './telemetry-disclosure.js';
import { formatTracingDisclosure, readTracingDisclosure } from './tracing.js';
import {
  type CliInvocation,
  parseSandboxMode,
  resolveInvariantLogPath,
  resolveSessionLogDir,
  SESSION_LOG_OFF_DISCLOSURE,
  assertPersistenceFlags,
  resolveWorkspaceRoot,
  outsideWorkspace,
  THREAD_ID,
  formatGoalDriverDisclosure,
  type NexusAgent,
  createCliAgent,
  goalDriverPort,
} from './assembly-root.js';

export const USAGE = `用法：cli [選項] [要說的話...]

  不給話就進 REPL；給了就跑一輪、印出結果、退出。

選項：
  --live               換成真實供應商（預設 ${DEFAULT_LIVE_MODEL_ID}），需要 API key
  --patch <file>       把這個 patch 檔疊在出貨的 cordis.yml 上（可以給多次，後面的蓋前面的）
                       另一層是 $NEXUS_AGENT_HOME/cordis.patch.yml，它排在 --patch 之前
  --workspace <dir>    在真實磁碟的這個目錄上跑，變更被圍堵在它之下
                       （省略即虛擬檔案系統，完全不碰磁碟）
  --sandbox <mode>     圍堵強度：read-only｜workspace-write｜danger-full-access
                       預設 workspace-write（可寫根之內放行）；要配 --workspace
  --session-log <dir>  把會話日誌改寫到這個目錄底下
                       （預設 $NEXUS_AGENT_HOME/sessions，沒設就是 ~/.nexus-agent/sessions）
                       它不能在 --workspace 底下：日誌是基礎建設，不是 agent 的工作區
                       要完全不落盤，在 patch 裡把 session-persistence 那一列寫成 disabled: true
  --resume <run 目錄>  接著上一次寫出來的那個 run 目錄跑下去：
                       沙箱模式、目標、計劃模式與對話照日誌回來
                       （虛擬檔案系統與會話歷史檔不回來；工具結果暫存存在主機上，讀得回）
                       要在上一次的同一個目錄底下接（日誌記著它屬於哪個目錄）
                       不能配 --sandbox（模式從日誌來）或 --session-log（就寫回那個目錄）
  --goal-driver        一個 active 的目標沒達成時自己再開一輪（預設關）
  --max-goal-rounds <n>
                       這一次呼叫最多讓它排幾輪（要配 --goal-driver）
                       目標自己的 max_goal_rounds 是模型填的，這一條它改不動
  --recursion-limit <n>
                       agent 迴圈上限（LangGraph super-step，預設 100 ≈ 33 個模型輪）
                       一次性模式撞到時退出碼是 2，其他失敗是 1
  --dump-config        把三層疊完的 plugin 設定印出來就退出（一個 plugin 都不載）
                       每一段前面的 # == 註解標明那幾列來自哪個檔、被哪幾層改過
                       不能配 --resume 或要說的話（印設定不跑任何一輪）
  --dump-default-config
                       只印出貨那一層的設定就退出：不讀 $NEXUS_AGENT_HOME/cordis.patch.yml，也不收 --patch
                       覆寫檔壞了（權限不對、YAML 寫壞）連 --dump-config 都印不出來時，用它拿一份對照
                       不能配 --dump-config、--dump-config-schema、--patch、--resume 或要說的話
  --dump-config-schema 把疊完的 plugin 設定欄位規格表（JSON Schema 2020-12）印出來就退出
                       標準輸出只有那份 JSON，診斷走標準錯誤；有任何一列轉不完整（或載不起來）退出碼是 1
                       停用的列也收。不能配 --dump-config、--resume 或要說的話
  --help               印這段話

  REPL 裡輸入 /help 看有哪些命令，/exit 或按 Ctrl-D 結束。`;

/**
 * 把 argv 解析成一次呼叫。
 *
 * 位置參數整串接起來當作那句話——`cli 把這句 回聲一次` 與 `cli "把這句 回聲一次"`
 * 是同一件事，因為 shell 拆不拆詞不該改變語意。
 *
 * @param argv - `process.argv.slice(2)`。
 * @returns 解析出來的呼叫。
 * @throws 旗標不認得，或旗標沒給值——訊息接上用法。
 */
export function parseCliArgs(argv: readonly string[]): CliInvocation {
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
        resume: { type: 'string' },
        'goal-driver': { type: 'boolean', default: false },
        'max-goal-rounds': { type: 'string' },
        'recursion-limit': { type: 'string' },
        'dump-config': { type: 'boolean', default: false },
        'dump-config-schema': { type: 'boolean', default: false },
        'dump-default-config': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\n\n${USAGE}`);
  }

  const { values, positionals } = parsed;
  if (values.workspace !== undefined && values.workspace.trim() === '') {
    throw new Error(`--workspace 要給一個目錄路徑。\n\n${USAGE}`);
  }
  const patches = values.patch;
  if (patches !== undefined) {
    if (patches.some((patch) => patch.trim() === '')) {
      throw new Error(`--patch 要給一個檔案路徑。\n\n${USAGE}`);
    }
  }
  // **續接的衝突先講**：`--resume --sandbox read-only` 沒配 `--workspace` 的話，下一行會先
  // 報「--sandbox 要配 --workspace」，而那不是這個人真正做錯的事。
  const resume = values.resume;
  if (resume !== undefined) {
    if (resume.trim() === '') throw new Error(`--resume 要給一個 run 目錄。\n\n${USAGE}`);
    if (values.sandbox !== undefined) {
      throw new Error(
        `--resume 不能配 --sandbox：續接的模式從日誌來，兩個一起給的話不管誰贏，另一個都是` +
          `靜靜被丟掉。要換模式，接起來之後用 /${SANDBOX_COMMAND_NAME} 切——那一次會記進日誌。` +
          `\n\n${USAGE}`,
      );
    }
    if (values['session-log'] !== undefined) {
      throw new Error(
        `--resume 不能配 --session-log：續接就寫回那個 run 目錄，給兩個等於兩個寫入目的地。` +
          `\n\n${USAGE}`,
      );
    }
  }
  const sandbox = parseSandboxMode(values.sandbox, values.workspace, USAGE);
  const sessionLog = values['session-log'];
  if (sessionLog !== undefined && sessionLog.trim() === '') {
    throw new Error(`--session-log 要給一個目錄路徑。\n\n${USAGE}`);
  }

  const goalDriver = values['goal-driver'] === true;
  const maxGoalRounds = parseMaxGoalRounds(values['max-goal-rounds'], goalDriver);
  const recursionLimit = parsePositiveInteger('--recursion-limit', values['recursion-limit']);

  const dumpConfig = values['dump-config'] === true;
  if (dumpConfig) {
    // **照 dsh：dump 旗標拒絕只在啟動時才有意義的旗標。** 靜靜收下的下場是印出一棵設定樹，
    // 而那個人以為自己驗證的是接回上一次那條路——他要的答案根本不在裡面。
    if (resume !== undefined) {
      throw new Error(`--dump-config 不能配 --resume：印設定不跑任何一輪。\n\n${USAGE}`);
    }
    // 要說的話同理（照 dsh）：印完就退出，那句話永遠不會被說出去。以前這裡靜靜收下（#740 補上）。
    if (positionals.join(' ').trim().length > 0) {
      throw new Error(`--dump-config 不能配要說的話：印設定不跑任何一輪。\n\n${USAGE}`);
    }
  }

  const dumpConfigSchema = values['dump-config-schema'] === true;
  if (dumpConfigSchema) {
    // 同 `--dump-config`：規格表不跑任何一輪，靜靜收下這些旗標的下場是那個人以為自己驗證的是別的東西。
    if (dumpConfig) {
      throw new Error(`--dump-config-schema 不能配 --dump-config：一次只印一種。\n\n${USAGE}`);
    }
    if (resume !== undefined) {
      throw new Error(`--dump-config-schema 不能配 --resume：印規格表不跑任何一輪。\n\n${USAGE}`);
    }
    if (positionals.join(' ').trim().length > 0) {
      throw new Error(`--dump-config-schema 不能配要說的話：印規格表不跑任何一輪。\n\n${USAGE}`);
    }
  }

  // **只印出貨那一層**（#740）：照 dsh，三種印法互斥；不讀 home 覆寫檔，所以帶 `--patch` 沒有意思——
  // 靜靜收下的下場是那個人以為自己看的是疊過他那個 patch 的樣子。
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
    if (resume !== undefined) {
      throw new Error(`--dump-default-config 不能配 --resume：印設定不跑任何一輪。\n\n${USAGE}`);
    }
    if (positionals.join(' ').trim().length > 0) {
      throw new Error(`--dump-default-config 不能配要說的話：印設定不跑任何一輪。\n\n${USAGE}`);
    }
  }

  const prompt = positionals.join(' ').trim();
  return {
    ...(prompt.length > 0 && { prompt }),
    live: values.live === true,
    ...(patches !== undefined && { patches }),
    ...(values.workspace !== undefined && { workspace: values.workspace }),
    ...(sandbox !== undefined && { sandbox }),
    ...(sessionLog !== undefined && { sessionLog }),
    ...(resume !== undefined && { resume }),
    goalDriver,
    ...(maxGoalRounds !== undefined && { maxGoalRounds }),
    ...(recursionLimit !== undefined && { recursionLimit }),
    dumpConfig,
    dumpConfigSchema,
    dumpDefaultConfig,
    help: values.help === true,
  };
}

/**
 * `--max-goal-rounds` 那一格。
 *
 * **沒開旗標就拋，不是靜靜收下。** 一個收下來卻沒有消費者的上限，跟沒設一模一樣——而
 * 差別在於畫面上看起來設過了。這條路上唯一會發生的事就是有人以為自己壓住了輪數。
 *
 * @param raw - 命令列上那串字，沒給就是 `undefined`。
 * @param goalDriver - `--goal-driver` 開著沒有。
 * @returns 那個數字，或沒給時的 `undefined`。
 * @throws 沒配 `--goal-driver`，或不是正整數——訊息接上用法。
 */
function parseMaxGoalRounds(raw: string | undefined, goalDriver: boolean): number | undefined {
  if (raw === undefined) return undefined;
  if (!goalDriver) {
    throw new Error(
      `--max-goal-rounds 要配 --goal-driver：沒有排程器的話它一輪都限制不到。\n\n${USAGE}`,
    );
  }
  return parsePositiveInteger('--max-goal-rounds', raw);
}

/**
 * 命令列上的一個正整數。
 *
 * @param flag - 旗標名，拿來寫進錯誤訊息。
 * @param raw - 命令列上那串字，沒給就是 `undefined`。
 * @returns 那個數字，或沒給時的 `undefined`。
 * @throws 不是正整數——訊息接上用法。
 */
function parsePositiveInteger(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} 要給一個正整數（拿到 ${JSON.stringify(raw)}）。\n\n${USAGE}`);
  }
  return value;
}

/**
 * 把 `--resume` 解析成絕對路徑。擋掉的東西與 {@link resolveSessionLogDir} 同一條：續接之後
 * 新事件寫回那個目錄，所以它落在可寫根底下的後果跟 `--session-log` 一模一樣。
 *
 * @param invocation - 解析出來的呼叫。
 * @param cwd - 相對路徑的解析基準。
 * @returns 絕對路徑，或沒給 `--resume` 時的 `undefined`。
 * @throws 它落在 `--workspace` 底下。
 */
export function resolveResumeDir(
  invocation: Pick<CliInvocation, 'resume' | 'workspace'>,
  cwd: string,
): string | undefined {
  if (invocation.resume === undefined) return undefined;
  return outsideWorkspace(invocation.resume, invocation.workspace, cwd, '--resume');
}

/**
 * banner 上關於核准的那一行。
 *
 * **它是 (a) 那個決定唯一的代價的解藥。** [#113](https://github.com/DemianLi/nexus-agent/issues/113)
 * 選了「預設關掉、不加旗標」，而它的缺點被記在卡上：「CLI 不做核准」變成一件要讀文件
 * 才知道的事。旗標不是補這個缺口的辦法——旗標讓人**選**，而這裡沒有第二個值得選的
 * 行為——**披露才是**：把已經定下來的事講出來。同 tracing 與遙測那兩行的規矩，
 * 這一行不是設定，是狀態。
 *
 * 不講的話，「這個工具被政策拒絕了」與「模型自己決定不叫它」在畫面上分不出來。
 *
 * **它與 {@link HEADLESS_APPROVALS} 是同一個決定的兩半**：這一行寫死「關閉」，因為
 * `runCli` 只傳那一個政策。哪天這裡真的多了一個旗標，這個常數要跟著變成一個函式——
 * 不然畫面會開始說謊，而說謊的披露比沒有披露更糟。
 */
export const APPROVAL_DISCLOSURE =
  '核准：關閉（這個入口收不了核准決定，需要核准的工具會被拒絕，不會停下來等）';

/**
 * 續接回來的計劃模式開著時，啟動畫面多講的那一行。
 *
 * **這是 [#251](https://github.com/DemianLi/nexus-agent/issues/251) 第二刀才走得到的狀態。**
 * 計劃模式搬進日誌之前，它跨不過重啟；現在跨得過，而這個入口收不了核准
 * （`HEADLESS_APPROVALS`）——模型交出去的計劃會被確定性拒絕，唯一的出路是人打 `/plan off`。
 * 等模型被拒了才知道原因太晚，所以在一開始就講。
 */
export const RESUMED_PLAN_MODE_NOTICE = `計劃模式：開著（從續接的日誌來）。這個入口收不了核准，計劃交不出去——要動手就先 /${PLAN_COMMAND_NAME} off。`;

/**
 * 一則訊息在畫面上該印成什麼，或 `undefined` 代表不印。
 *
 * **人自己說的那句不再印一次。** 基座把這一輪的輸入訊息掛在**第一個真的寫了東西的
 * 節點**的 update 上（實測：三個 `before_agent` 裡只有回傳非空更新的那一個帶著它）。
 * 照原樣印的話，畫面上會出現 `[nexusPlanMode.before_agent] 嗨`——看起來像那個 plugin
 * 在說話，而那句是使用者三秒前自己打的。（那是當時唯一回非空更新的 `before_agent`；
 * 計劃模式搬進日誌之後它沒有 `beforeAgent` 了，但這個形狀歸基座，下一個回非空更新的
 * 節點照樣會帶著它，所以濾照舊。）
 *
 * **例外是圖自己插進來的 human 訊息，而那條路現在真的有了。** 這段註解過去寫著「哪天
 * 真的有東西從圖裡插一則 human message 進來，它也會跟著不見；今天沒有那條路」——
 * [#147](https://github.com/DemianLi/nexus-agent/issues/147) 開了那條路：重複呼叫的
 * 提醒就是一則合成的 human 訊息。一律跳過的話，那道護欄唯一的產出在畫面上一個字都不會
 * 出現，操作的人看不出它有沒有動過。所以帶記號的照印，**沒有**記號的才是使用者自己打的。
 *
 * 抽成純函式是為了測得到：CLI 的假腳本不重複呼叫任何工具，那條分支在整條 REPL 上跑不到。
 *
 * @param node - 這則訊息來自哪個節點。
 * @param message - 那則訊息。
 * @returns 要印的那一行，或 `undefined`。
 */
export function transcriptLine(node: string, message: BaseMessage): string | undefined {
  if (message.getType() === 'human') {
    if (message.additional_kwargs[REPEAT_REMINDER_MARKER] == null) return undefined;
    return `[${REPEAT_REMINDER_MIDDLEWARE_NAME}] ${message.text.trim()}`;
  }
  const label = message.name ? `${node}/${message.name}` : node;
  return `[${label}] ${message.text.trim() || '(呼叫工具)'}`;
}

/** 把一輪 stream 出來的東西印給人看。 */
interface Printer {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

const consolePrinter: Printer = {
  log: (line) => void console.log(line),
  error: (line) => void console.error(line),
};

/** `updates` 串流裡「這一輪停在核准點」的那一筆的形狀。 */
interface InterruptUpdate {
  readonly value?: {
    readonly actionRequests?: readonly { readonly name?: string; readonly description?: string }[];
  };
}

/**
 * `__interrupt__` 那一筆裡的中斷 id。
 *
 * **跟 `thread-pump.ts` 的 `asInterruptEntries` 讀的是同一個形狀**（基座把中斷發成
 * 一個帶 `id` 的陣列），只是這一側經 `stream(['updates'])` 拿到、那一側經
 * `streamEvents` 拿到。認不出來就回空陣列——**寧可少記一筆，也不要編一個 id 出來**。
 */
function interruptIdsOf(update: unknown): readonly string[] {
  if (!Array.isArray(update)) return [];
  return update
    .map((entry: unknown) => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * 把中斷印出來。
 *
 * **這一段在補一個真的缺陷，不是加裝飾。** 中斷在 `updates` 串流裡是
 * `{ __interrupt__: [...] }`，值是一個陣列而不是 `{ messages }`，所以底下那個印訊息
 * 的迴圈對它一個字都印不出來——這一輪就這樣結束，人看到的是模型講到一半忽然沒了，
 * 而工具其實沒跑。停在核准點與正常收工在畫面上長得一模一樣，是最壞的那種相同。
 *
 * 這一版**只負責說**，不負責問。收決定、`Command({ resume })` 送回去的那個介面在 web
 * （[#79](https://github.com/DemianLi/nexus-agent/pull/79)），不在這裡。
 *
 * **[#113](https://github.com/DemianLi/nexus-agent/issues/113) 之後，核准閘門不會再走到
 * 這裡**——`runCli` 傳 {@link HEADLESS_APPROVALS}，需要核准的工具在閘門那一層就被拒絕，
 * 根本不發中斷。那**不是**刪掉這一段的理由：閘門不是唯一會 `interrupt()` 的東西——
 * **閘門自己就是一個 middleware 裡的 `interrupt()`**，所以同一條路徑對任何一個 plugin
 * 掛上來的 middleware 都是開著的。真的有人走上來的時候，這一段是「這一輪停了」與
 * 「這一輪好好收工了」之間唯一的差別。刪掉它等於把當初那個缺陷重新打開，只是換一個來源。
 *
 * @param update - `__interrupt__` 那一筆的內容。
 * @param printer - 輸出去處。
 */
function printInterrupt(update: unknown, printer: Printer): void {
  const requests = (Array.isArray(update) ? (update as InterruptUpdate[]) : []).flatMap(
    (entry) => entry.value?.actionRequests ?? [],
  );
  const listed = requests.map(
    (request) => `${request.name ?? '(未具名)'}：${request.description ?? '未說明'}`,
  );

  printer.log('[核准] 這一輪停在核准點，下列工具還沒執行：');
  for (const line of listed.length > 0 ? listed : ['(基座沒給明細)']) {
    printer.log(`[核准]   ${line}`);
  }
  printer.log('[核准] 這個入口還不能收核准決定，所以這一輪到此為止。');
}

/**
 * 跑一輪，邊跑邊印。
 *
 * 一次 run 收兩種事件：`updates` 給人看過程，`values` 拿最終狀態裡的虛擬檔案。
 * 兩種一起收是因為假模型的腳本用完就會失敗——stream 完再 invoke 一次會多跑一輪。
 *
 * @param agent - 組裝好的 agent。
 * @param input - 使用者說的那句話，或**排程器排的一輪續行**。
 * @param printer - 輸出去處。
 * @param sessionLog - 這條 REPL 的事件日誌。
 * @param titleLimits - 退回標題的兩個上限（[#647](https://github.com/DemianLi/nexus-agent/issues/647)），由 `main`
 *   在起動期從清單解出來。**省略即 schema 的預設**，理由同 `ThreadPump` 的 `toolText`：測試呼叫點量的不是它。
 */
export async function runTurn(
  agent: NexusAgent,
  input: string | GoalRoundRequest,
  printer: Printer,
  sessionLog: SessionLog,
  titleLimits: ThreadTitleLimits = threadTitleConfigSchema.parse({}),
): Promise<void> {
  let files: Record<string, unknown> = {};

  // **一個 `text`，兩個消費者。** 分開算的話，一顆日誌上逐字正確的 `turn/start` 可以配
  // 上餵給模型的任意字串，而不變量伴生只看得到日誌那一份——它結構上驗不到那種偏差。
  const text = typeof input === 'string' ? input : input.text;
  const turnStart: SessionEventMap['turn/start'] =
    typeof input === 'string'
      ? { kind: 'message', text }
      : {
          kind: 'goal',
          text,
          goalId: input.goalId,
          revision: input.revision,
          round: input.round,
        };
  sessionLog.append('turn/start', turnStart);
  try {
    // 退回標題（#647），同 web 的 pump：人打的字那一種才寫，還沒有標題才寫，寫不進去只講一聲、這一輪照跑。CLI 的日誌
    // 今天沒有讀標題的人（serve 的列表讀不到 run 目錄），寫它是照 dsh：退回標題在 `base` bundle 裡，每一種組裝都有。
    if (typeof input === 'string') {
      try {
        ensureFallbackTitle(sessionLog, titleLimits);
      } catch (error: unknown) {
        printer.error(`[標題] 退回標題寫不進去：${String(error)}`);
      }
    }
    for await (const [mode, payload] of await agent.stream(
      // 人打的字是素的字串；續行輪次的頭帶 `goal` 來源（#662），重複提醒才知道它不是人講話。
      toAgentInvocation(typeof input === 'string' ? text : humanMessageForTurnStart(turnStart)),
      {
        streamMode: ['updates', 'values'],
        // 存檔點只在這一輪結束時存一份（#1106），理由見 `pruned-memory-saver.ts`。
        durability: RUN_DURABILITY,
        configurable: { thread_id: THREAD_ID },
      },
    )) {
      if (mode === 'values') {
        files = (payload as { files?: Record<string, unknown> }).files ?? {};
        continue;
      }

      for (const [node, update] of Object.entries(payload as Record<string, unknown>)) {
        if (node === '__interrupt__') {
          for (const interruptId of interruptIdsOf(update)) {
            sessionLog.append('interrupt/raised', { interruptId });
          }
          printInterrupt(update, printer);
          continue;
        }
        const messages = (update as { messages?: BaseMessage[] }).messages ?? [];
        for (const message of messages) {
          const line = transcriptLine(node, message);
          if (line !== undefined) printer.log(line);
        }
      }
    }
  } catch (error) {
    sessionLog.append('turn/failed', {
      message: error instanceof Error ? error.message : String(error),
      error: classifyTurnFailure(error),
    });
    throw error;
  }
  // 撞到輸出上限的那一輪帶原因收尾（#433），判準讀的是這一輪記下的回覆，見 `@nexus/core` 的 `max-tokens.ts`。
  sessionLog.append(
    'turn/end',
    turnReachedMaxTokens(sessionLog.events) ? { reason: MAX_TOKENS_TURN_END } : {},
  );

  const paths = Object.keys(files);
  if (paths.length > 0) {
    printer.log(`虛擬檔案系統：${paths.join('、')}`);
  }
}

/**
 * 排到排不動為止。**一輪跑壞就整串停**——決策函式看到日誌上那顆 `turn/failed` 會回
 * `turn-failed`，而異常自動重試明著在範圍外。
 *
 * @param agent - 組裝好的 agent。
 * @param printer - 輸出去處。
 * @param sessionLog - 這條 REPL 的事件日誌。
 * @param driver - 排程器那一側。
 * @param roundCap - `--max-goal-rounds`；省略即只有目標自己那一條上限。**它到頭時走的
 *   是跟目標那條同一條路**（記一顆 blocker 然後停），不是在這裡 `break`——安靜停下來的
 *   迴圈會留下一個還 active 的目標，而那在日誌上跟「模型收工了」分不開。
 */
export async function driveGoalRounds(
  agent: NexusAgent,
  printer: Printer,
  sessionLog: SessionLog,
  driver: GoalDriverPort,
  roundCap?: number,
): Promise<void> {
  for (;;) {
    const round = await driveGoalRound(() => sessionLog.events, driver, roundCap);
    if (round === undefined) return;
    // **這一行是披露不是裝飾**：不印的話，「模型自己又開了一輪」與「人打了一句話」在
    // 畫面上一模一樣，而畫面是這條路上唯一看得到續行在燒預算的地方。
    printer.log(`\n[續行] 第 ${round.round} 輪（目標還沒達成）`);
    await runTurn(agent, round, printer, sessionLog);
  }
}

/**
 * REPL 自己擁有的兩個名字——**不在註冊表裡**。
 *
 * `/exit` 控制的是這條 REPL 不是 agent（`CommandResult` 沒有「結束發派面」這一格，
 * dsh 那邊也沒有）；`/help` 是探索面，同理。
 *
 * **為什麼 `/help` 不註冊成一個真的命令**：一份清單該長什麼樣，是**發派面自己的問題**。
 * 這條 REPL 的答案必須含 `/exit`（不然清單漏掉一個真的打得出去的東西）；dsh 那種 composer
 * 選單的答案則**不該含 `/help`**（選單自己就是 help）。同一個註冊上去的 handler 生不出
 * 這兩份。而出貨的那份清單（`apps/harness/cordis.yml`）正是 `cli.ts` 與
 * [`serve.ts`](./serve.ts) 共用的那一份——註冊上去就是把 REPL 的答案塞給所有人。探索面歸發派它的那一側，這也正是 dsh
 * 的切法（見 {@link formatCommandHelp}）。
 *
 * 描述的口氣跟 plugin 註冊的那些對齊：一句話，說它做什麼。
 */
const REPL_OWNED_COMMANDS: readonly CommandDescriptor[] = Object.freeze([
  Object.freeze({ name: 'exit', description: '結束這條 REPL' }),
  Object.freeze({ name: 'help', description: '印出這份命令清單' }),
]);

/**
 * `/help` 這一行。**名字對上就算，後面的字忽略。**
 *
 * 跟 `/exit` 的嚴格相等刻意不同：`/exit now` 掉回模型只是白問一句，`/help 怎麼用`
 * 掉回模型則是**在人明確求助的那一刻**把他丟給模型。`/helper` 不算——`(?:\s.*)?$`
 * 要求 `/help` 之後只能是空白或結尾。
 */
const HELP_LINE_PATTERN = /^\/help(?:\s.*)?$/u;

/**
 * 把命令清單排成給人看的幾行。
 *
 * **dsh 沒有 `/help`。** 它的探索面是 web composer 打 `/` 跳出來的候選選單
 * （`references/deepseek-harness/packages/client/ui-commands/src/client/service.ts:142`，
 * 對讀版本 `0a53fb55bea101816fa226bb964ae2bed71c343b`），資料來源是同一個
 * `commands.list()`；而 dsh 自己的 CLI（`apps/cli/`）**一個命令發派面都沒有**——
 * commands 那包的 README（`packages/interaction/commands/README.zh.md:28`）明說：無 UI 的
 * 演示主幹與 ACP 自動化不提供命令適配器，也不需要它。
 *
 * **所以這不是 AGENTS.md 那條「基礎建設表達不出來」的偏離**——deepagents 與 LangChain
 * 都沒參與這件事。準確的說法是：真相來源照抄（`list()`），呈現形式因為我們的發派面是
 * 一行一行的 `readline` 而不是 composer，換成一個命令。`readline` 的 `completer` 日後
 * 承得起選單那個形狀，要換不必推翻這裡。
 *
 * **註冊表的那些與 REPL 自己的那兩個併成一張表排序**，理由跟 dsh 的選單同源：打字的人
 * 要知道的是「我現在能打什麼」，不是「這一行歸誰管」。
 *
 * @param registered - `commands.list()` 交出來的 descriptor，已經按名字排好。
 * @returns 要印的每一行，含開頭那句抬頭。
 */
function formatCommandHelp(registered: readonly CommandDescriptor[]): readonly string[] {
  const rows = [...registered, ...REPL_OWNED_COMMANDS]
    .map((entry) => ({
      name: entry.name,
      left: `/${entry.name}${entry.input === undefined ? '' : ` ${entry.input.hint}`}`,
      description: entry.description,
    }))
    // 名字在註冊表裡唯一，REPL 那兩個又跟它們撞不到（下面那道檢查在擋），所以沒有相等的一對。
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  // `padEnd` 數的是 UTF-16 code unit。左欄是命令名加 hint，hint 全形時會少對齊幾格——
  // 那是提示字串自己的選擇，不值得為它拉一套字寬表進來。
  const width = Math.max(...rows.map((row) => row.left.length));
  return ['命令：', ...rows.map((row) => `  ${row.left.padEnd(width)}  ${row.description}`)];
}

/**
 * 撞名就當場拋。
 *
 * REPL 在執行器之前攔 `/exit` 與 `/help`，所以 plugin 註冊了同名命令時，那份註冊
 * **永遠不會被叫到**——而且沒有任何徵兆。dsh 在同一個位置也是明確報錯（客戶端貢獻
 * 與宿主命令同名 → `duplicate contribution for /<name>`，`ui-commands` 的
 * `service.ts:175`）。
 *
 * 這順帶補掉一個本來就在的洞：在 `/help` 之前，註冊 `exit` 就已經是靜默被遮蔽了。
 *
 * @param commands - 要檢查的註冊表。
 * @throws 註冊表裡有 `exit` 或 `help`。
 */
function assertNoReplNameCollision(commands: Pick<CommandRegistrationPoint, 'find'>): void {
  for (const { name } of REPL_OWNED_COMMANDS) {
    if (commands.find(name) === undefined) continue;
    throw new Error(
      `有 plugin 註冊了命令 "${name}"，但 REPL 自己攔這個名字——那份註冊永遠不會被叫到。` +
        `把其中一邊改名。`,
    );
  }
}

/**
 * REPL：一行一輪，直到 `/exit` 或 stdin 收掉。
 *
 * **這一層吞執行期的錯誤**，印完接著問下一句——一輪答壞了不是關掉工具的理由，而手動
 * 驗證正是要一句接一句試。組裝期的錯誤不在這裡：那些在 REPL 開起來之前就拋了。
 *
 * **`/exit` 與 `/help` 刻意留在這裡，不註冊成命令**（見 {@link REPL_OWNED_COMMANDS}）。
 * `commands.list()` 因此看不到它們，所以 `/help` 自己把這兩行補進清單——那份備忘到期了。
 *
 * @param agent - 組裝好的 agent。
 * @param io - readline 收發的兩端。
 * @param printer - 輸出去處。
 * @param sessionLog - 這條 REPL 的事件日誌。
 * @param commands - plugin 註冊的命令。`find` 給執行器派發，`list` 給 `/help` 列清單。
 *   **執行器在這裡建，一個 REPL 一個**——
 *   `@nexus/plugin-commands` 的配套入口就是靠「一次一個」這件事在檢查配對的。
 * @param titleLimits - 見 {@link runTurn}。
 */
export async function runRepl(
  agent: NexusAgent,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  printer: Printer,
  sessionLog: SessionLog,
  commands: Pick<CommandRegistrationPoint, 'find' | 'list'>,
  driver?: GoalDriverPort,
  roundCap?: number,
  titleLimits?: ThreadTitleLimits,
): Promise<void> {
  assertNoReplNameCollision(commands);
  const executor = createCommandExecutor({ commands, sessionLog });
  const rl = createInterface({ input: io.input, output: io.output, prompt: '> ' });
  // `Interface` 的型別沒有 `closed`（執行期有），所以自己記一份。
  let closed = false;
  rl.once('close', () => void (closed = true));
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (text === '/exit') break;
    if (HELP_LINE_PATTERN.test(text)) {
      for (const line of formatCommandHelp(commands.list())) printer.log(line);
      if (!closed) rl.prompt();
      continue;
    }
    if (text.length > 0) {
      try {
        // **沒有取消訊號可給**：這條 REPL 沒有「按 Ctrl-C 中止這一次」的路，所以給一個
        // 從來不會 abort 的。有那條路的時候換掉這一行就行，執行器那側已經接得住。
        const execution = await executor.execute(text, new AbortController().signal);
        if (execution === undefined) {
          // 語法不符或名字不認得——**照原樣送給模型**，跟這行改動之前一模一樣。
          await runTurn(agent, text, printer, sessionLog, titleLimits);
        } else {
          if (execution.result.text !== undefined) {
            const write = execution.result.kind === 'error' ? printer.error : printer.log;
            write(execution.result.text);
          }
          // **命令請宿主接著送的話**（`/plan <message>`）：`command/done` 已經寫完，這裡才開這一輪，
          // 跟人接著打了那一句一樣。REPL 一行一輪，所以逐句 await。
          for (const message of execution.steers) {
            await runTurn(agent, message, printer, sessionLog, titleLimits);
          }
        }
        // **命令也算一次機會**：`/goal resume` 就是重新授權，而重新授權之後該接著跑。
        if (driver !== undefined)
          await driveGoalRounds(agent, printer, sessionLog, driver, roundCap);
      } catch (error) {
        // 撞到迴圈上限也落在這裡：印一行、等下一句，**不退出**——所以 `exitCodeFor` 的
        // 退出碼 2 只在一次性路徑上存在。
        printer.error(errorMessage(error));
        // **跑壞的那一輪要收回續行授權**（#660，同 dsh 收到 `agent/error` 就 disarm）。`driveGoalRounds`
        // 在輪次拋錯時不會再問一次排程器，不在這裡問的話，人再講一句話、那一輪正常收工，續行就接回來了。
        // 結果丟掉：這一問只為了收回；日誌最後一輪不是跑壞的就什麼都不做。
        if (driver !== undefined) {
          await driveGoalRound(() => sessionLog.events, driver, roundCap).catch(
            (askError: unknown) =>
              driver.warn(`跑壞之後收回續行授權失敗：${errorMessage(askError)}`),
          );
        }
      }
    }
    // stdin 收在最後一行之後（管線餵進來時就是這樣）——那一刻 readline 已經關了，
    // 再問一次提示是 ERR_USE_AFTER_CLOSE。
    if (!closed) rl.prompt();
  }

  rl.close();
}

/** 只取 `message`：`load.ts` 把原因接進訊息本身，正是因為這是錯誤處理最常見的形狀。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RunCliOptions {
  readonly argv: readonly string[];
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly printer?: Printer;
  readonly cwd?: string;
  /**
   * 環境變數，只用來讀 tracing 的披露。省略即 `process.env`。
   *
   * 開這個口是為了讓披露測得起來：`process.env` 一改就會污染同檔案裡後面的每一條
   * （`langsmith` 的 client 是 module 層的 singleton，第一次觸發時的設定就定生死，
   * 見 `tracing.test.ts`）。
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * 一次完整的 CLI 呼叫：解析、組裝、跑。
 *
 * 組裝失敗一律往外拋——由 {@link main} 印進 stderr 並設行程的退出碼（{@link exitCodeFor}）。
 *
 * @param options - argv 與 I/O 兩端。
 */
export async function runCli(options: RunCliOptions): Promise<void> {
  const printer = options.printer ?? consolePrinter;
  const invocation = parseCliArgs(options.argv);

  if (invocation.help) {
    printer.log(USAGE);
    return;
  }

  // 同 `--dump-config` 的位置與理由。標準輸出只放那份 JSON（`printer.log` 是標準輸出），診斷走 `printer.error`；
  // 不完整時文件印完之後拋 `ConfigSchemaIncompleteError`，由 `main` 設退出碼 1。
  if (invocation.dumpConfigSchema) {
    await runDumpConfigSchema(
      () =>
        composeDefaultEntries({
          env: options.env ?? process.env,
          ...(invocation.patches !== undefined && { patches: invocation.patches }),
          warn: (message) => printer.error(message),
        }),
      { out: (text) => printer.log(text.trimEnd()), err: (text) => printer.error(text.trimEnd()) },
    );
    return;
  }

  // **只印出貨那一層**（#740）：不讀 home 覆寫檔、不解析 home 路徑，所以覆寫檔壞了它照樣印得出來。
  if (invocation.dumpDefaultConfig) {
    printer.log(renderShippedConfigDump().trimEnd());
    return;
  }

  // **在 `--session-log` 那些解析之前**：`--dump-config` 印的是設定，而設定跟日誌落在哪裡
  // 無關——先擋在後面的話，一個指錯地方的 `--session-log` 會讓你連設定都看不到。
  if (invocation.dumpConfig) {
    printer.log(
      renderLayeredConfigDump({
        env: options.env ?? process.env,
        ...(invocation.patches !== undefined && { patches: invocation.patches }),
        warn: (message) => printer.error(message),
      }).trimEnd(),
    );
    return;
  }

  // **真模型路徑的啟動環境：兩層 `.env`**（#730）。排在一切之前，壞的 `.env`（設了只有啟動環境能設的名字）
  // 與舊位置搬家訊息在什麼都還沒起來的時候就講。沒帶 `--live` 不讀任何 `.env`，同以前。
  const liveLaunch = invocation.live
    ? loadLiveLaunchEnv({
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        ...(options.env !== undefined && { env: options.env }),
      })
    : undefined;

  // **對外代理：啟動流程的第一件事**（#746），排在載完環境之後、第一顆外掛載入之前。假模型路徑沒有 `.env`，
  // 用只有行程環境的那一層。收尾一定還原，不然同一個行程裡後面的呼叫會繼承這一次的派送器與環境。
  const disposeProxy = await installLaunchProxy(
    liveLaunch?.launchEnv ?? processLaunchEnv(),
    (message) => printer.error(message),
  );
  try {
    await runLaunched(options, invocation, printer, liveLaunch);
  } finally {
    await disposeProxy();
  }
}

/** {@link runCli} 在啟動環境與代理都就位之後的其餘部分：載清單、組裝、跑。 */
async function runLaunched(
  options: RunCliOptions,
  invocation: CliInvocation,
  printer: Printer,
  liveLaunch: LiveLaunch | undefined,
): Promise<void> {
  // **清單只有一個來源：出貨的 `cordis.yml` 加上使用者那兩層**（#454、#455）。**它排在日誌
  // 之前，那是承重的**（#612）：落盤掛不掛由清單上 `session-persistence` 那一列講，而下面讀續接、
  // 解析日誌根都要先知道答案——關掉的時候一件都不該做。清單在這裡載也讓設定寫壞的那一類錯
  // 早於續接拿租約，拋了沒有東西要放。
  const loaded = await loadDefaultPlugins({
    env: options.env ?? process.env,
    ...(invocation.patches !== undefined && { patches: invocation.patches }),
  });
  // **掉了哪幾列在這裡判第一次**（#751）：模組載不進來、設定驗不過的列已經標成沒掛；必掛的掉了就在這裡起不來，
  // 早於下面任何一個 `startupSetting`，也早於建模型（`--live` 時 `live-model` 那一列掉了不退回預設值）。
  // 可少掛的掉了先不印，等組裝那一次（下面 `createCliAgent`）補完再合成一段。
  auditStartupEntries(loaded, { live: invocation.live });
  const { plugins } = loaded;
  const persistenceMounted = startupEntryMounted(plugins, sessionPersistencePlugin);
  assertPersistenceFlags(
    invocation,
    persistenceMounted,
    dropReasonsOf(loaded, sessionPersistencePlugin),
  );
  // **起動期解一次**。值不合法跟清單上其他列的毛病落在同一個時刻——跑起來之前。
  const persistenceWindow = startupSetting(plugins, sessionPersistencePlugin);
  // 真實供應商的連線值（#545）。
  const liveModel = startupSetting(plugins, liveModelPlugin);
  // 退回標題的兩個上限（#647）。`startupSetting` 照 schema 驗過，寫壞的話在跑起來之前就拋。
  const threadTitle = startupSetting(plugins, threadTitlePlugin);
  // LLM 標題那一列（#650），同上：沒帶 `--live` 也解，寫壞的設定不因為這一次用不到就放過。
  const threadTitleLlm = startupSetting(plugins, threadTitleLlmPlugin);

  // **續接也在建 agent 之前讀**：沙箱模式的起始那一格與 root 日誌的 seed 都是組裝時就要給的
  // 東西，而讀不到（沒有那個目錄、版本太新、壞檔）也該在什麼都還沒起來的時候就講。
  const resumeDir = resolveResumeDir(invocation, options.cwd ?? process.cwd());
  // 後端講話（例如這個平台拿不到寫租約）走 `Printer`，前綴同協調器那條 `[會話日誌]`。
  const sessionLogWarn = (message: string): void => printer.error(`[會話日誌] ${message}`);
  // **一次呼叫只有一個寫入目的地**：續接就寫回那個 run 目錄；否則在日誌根底下開一個新的
  // （#444：沒給 `--session-log` 就是 harness home 底下的 `sessions`）。**根在建 agent 之前
  // 解析**：一個指錯地方的根該在什麼都還沒起來的時候就講，而不是等到第一筆事件寫不進去。
  // 續接那條不解析根——那時根本不寫那裡，拿它擋人（例如 `--workspace ~`）是誤擋。落盤關掉
  // （#612）就一個 store 都不建，根也不解析：只在記憶體裡的一次啟動被那道檢查擋下同樣是誤擋。
  // 兩個工廠都是惰性的：第一次寫入之前不碰磁碟。
  const invariantLogPath = resolveInvariantLogPath(
    invocation.workspace,
    persistenceMounted,
    options.cwd ?? process.cwd(),
    options.env ?? process.env,
  );
  const invariantTap =
    invariantLogPath === undefined ? undefined : createInvariantLog(invariantLogPath);
  const sessionStore = !persistenceMounted
    ? undefined
    : resumeDir === undefined
      ? createJsonlSessionStore({
          rootDir: resolveSessionLogDir(
            invocation,
            options.cwd ?? process.cwd(),
            options.env ?? process.env,
          ),
          warn: sessionLogWarn,
        })
      : openJsonlSessionStore({ directory: resumeDir, warn: sessionLogWarn });
  // 過大工具結果的暫存（#734）：根與保留天數從清單解一次；**啟動時清一次**超過保留期的會話目錄（別人改得動的根
  // 不清）。清理失敗只講一聲，不擋啟動。
  const stashConfig = startupSetting(plugins, toolResultStashPlugin);
  const stashRoot = resolveToolResultStashRoot(stashConfig, options.env ?? process.env);
  const stashWarn = (message: string): void => printer.error(message);
  // 外溢層的預算（#719）：省略就是不掛。
  const spillPolicy = startupSetting(plugins, spillPolicyPlugin);
  await cleanupToolResultStash(stashRoot, stashConfig.cleanupPeriodDays, { warn: stashWarn });
  // 關掉時 `--resume` 已經被 `assertPersistenceFlags` 擋下，所以有 `resumeDir` 就一定有 store。
  const resumed =
    resumeDir === undefined || sessionStore === undefined
      ? undefined
      : // 當掉那一輪的收尾在這裡寫回檔上（#721），下面吃 `resumed.events` 的各處拿到的已含補結。
        await resumeClosingInterruptedTurn(sessionStore, THREAD_ID);
  // 模式從日誌來；那一次跑沒有 fence（一顆 `sandbox/mode` 都沒有）就照常從預設起算。
  // `--sandbox` 在這條路上已經被 `parseCliArgs` 擋掉，所以這裡不會蓋掉任何人給的值。
  const resumedSandbox = resumed === undefined ? undefined : recordedSandboxMode(resumed.events);
  // 日誌記著模式，就表示上一次有 fence（沒給 `--workspace` 一顆都不寫）。這一次不給的話
  // 檔案跑在虛擬 FS、fence 不在路徑上，接回來的 `read-only` 會**靜靜蒸發**——與
  // `--sandbox 要配 --workspace` 同一個理由，所以也同樣在什麼都還沒起來之前擋下。
  const resumedApprovalPolicy =
    resumed === undefined ? undefined : recordedApprovalPolicy(resumed.events);
  const effective = {
    ...invocation,
    ...(resumedSandbox !== undefined && { sandbox: resumedSandbox }),
    ...(resumedApprovalPolicy !== undefined && { approvalPolicy: resumedApprovalPolicy }),
  };

  // **續接那個把手在讀之前就拿了寫租約**，要到日誌掛上之後才有人收（`persistence.dispose`）。
  // 這中間任何一步拋錯都要先放掉它（try 一路包到掛上日誌之前，連同三個 attach）：CLI 行程會退出、kernel 會放，但同一個行程裡的呼叫端
  // （測試、將來 serve 的續接）會撞上自己沒放的鎖。
  let built: Awaited<ReturnType<typeof createCliAgent>>;
  let restored: Awaited<ReturnType<typeof restoreConversation>> | undefined;
  try {
    // **先認它屬於哪個目錄**（見 `resume-guards.ts`）。排在沙箱那道檢查前面：
    // 目錄不對的話，日誌裡記的是哪一格都不該拿來判。讀回來還沒寫過任何一筆，檔案原封不動；
    // 它在 try 裡面，所以拋了也會放掉續接那把租約。
    const resumeCwd = options.cwd ?? process.cwd();
    if (resumed !== undefined) assertSameCwd('--resume', THREAD_ID, resumed.header, resumeCwd);
    // **再認它跑在哪個工作區底下**（#504）。排在目錄那道後面、沙箱那道前面，理由同上一段：
    // 目錄不對的話這一格也不該拿來判。**這裡自己算一次根**，因為 `createCliAgent` 還沒跑
    // ——而一道要在「什麼都還沒起來之前」響的檢查等不到它。算的是同一個 `resolveWorkspaceRoot`
    // 與同一個 cwd，所以跟組裝拿到的是同一個值，不是第二份 `resolve(cwd, ...)`。
    if (resumed !== undefined) {
      assertSameWorkspaceRoot(
        '--resume',
        THREAD_ID,
        resumed.header,
        resolveWorkspaceRoot(invocation.workspace, resumeCwd),
      );
    }
    if (resumedSandbox !== undefined && invocation.workspace === undefined) {
      throw new Error(
        `--resume 要配 --workspace：上一次跑在 --workspace 底下（日誌記著沙箱模式 ` +
          `${resumedSandbox}），沒有 --workspace 的話那道 fence 不在路徑上，` +
          `接回來的模式一個位元組都影響不到。\n\n${USAGE}`,
      );
    }
    // 重名、`requires` 缺件、`apply` 拋錯與 fold 的前置條件都在這一步發生——全在跑起來之前。**掉了哪幾列在這裡判
    // 第二次**（#751）：清單上可少掛的列自己的失敗只讓它掉；必掛的、組裝點自己加的外掛掉了，換成跟第一次同一種
    // `StartupError`，兩次掉的一起列；fold 的前置條件照舊原樣拋。
    built = await createCliAgent(
      {
        ...effective,
        liveModel,
        ...(liveLaunch !== undefined && { credentials: liveLaunch.credentials }),
        threadTitle,
        threadTitleLlm,
        optionalEntries: optionalEntriesOf(loaded, { live: invocation.live }),
        // 會話鑰匙是這一次的 run 目錄（續接時就是被接回的那個），沒有會話日誌就沒有「回到同一個會話」的身分。
        ...(sessionStore !== undefined && {
          toolResultStash: {
            rootDir: stashRoot,
            session: sessionStore.directory,
            warn: stashWarn,
          },
          ...(spillPolicy.maxInlineTokens !== undefined && {
            spillPolicy: { maxInlineTokens: spillPolicy.maxInlineTokens },
          }),
        }),
      },
      plugins,
      options.cwd,
      {
        // **不繞過 `Printer`。** 違規跟 agent 的輸出落在同一個終端機上，前綴是唯一分得出
        // 誰在講話的東西——同 `printInterrupt` 的 `[核准]`。訊息本身已經帶著
        // `invariant violated by "<pkg>"`，所以擁有它的 package 不必在這裡再講一次。
        onInvariantViolation: (error) => printer.error(`[不變量] ${error.message}`),
        // 量測記錄（#976）：違規照上面那行印出來，另外留一份可數的紀錄，並記下這一輪實際裝上了哪幾個檢查。
        // 落盤關掉或 home 在工作區底下時沒有 tap，理由見 `resolveInvariantLogPath`。
        ...(invariantTap !== undefined && { invariantTap }),
        // **這個入口沒有人在。** 收核准決定的介面在 web（`serve.ts` 那條刻意不傳這個），
        // 這裡按不下去，所以停在核准點只有一個結局：整輪作廢。關掉之後被擋的那個工具
        // 拿到一則模型讀得懂的拒絕，其餘照跑完（[#113](https://github.com/DemianLi/nexus-agent/issues/113)）。
        approvals: HEADLESS_APPROVALS,
        rootSeed: resumed?.events,
      },
    ).catch((error: unknown) => {
      throw error instanceof AssemblyDropError
        ? startupErrorFrom(loaded, error, { live: invocation.live })
        : error;
    });
    // 兩次合起來印一段到標準錯誤，只印這一次（卡上第 5 項）。
    for (const line of startupWarning(
      loaded,
      assemblyDropsOf(loaded, built.dropped),
      built.warnings,
    )) {
      printer.error(line);
    }
    // **對話從日誌推回模型**（#306），在第一輪之前。放在 try 裡：灌不進去要放掉續接那把租約。
    restored =
      resumed === undefined
        ? undefined
        : await restoreConversation(built.agent, THREAD_ID, resumed.events);
    // REPL 是一條連續對話，一份日誌就是整個 session，所以接線點在這裡而不是每輪。
    // 回傳的把手不留：`dispose()` 會把還接著的協調器一起收掉，不變量的 runner 只是一個訂閱，行程走了它就沒了。
    built.attachSessions(built.sessions);
  } catch (error) {
    await resumed?.stored.close().catch(() => {});
    throw error;
  }
  const { agent, commands, dispose, goals, sessions, sessionLog, telemetrySharing, workspaceRoot } =
    built;
  // **接在最後，而且是四個裡唯一一個出口。** 前三個是觀察者，落盤不改變任何人看得到
  // 什麼，所以順序在功能上沒有差別；排在最後是為了讓讀的人看到的因果跟實際一致——
  // 先被檢查、被參與者看過，才寫下去。
  //
  // 落盤關掉（#612）就不接：一個 store 都沒建，日誌只在註冊表的記憶體裡。
  //
  // **新建的 header 帶建置版本、插件清單與設定雜湊**（#1025）。清單是上面 `loadDefaultPlugins` 疊好的那一份，
  // 跟 `--dump-config` 印的同源，不再疊一次；落盤關掉就不算（連設定雜湊的鍵檔都不建）。
  const buildMetadata =
    sessionStore === undefined
      ? undefined
      : await resolveSessionHeaderMetadata({
          entries: loaded.entries,
          env: options.env ?? process.env,
          ...(invocation.workspace !== undefined && { workspace: invocation.workspace }),
          cwd: options.cwd ?? process.cwd(),
          warn: (message) => printer.error(`[會話日誌] ${message}`),
        });
  const persistence =
    sessionStore === undefined
      ? undefined
      : attachSessionPersistence(sessions, sessionStore, {
          cwd: options.cwd ?? process.cwd(),
          ...(buildMetadata !== undefined && { buildMetadata }),
          // 模型型錄 id 只進 root（#1025）；假模型不是型錄裡的一筆，不寫。
          ...(invocation.live && { rootModelEntryId: liveModel.modelId }),
          // 批次窗口：上面從清單解出來的那一份。
          windowMs: persistenceWindow.windowMs,
          // **錨（#504）取的是組裝真的用的那一個**，不是在這裡再算一次：`createCliAgent`
          // 回著它正是為了這個。沒給 `--workspace` 就不寫那一格。
          ...(workspaceRoot !== undefined && { workspaceRoot }),
          // 續接：root 那一份往原檔續寫，只寫還沒存的後綴（第一筆就是 `session/end-seed`）。
          ...(resumed !== undefined && {
            resumedRoot: { stored: resumed.stored, storedCount: resumed.events.length },
          }),
          // **背景寫入被拒只有這一行看得見**（協調器自己吞掉，響亮的那次歸 `flush`）。
          // 走 `printer.error` 而不是 `console.warn`，理由同不變量那條：前綴是唯一分得出
          // 誰在講話的東西。
          warn: (message) => {
            printer.error(`[會話日誌] ${message}`);
          },
        });
  // **LLM 標題（#650）接在落盤之後**，所以它寫的兩顆照常落地。它自己不在任何一輪裡，失敗只講一聲。收尾時先拆它
  // 再收落盤：拆掉會中止還在跑的那一次（一次性路徑上行程多半比標題先結束），之後回來的寫不進去，同 dsh 的拆卸。
  const detachTitle = built.attachTitle?.(sessionLog, (message) => {
    printer.error(`[標題] ${message}`);
  });

  // 一輪跑壞了也要收——資源的所有權跟這一次呼叫綁在一起，不跟它成不成功綁在一起。
  //
  // **刻意不是 `finally`。** `finally` 裡的 `await dispose()` 一旦自己拋錯，會把 try 裡
  // 原本那個錯誤整個蓋掉，使用者看到的變成「關機清理失敗」而不是真正壞掉的那件事。
  // 所以分兩條：跑壞了就先保住原本的錯誤（與 `agent-factory.ts` 同一條規則），跑成功了
  // 清理失敗就要讓人知道——沒收乾淨代表可能有子行程還活著。
  try {
    // **印的是這一次真的用的那一個**（#545），不是預設值——部署在 patch 裡換了模型的話，印預設
    // 就是一句謊話。
    printer.log(`模型：${invocation.live ? liveModel.modelId : '假模型（ScriptedChatModel）'}`);
    printer.log(
      invocation.workspace === undefined
        ? '檔案系統：虛擬（不碰磁碟）'
        : `檔案系統：${resolve(options.cwd ?? process.cwd(), invocation.workspace)}` +
            `（變更圍堵在它之下，起始 mode: ${effective.sandbox ?? 'workspace-write'}` +
            `${resumedSandbox === undefined ? '' : '（從續接的日誌來）'}，` +
            `/${SANDBOX_COMMAND_NAME} 切得動）`,
    );
    printer.log(APPROVAL_DISCLOSURE);
    // 第四行是**披露**，不是設定。tracing 開沒開不由這支程式決定——基座讀到環境變數就
    // 自己掛 tracer——所以這裡唯一能做的是把「現在是什麼狀態」講出來。不講的話，
    // 「工具參數正在往第三方送」與「什麼都沒送」在畫面上一模一樣。
    for (const line of formatTracingDisclosure(readTracingDisclosure(options.env ?? process.env))) {
      printer.log(line);
    }
    // 第五行是**另一道 seam** 的披露。遙測後端是我們自己掛的，跟上面那道讀環境變數的
    // tracing 沒有關係——併成一行講會讓兩個不同的出境目標看起來像同一個開關。
    // 印在這裡是因為**答案到這一刻才存在**：plugin 跑過 `apply` 之前沒有人知道掛了什麼。
    for (const line of formatTelemetryDisclosure(telemetrySharing)) {
      printer.log(line);
    }
    // 第六行是**第三個出境目標**的披露：tracing 送去第三方、遙測送去後端，這一個留在
    // 本機磁碟上。三個分開講，因為三個各自開關——而且日誌裡有使用者打的每一句話，
    // 「有沒有在寫、寫去哪」不該要讀文件才知道。
    printer.log(
      // **關掉的那一支也要講**（#612）：#444 之後「只在記憶體裡」只剩設定關掉這一條路，而它跟
      // 「正在寫」在畫面上本來一模一樣。講出是哪一列關的，想恢復的人才知道去改哪裡。
      sessionStore === undefined
        ? SESSION_LOG_OFF_DISCLOSURE
        : restored === undefined
          ? `會話日誌：${sessionStore.directory}`
          : // **照實講回來的是什麼**（#251 的最後一段）：對話回不回得來看推的結果（#306），
            // 推不出來時講原因。回不來的也講——不講的話，一個讀暫存路徑讀到 ENOENT 的模型看起來像壞了。
            `會話日誌：${sessionStore.directory}（續接：沙箱模式、計劃模式與目標照日誌回來；` +
            `${formatConversationRestore(restored)}；` +
            `${invocation.workspace === undefined ? '虛擬檔案系統與' : ''}會話歷史檔沒有回來）`,
    );
    // 接回來的計劃模式開著——見 `RESUMED_PLAN_MODE_NOTICE`。**只在這次組裝真的掛了 `/plan`
    // 時講**：一份 patch 可以把計劃模式那一列關掉，那時日誌上那顆 `plan/mode` 沒有人讀，
    // 講了就是在說一個不存在的模式。
    if (
      resumed !== undefined &&
      commands.find(PLAN_COMMAND_NAME) !== undefined &&
      recordedPlanMode(resumed.events) === true
    ) {
      printer.log(RESUMED_PLAN_MODE_NOTICE);
    }
    // 第七行：**這一輪結束之後還會不會有下一輪**。前六行講的是東西往哪裡去，這一行講
    // 的是誰在推——而那是 `--goal-driver` 落地之後畫面上唯一看得出來的差別。
    printer.log(formatGoalDriverDisclosure(invocation.goalDriver, invocation.maxGoalRounds));

    const driver = invocation.goalDriver
      ? goalDriverPort(
          goals,
          () => sessionLog,
          async () => void (await persistence?.flush()),
          (message) => printer.error(message),
        )
      : undefined;

    if (invocation.prompt !== undefined) {
      printer.log(`> ${invocation.prompt}\n`);
      await runTurn(agent, invocation.prompt, printer, sessionLog, threadTitle);
      if (driver !== undefined)
        await driveGoalRounds(agent, printer, sessionLog, driver, invocation.maxGoalRounds);
    } else {
      printer.log('輸入 /help 看有哪些命令，/exit 或按 Ctrl-D 結束。\n');
      await runRepl(
        agent,
        { input: options.input, output: options.output },
        printer,
        sessionLog,
        commands,
        driver,
        invocation.maxGoalRounds,
        threadTitle,
      );
    }
  } catch (error) {
    // 跑壞了也要盡量把已經記下來的事件寫下去——**但不能讓它蓋掉原本的錯誤**，
    // 同下面那條「先保住原本的錯誤」的規則。
    await detachTitle?.().catch(() => {});
    await persistence?.dispose().catch(() => {});
    await dispose().catch(() => {});
    throw error;
  }

  // **這一行不能省，而且它的失敗要往外走。** 協調器的 `dispose` 做最後一次 flush，
  // 窗口還沒到期的那些就靠它落地——拿掉這一行，四條端到端斷言當場紅（實測）。不接住
  // 它是因為「日誌沒寫完」正是這條路上使用者最需要知道的事。
  //
  // **排在 `dispose()` 之前是預防，不是今天量得出來的差別**：兩行對調，那四條照樣綠
  // （也實測過）。留著這個順序的理由是 plugin 的 disposer 一跑，後端就可能被它的擁有者
  // 收掉，而那時還在飛的寫入就沒有人接了——今天的後端是我們自己 `new` 的，所以碰不到；
  // 哪天後端由 plugin 提供，順序就會開始有意義。**別把它讀成一條驗過的因果。**
  await detachTitle?.();
  await persistence?.dispose();
  await dispose();
}

/** 撞到自己的迴圈上限時的退出碼。見 {@link exitCodeFor}。 */
export const RECURSION_LIMIT_EXIT_CODE = 2;

/**
 * 一個跑壞的呼叫該用哪個退出碼。
 *
 * **撞到迴圈上限是 {@link RECURSION_LIMIT_EXIT_CODE}，其餘一律 1**（[#362](https://github.com/DemianLi/nexus-agent/issues/362)）。
 * 分開的理由在呼叫端：Proteus 的 adapter 要把「這個 phase 被護欄切掉」與「容器自己死掉」
 * 當成兩種終態，而 stderr 裡只剩一行散文。照 dsh 的做法，上限用盡是一等的終態不是錯誤
 * （`tool-ralph` 的 `budget-limited`、`subagent-claude-code` 的 category `'limit'`）。
 *
 * **判準是 `lc_error_code`，不是比對 `message`。** `GraphRecursionError` 帶著
 * `GRAPH_RECURSION_LIMIT`——那是 LangGraph 封閉字串聯集裡的一員、有維護承諾的識別碼；
 * `Recursion limit of N reached` 那句話則是隨時會改的措辭。不用 `instanceof`：
 * 同一個類別有兩份安裝時它會靜靜地認不得。
 *
 * **這個錯誤物件一路原樣重拋到這裡**（`runTurn`、`runCli` 的兩個 catch 都是 `throw error`），
 * 所以欄位是完好的；把它弄丟的只會是只取 `message` 的那一步，因此判別排在印之前。
 *
 * ⚠️ **只在一次性路徑成立。** REPL 裡撞到上限是印一行然後等下一句（`runRepl` 的 catch
 * 吞掉、不重拋），根本不會退出。
 *
 * @param error - 從 {@link runCli} 拋出來的東西。
 * @returns 行程該用的退出碼。
 */
export function exitCodeFor(error: unknown): number {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { lc_error_code?: unknown }).lc_error_code
      : undefined;
  return code === 'GRAPH_RECURSION_LIMIT' ? RECURSION_LIMIT_EXIT_CODE : 1;
}

/**
 * 行程入口。
 *
 * 退出碼用 `process.exitCode` 而不是 `process.exit()`：後者不等 stdout / stderr 排空，
 * 而被管線接走的輸出正是這支程式失敗時唯一說得出話的地方。
 */
async function main(): Promise<void> {
  try {
    await runCli({ argv: process.argv.slice(2), input: process.stdin, output: process.stdout });
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = exitCodeFor(error);
  }
}

// 被 import 時（測試）不執行，被當作腳本跑時才執行。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
