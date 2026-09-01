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
 * **三件事刻意留給錯誤自己說話**：plugin 清單載不起來（重名、`requires` 缺件、`apply`
 * 拋錯）、fold 的前置條件不成立、基座擋下這份組裝，全都發生在 agent 跑起來之前，
 * 而這裡不吞：訊息原樣進 stderr，行程以非零狀態退出。**那條傳播路徑只有一條**，
 * 它的端到端測試也因此只有一條（見 [`cli.test.ts`](./cli.test.ts)）。
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type {
  ApprovalPolicy,
  CommandDescriptor,
  CommandRegistrationPoint,
  InvariantError,
  NexusPlugin,
  SessionTelemetrySharingStatus,
} from '@nexus/core';
import { createCommandExecutor } from '@nexus/plugin-commands';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { SessionLog } from '@nexus/core';
import { createCoreInvariantPlugin } from '@nexus/core/invariant';
import { createCommandsInvariantPlugin } from '@nexus/plugin-commands/invariant';
import { createEchoInvariantPlugin } from '@nexus/plugin-echo/invariant';
import { createGoalPlugin } from '@nexus/plugin-goal';
import { createGoalInvariantPlugin } from '@nexus/plugin-goal/invariant';
import { createMcpInvariantPlugin } from '@nexus/plugin-mcp/invariant';
import { createMemoryInvariantPlugin } from '@nexus/plugin-memory/invariant';
import { createPlanModePlugin } from '@nexus/plugin-plan-mode';
import { createPlanModeInvariantPlugin } from '@nexus/plugin-plan-mode/invariant';
import { createQuickJsInvariantPlugin } from '@nexus/plugin-quickjs/invariant';
import { createSkillsInvariantPlugin } from '@nexus/plugin-skills/invariant';
import { createTelemetryOtelInvariantPlugin } from '@nexus/plugin-telemetry-otel/invariant';
import { createValidationInvariantPlugin } from '@nexus/plugin-validation/invariant';
import { createWireInvariantPlugin } from '@nexus/wire/invariant';

import { createNexusAgent, HEADLESS_APPROVALS } from './agent-factory.js';
import type { NexusAgentHandle } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { createLiveModel, loadLiveEnvIfNeeded, LIVE_MODEL_ID } from './live-model.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import { formatTelemetryDisclosure } from './telemetry-disclosure.js';
import { formatTracingDisclosure, readTracingDisclosure } from './tracing.js';
import type { ScriptedTurn } from './scripted-model.js';

/** 一次呼叫解析出來的東西。`prompt` 缺席即 REPL。 */
export interface CliInvocation {
  /** 一次性模式要問的那句話。省略即進 REPL。 */
  readonly prompt?: string;
  /** 用真實供應商而不是假模型。 */
  readonly live: boolean;
  /** plugin 清單的來源模組。省略即 {@link DEFAULT_PLUGINS}。 */
  readonly pluginModule?: string;
  /**
   * 真實磁碟上的可寫根。給了就換成有路徑圍堵的 Disk backend，省略即跑在 state 裡的
   * 虛擬 FS（`StateBackend`，不碰磁碟）。
   */
  readonly workspace?: string;
  /** 只印用法就退出。 */
  readonly help: boolean;
}

export const USAGE = `用法：cli [選項] [要說的話...]

  不給話就進 REPL；給了就跑一輪、印出結果、退出。

選項：
  --live               換成真實供應商（${LIVE_MODEL_ID}），需要 API key
  --plugins <module>   從指定模組載 plugin 清單（預設匯出一個陣列）
  --workspace <dir>    在真實磁碟的這個目錄上跑，變更被圍堵在它之下
                       （省略即虛擬檔案系統，完全不碰磁碟）
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
 * @throws 旗標不認得，或 `--plugins` 沒給值——訊息接上用法。
 */
export function parseCliArgs(argv: readonly string[]): CliInvocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        live: { type: 'boolean', default: false },
        plugins: { type: 'string' },
        workspace: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\n\n${USAGE}`);
  }

  const { values, positionals } = parsed;
  if (values.plugins !== undefined && values.plugins.trim() === '') {
    throw new Error(`--plugins 要給一個模組路徑。\n\n${USAGE}`);
  }
  if (values.workspace !== undefined && values.workspace.trim() === '') {
    throw new Error(`--workspace 要給一個目錄路徑。\n\n${USAGE}`);
  }

  const prompt = positionals.join(' ').trim();
  return {
    ...(prompt.length > 0 && { prompt }),
    live: values.live === true,
    ...(values.plugins !== undefined && { pluginModule: values.plugins }),
    ...(values.workspace !== undefined && { workspace: values.workspace }),
    help: values.help === true,
  };
}

/**
 * 沒指定 `--plugins` 時載的清單。
 *
 * 工具只有 echo 一個——CLI 的預設組裝要能證明「工具真的接上了」，而不是替誰決定該裝什麼。
 * 哪些**工具** plugin 該進預設清單是設定的事，那要等**外部**設定機制才有地方講
 * （[#46](https://github.com/DemianLi/nexus-agent/issues/46)）。
 *
 * **計劃模式與 goal 是第二與第三個例外，理由與那十二個不同**
 * （[#120](https://github.com/DemianLi/nexus-agent/issues/120)）：它註冊的是一個
 * **人打得到的命令**，而命令沒進預設清單就等於不存在——`/plan` 會被 `parseCommand`
 * 判成「名字不認得」，照原樣掉回模型，變成一行沒人懂的純文字。所以「不替誰決定該裝
 * 什麼」在這裡撞上「那就誰也用不到」，而後者比較貴。
 *
 * 它進來的代價要講清楚，三筆：
 *
 * - **`startActive` 是關的**，所以預設行為與這行改動之前一模一樣：不打 `/plan` 的話，
 *   指引一個 token 都不夾。
 * - **`exit_plan_mode` 一律出現在面向模型的工具清單裡**（照 dsh：模式轉換不該額外造成
 *   工具目錄變動）。CLI 上它是活的 schema、死的執行路徑——模式外撞 middleware、模式內
 *   撞 {@link HEADLESS_APPROVALS} 的確定性拒絕。
 * - **[`serve.ts`](./serve.ts) 也吃這份清單**，而那條路上現在有命令介面了
 *   （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）：web 那端自己打
 *   `/plan` 就進得去，而且核准是開著的，所以「規劃 → 交計劃 → 有人按批准 → 開始動手」
 *   整條走得完——那是 CLI 這條路走不完的（`HEADLESS_APPROVALS` 會確定性拒絕）。
 *
 * **`@nexus/plugin-goal` 走同一條例外，代價不一樣**
 * （[#126](https://github.com/DemianLi/nexus-agent/issues/126)）：它註冊 `/goal`，而
 * 上一句話對它同樣成立——命令沒進清單，`/goal 把測試修綠` 會掉回模型變成一句閒聊。
 * 它的代價只有一筆，而且比計劃模式輕：**每一次執行多接一位會話參與者**。它不註冊工具、
 * 不改 prompt、不碰 backend，所以不打 `/goal` 的話 token 與工具清單都跟這行改動之前
 * 一模一樣；沒有目標時它連一顆事件都不寫。
 *
 * **域與命令是同一個 plugin**，不像 dsh 拆成兩個套件——理由寫在
 * `@nexus/plugin-goal` 的檔頭上。
 *
 * **十二個不變量配套入口是那句話的例外，而例外要說得出理由**
 * （[#107](https://github.com/DemianLi/nexus-agent/issues/107) 拍板）：
 *
 * - **它們不裝功能，只裝觀察。** 一個配套入口不註冊工具、不改 prompt、不碰 backend，
 *   所以「替誰決定該裝什麼」這個顧慮對它們不成立——沒有人的 agent 因為它們而不一樣。
 * - **關得掉。** [#104](https://github.com/DemianLi/nexus-agent/issues/104) 之後條目層有
 *   `disabled`、組裝點有 `invariants` 選擇，所以進來不是單向門。這是它進得來的前提。
 * - **十二個全進，不是只有 `@nexus/core`。** 八個是空 installer，掛上去一個檢查都不裝，
 *   買到的只有包名歸屬；真的在檢查的是四個——`@nexus/core`（turn 配對）、
 *   `@nexus/plugin-commands`（命令生命週期配對，
 *   [#118](https://github.com/DemianLi/nexus-agent/issues/118)）與
 *   `@nexus/plugin-plan-mode`（`/plan` 的參數契約，
 *   [#120](https://github.com/DemianLi/nexus-agent/issues/120)）與 `@nexus/plugin-goal`
 *   （耐久 goal 串，[#126](https://github.com/DemianLi/nexus-agent/issues/126)）。
 *   **代價是每一次執行多十二個條目、十二次 `apply`**，而換到的是這份
 *   清單與 `registry.invariants.companions()` 對得起來——少掛的那幾個會讓「這個 package
 *   沒有可檢的關係」與「這個 package 的檢查沒掛上」在診斷裡長得一模一樣。
 *
 * 違規往哪裡印見 {@link runCli} 接線的那一行。
 */
export const DEFAULT_PLUGINS: readonly NexusPlugin[] = [
  createEchoPlugin(),
  createPlanModePlugin(),
  createGoalPlugin(),
  createCoreInvariantPlugin(),
  createCommandsInvariantPlugin(),
  createEchoInvariantPlugin(),
  createGoalInvariantPlugin(),
  createMcpInvariantPlugin(),
  createMemoryInvariantPlugin(),
  createPlanModeInvariantPlugin(),
  createQuickJsInvariantPlugin(),
  createSkillsInvariantPlugin(),
  createTelemetryOtelInvariantPlugin(),
  createValidationInvariantPlugin(),
  createWireInvariantPlugin(),
];

/**
 * 從一個模組載 plugin 清單。
 *
 * **這不是 [#46](https://github.com/DemianLi/nexus-agent/issues/46) 的外部設定機制**：
 * 條目的唯一 id 與停用已經在 [#104](https://github.com/DemianLi/nexus-agent/issues/104)
 * 落地了，**沒落地的是逐項覆寫個別 plugin 的設定**——我們這側設定收在工廠閉包裡，
 * 從外面 patch 不了。這裡則只回答「清單從哪個模組來」——組裝點本來就擁有的那個問題。
 * 約定薄到只有一句：模組的預設匯出是一個 plugin 陣列。
 *
 * @param specifier - 模組路徑，相對於 `cwd` 解析。
 * @param cwd - 解析的基準目錄，省略即行程的工作目錄。
 * @returns 該模組匯出的清單。
 * @throws 模組載不起來，或它的預設匯出不是陣列——兩種都指名是哪個模組。
 */
export async function loadPluginModule(
  specifier: string,
  cwd: string = process.cwd(),
): Promise<readonly NexusPlugin[]> {
  const path = resolve(cwd, specifier);
  let module: { default?: unknown };
  try {
    // 兩步各修一件事：`resolve` 讓路徑相對於**使用者站的地方**，而不是相對於這個檔案
    // （裸的相對 specifier 在 `import()` 裡是後者）；`pathToFileURL` 是為了 Windows——
    // `C:\...` 這種絕對路徑不是合法的 import specifier，POSIX 上兩者才恰好等價。
    module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`載不了 plugin 清單模組 ${path} — ${reason}`, { cause: error });
  }

  if (!Array.isArray(module.default)) {
    throw new Error(
      `${path} 的預設匯出不是陣列（拿到 ${typeof module.default}）。` +
        `--plugins 指的模組要 \`export default [ ... ]\` 一份 plugin 清單。`,
    );
  }
  return module.default as readonly NexusPlugin[];
}

/**
 * 假模型的腳本：呼叫一次 echo 再回一句話。
 *
 * **它是對著 {@link DEFAULT_PLUGINS} 寫的。** 換了 `--plugins` 就該一起換 `--live`——
 * 腳本裡的工具名在別份清單裡多半不存在，那時假模型只會製造一個看不懂的失敗。
 * 腳本三輪，而第一句話就用掉兩輪（呼叫工具、拿到結果再回覆），所以假模型下的 REPL
 * 問到第三句就會用完（`ScriptedChatModel` 選擇當場失敗而不是靜默重播）；REPL 的正經
 * 用法是 `--live`。
 */
/** 假模型腳本寫出去的那個檔。測試靠它確認檔案真的落在 `--workspace` 指的目錄底下。 */
export const CLI_PROBE_FILE = '/cli.md';

const CLI_SCRIPT: readonly ScriptedTurn[] = [
  {
    content: '先回聲一次，確認工具接得上。',
    toolCalls: [{ name: ECHO_TOOL_NAME, args: { message: 'CLI 接線測試' } }],
  },
  {
    // 再寫一個檔。**這一輪是給 `--workspace` 用的**：預設的虛擬 FS 底下它只是讓
    // 「虛擬檔案系統：…」那行有東西可印，換成真實磁碟時它就是「檔案真的落在那個
    // 目錄底下」的證據。少了它，`--workspace` 給了跟沒給在畫面上分不出來。
    content: '再寫一個檔，確認檔案系統接得上。',
    toolCalls: [{ name: 'write_file', args: { file_path: CLI_PROBE_FILE, content: 'CLI 寫的' } }],
  },
  { content: '工具回來了，這條線是通的。' },
  { content: '假模型只會照腳本說話——要真的對話請用 --live。' },
];

const SYSTEM_PROMPT = [
  '你是 nexus-agent 的命令列助手。',
  '需要動用工具時就真的呼叫，不要只在文字裡描述你打算做什麼。',
].join('\n');

/** REPL 與一次性模式共用同一條對話——checkpointer 認的是這個 id。 */
const THREAD_ID = 'cli';

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
 * 依這次呼叫建 model。
 *
 * @param live - 是否用真實供應商。
 * @returns 可以交給組裝點的 model。
 * @throws `--live` 但環境變數裡沒有 key——訊息指名缺哪一個，不 fallback。
 */
function createCliModel(live: boolean): BaseChatModel {
  if (!live) return new ScriptedChatModel({ turns: CLI_SCRIPT });
  loadLiveEnvIfNeeded();
  return createLiveModel();
}

type NexusAgent = NexusAgentHandle['agent'];

/**
 * 組出這次呼叫要用的 agent。
 *
 * **checkpointer 是 REPL 有沒有記性的全部**：一條 REPL 是一條連續對話，而對話狀態
 * 存在 checkpointer 裡、用 {@link THREAD_ID} 認領。自己在外面累積一個 messages 陣列
 * 也能讓 demo 跑起來，但那是把基座已經有的東西再實作一次，而且下一個 phase 要換成
 * 真的持久化時整段都得丟掉。
 *
 * 回傳 model 是為了讓測試看得到送進去的 prompt——照 `spike/spike-agent.ts` 的先例。
 *
 * `dispose` 一路傳到 {@link runCli}——清單裡的 plugin 可能開了活資源（MCP 的 stdio 子行程是
 * 第一個），沒人收的話這支程式印完答案不會退出。
 *
 * **default backend 是組裝點的事，不是 plugin 的事**（[#28](https://github.com/DemianLi/nexus-agent/issues/28)
 * 決議 3）。`--workspace` 換掉的就是它：給了就跑在真實磁碟上、變更被圍堵在那個目錄之下；
 * 省略即 `StateBackend`——虛擬 FS 跑在 state 裡，完全不碰磁碟。**預設不碰磁碟是刻意的**：
 * 一個手動驗證工具不該因為忘了加旗標就動到誰的檔案。
 *
 * @param invocation - 這次呼叫解析出來的東西。
 * @param plugins - 已經載好的 plugin 清單。
 * @param cwd - `--workspace` 的解析基準，省略即行程的工作目錄。
 * @param onInvariantViolation - 不變量違規往哪裡講。**省略是有意義的**：這個工廠兩條路
 *   都在用，而 [`serve.ts`](./serve.ts) 刻意不傳——伺服器那條路徑的違規進的是伺服器
 *   日誌，維持 runner 的預設（[#107](https://github.com/DemianLi/nexus-agent/issues/107)）。
 * @param approvals - 核准政策的 session 開關。**省略是有意義的**，同上一個參數：
 *   [`serve.ts`](./serve.ts) 刻意不傳，維持預設的「有人在」——瀏覽器那端真的按得下去。
 *   CLI 這條傳 {@link HEADLESS_APPROVALS}，因為它收不了核准決定
 *   （[#113](https://github.com/DemianLi/nexus-agent/issues/113)）。
 * @returns 組好的 agent、收掉它的方法，與它用的 model。
 * @throws 清單載入失敗、fold 前置條件不成立，或基座擋下這份組裝。
 */
export async function createCliAgent(
  invocation: Pick<CliInvocation, 'live' | 'workspace'>,
  plugins: readonly NexusPlugin[],
  cwd: string = process.cwd(),
  onInvariantViolation?: (error: InvariantError) => void,
  approvals?: ApprovalPolicy,
): Promise<{
  agent: NexusAgent;
  dispose: () => Promise<void>;
  model: BaseChatModel;
  sessionLog: SessionLog;
  commands: CommandRegistrationPoint;
  attachTelemetry: (log: SessionLog) => (() => Promise<void>) | undefined;
  attachInvariants: (log: SessionLog) => (() => void) | undefined;
  attachSession: (log: SessionLog) => (() => void) | undefined;
  telemetrySharing: SessionTelemetrySharingStatus | undefined;
}> {
  const model = createCliModel(invocation.live);
  const {
    agent,
    commands,
    dispose,
    attachTelemetry,
    attachInvariants,
    attachSession,
    telemetrySharing,
  } = await createNexusAgent({
    model,
    plugins,
    ...(invocation.workspace !== undefined && {
      backend: new ContainedFilesystemBackend({ rootDir: resolve(cwd, invocation.workspace) }),
    }),
    systemPrompt: SYSTEM_PROMPT,
    checkpointer: new MemorySaver(),
    ...(onInvariantViolation !== undefined && { onInvariantViolation }),
    ...(approvals !== undefined && { approvals }),
  });
  // 日誌跟 agent 同壽命：REPL 是一條連續對話，`seq` 要跨輪連續才有意義。
  const sessionLog = new SessionLog(THREAD_ID);
  // **這裡不接線。** 這個工廠兩條路都在用，而 serve 那條不用這份 `sessionLog`——它一個
  // thread 一份，接線點在 {@link ./wire-handler.ts} 建 pump 的那一刻。在這裡接等於幫
  // serve 接上一份永遠不會有事件的日誌，只送得出一筆 `shutdown`。接線交給呼叫端。
  return {
    agent,
    dispose,
    model,
    sessionLog,
    commands,
    attachTelemetry,
    attachInvariants,
    attachSession,
    telemetrySharing,
  };
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
 * @param input - 使用者說的那句話。
 * @param printer - 輸出去處。
 */
export async function runTurn(
  agent: NexusAgent,
  input: string,
  printer: Printer,
  sessionLog: SessionLog,
): Promise<void> {
  let files: Record<string, unknown> = {};

  sessionLog.append('turn/start', { kind: 'message', text: input });
  try {
    for await (const [mode, payload] of await agent.stream(toAgentInvocation(input), {
      streamMode: ['updates', 'values'],
      configurable: { thread_id: THREAD_ID },
    })) {
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
          // **人自己說的那句不再印一次。** 基座把這一輪的輸入訊息掛在**第一個真的
          // 寫了東西的節點**的 update 上（實測：三個 `before_agent` 裡只有回傳非空
          // 更新的那一個帶著它）。照原樣印的話，畫面上會出現
          // `[nexusPlanMode.before_agent] 嗨`——看起來像那個 plugin 在說話，而那句
          // 是使用者三秒前自己打的。
          //
          // **代價**：哪天真的有東西從圖裡插一則 human message 進來（dsh 的
          // `agent.steer()` narration 就是那個形狀），它也會跟著不見。今天沒有那條路。
          if (message.getType() === 'human') continue;
          const label = message.name ? `${node}/${message.name}` : node;
          printer.log(`[${label}] ${message.text.trim() || '(呼叫工具)'}`);
        }
      }
    }
  } catch (error) {
    sessionLog.append('turn/failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  sessionLog.append('turn/end', {});

  const paths = Object.keys(files);
  if (paths.length > 0) {
    printer.log(`虛擬檔案系統：${paths.join('、')}`);
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
 * 這兩份。而 `DEFAULT_PLUGINS` 正是 `cli.ts` 與 [`serve.ts`](./serve.ts) 共用的那一份
 * 清單——註冊上去就是把 REPL 的答案塞給所有人。探索面歸發派它的那一側，這也正是 dsh
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
 */
export async function runRepl(
  agent: NexusAgent,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  printer: Printer,
  sessionLog: SessionLog,
  commands: Pick<CommandRegistrationPoint, 'find' | 'list'>,
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
          await runTurn(agent, text, printer, sessionLog);
        } else if (execution.result.text !== undefined) {
          const write = execution.result.kind === 'error' ? printer.error : printer.log;
          write(execution.result.text);
        }
      } catch (error) {
        printer.error(errorMessage(error));
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
 * 組裝失敗一律往外拋——由 {@link main} 印進 stderr 並把行程的退出碼設成 1。
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

  const plugins =
    invocation.pluginModule === undefined
      ? DEFAULT_PLUGINS
      : await loadPluginModule(invocation.pluginModule, options.cwd);

  // 這一步會擋下重名、`requires` 缺件、`apply` 拋錯與 fold 的前置條件——全在跑起來之前。
  const {
    agent,
    commands,
    dispose,
    sessionLog,
    attachTelemetry,
    attachInvariants,
    attachSession,
    telemetrySharing,
  } = await createCliAgent(
    invocation,
    plugins,
    options.cwd,
    (error) =>
      // **不繞過 `Printer`。** 違規跟 agent 的輸出落在同一個終端機上，前綴是唯一分得出
      // 誰在講話的東西——同 `printInterrupt` 的 `[核准]`。訊息本身已經帶著
      // `invariant violated by "<pkg>"`，所以擁有它的 package 不必在這裡再講一次。
      printer.error(`[不變量] ${error.message}`),
    // **這個入口沒有人在。** 收核准決定的介面在 web（`serve.ts` 那條刻意不傳這個），
    // 這裡按不下去，所以停在核准點只有一個結局：整輪作廢。關掉之後被擋的那個工具
    // 拿到一則模型讀得懂的拒絕，其餘照跑完（[#113](https://github.com/DemianLi/nexus-agent/issues/113)）。
    HEADLESS_APPROVALS,
  );
  // REPL 是一條連續對話，一份日誌就是整個 session，所以接線點在這裡而不是每輪。
  // 回傳的 detach 不留：`dispose()` 會把還接著的協調器一起收掉。
  attachTelemetry(sessionLog);
  // 不變量的 runner 只是一個訂閱，沒有要排空的東西，所以 detach 也不留——行程走了它就沒了。
  attachInvariants(sessionLog);
  // **接在不變量之後**：參與者拿得到的是可寫的日誌，所以它一裝上去就可能記東西，
  // 而那些東西該被已經在看的檢查看到。順序反過來的話，安裝期寫的第一批事件會漏檢。
  attachSession(sessionLog);

  // 一輪跑壞了也要收——資源的所有權跟這一次呼叫綁在一起，不跟它成不成功綁在一起。
  //
  // **刻意不是 `finally`。** `finally` 裡的 `await dispose()` 一旦自己拋錯，會把 try 裡
  // 原本那個錯誤整個蓋掉，使用者看到的變成「關機清理失敗」而不是真正壞掉的那件事。
  // 所以分兩條：跑壞了就先保住原本的錯誤（與 `agent-factory.ts` 同一條規則），跑成功了
  // 清理失敗就要讓人知道——沒收乾淨代表可能有子行程還活著。
  try {
    printer.log(`模型：${invocation.live ? LIVE_MODEL_ID : '假模型（ScriptedChatModel）'}`);
    printer.log(
      invocation.workspace === undefined
        ? '檔案系統：虛擬（不碰磁碟）'
        : `檔案系統：${resolve(options.cwd ?? process.cwd(), invocation.workspace)}（變更圍堵在它之下）`,
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

    if (invocation.prompt !== undefined) {
      printer.log(`> ${invocation.prompt}\n`);
      await runTurn(agent, invocation.prompt, printer, sessionLog);
    } else {
      printer.log('輸入 /help 看有哪些命令，/exit 或按 Ctrl-D 結束。\n');
      await runRepl(
        agent,
        { input: options.input, output: options.output },
        printer,
        sessionLog,
        commands,
      );
    }
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }

  await dispose();
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
    process.exitCode = 1;
  }
}

// 被 import 時（測試）不執行，被當作腳本跑時才執行。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
