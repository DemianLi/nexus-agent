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
import type { NexusPlugin } from '@nexus/core';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { createNexusAgent } from './agent-factory.js';
import { createLiveModel, loadLiveEnvIfNeeded, LIVE_MODEL_ID } from './live-model.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

/** 一次呼叫解析出來的東西。`prompt` 缺席即 REPL。 */
export interface CliInvocation {
  /** 一次性模式要問的那句話。省略即進 REPL。 */
  readonly prompt?: string;
  /** 用真實供應商而不是假模型。 */
  readonly live: boolean;
  /** plugin 清單的來源模組。省略即 {@link DEFAULT_PLUGINS}。 */
  readonly pluginModule?: string;
  /** 只印用法就退出。 */
  readonly help: boolean;
}

export const USAGE = `用法：cli [選項] [要說的話...]

  不給話就進 REPL；給了就跑一輪、印出結果、退出。

選項：
  --live               換成真實供應商（${LIVE_MODEL_ID}），需要 API key
  --plugins <module>   從指定模組載 plugin 清單（預設匯出一個陣列）
  --help               印這段話

  REPL 裡輸入 /exit 或按 Ctrl-D 結束。`;

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

  const prompt = positionals.join(' ').trim();
  return {
    ...(prompt.length > 0 && { prompt }),
    live: values.live === true,
    ...(values.plugins !== undefined && { pluginModule: values.plugins }),
    help: values.help === true,
  };
}

/**
 * 沒指定 `--plugins` 時載的清單。
 *
 * 只有 echo 一個——CLI 的預設組裝要能證明「工具真的接上了」，而不是替誰決定該裝什麼。
 * 哪些 plugin 該進預設清單是設定的事，那要等外部設定機制
 * （[#46](https://github.com/DemianLi/nexus-agent/issues/46)）啟動才有地方講。
 */
export const DEFAULT_PLUGINS: readonly NexusPlugin[] = [createEchoPlugin()];

/**
 * 從一個模組載 plugin 清單。
 *
 * **這不是 [#46](https://github.com/DemianLi/nexus-agent/issues/46) 的外部設定機制**：
 * 那條講的是 plugin 條目的唯一 id 與逐項覆寫，這裡只回答「清單從哪個模組來」——
 * 組裝點本來就擁有的那個問題。約定薄到只有一句：模組的預設匯出是一個 plugin 陣列。
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
const CLI_SCRIPT: readonly ScriptedTurn[] = [
  {
    content: '先回聲一次，確認工具接得上。',
    toolCalls: [{ name: ECHO_TOOL_NAME, args: { message: 'CLI 接線測試' } }],
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

type NexusAgent = Awaited<ReturnType<typeof createNexusAgent>>;

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
 * @param invocation - 這次呼叫解析出來的東西。
 * @param plugins - 已經載好的 plugin 清單。
 * @returns 組好的 agent 與它用的 model。
 * @throws 清單載入失敗、fold 前置條件不成立，或基座擋下這份組裝。
 */
export async function createCliAgent(
  invocation: Pick<CliInvocation, 'live'>,
  plugins: readonly NexusPlugin[],
): Promise<{ agent: NexusAgent; model: BaseChatModel }> {
  const model = createCliModel(invocation.live);
  const agent = await createNexusAgent({
    model,
    plugins,
    systemPrompt: SYSTEM_PROMPT,
    checkpointer: new MemorySaver(),
  });
  return { agent, model };
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
export async function runTurn(agent: NexusAgent, input: string, printer: Printer): Promise<void> {
  let files: Record<string, unknown> = {};

  for await (const [mode, payload] of await agent.stream(toAgentInvocation(input), {
    streamMode: ['updates', 'values'],
    configurable: { thread_id: THREAD_ID },
  })) {
    if (mode === 'values') {
      files = (payload as { files?: Record<string, unknown> }).files ?? {};
      continue;
    }

    for (const [node, update] of Object.entries(payload as Record<string, unknown>)) {
      const messages = (update as { messages?: BaseMessage[] }).messages ?? [];
      for (const message of messages) {
        const label = message.name ? `${node}/${message.name}` : node;
        printer.log(`[${label}] ${message.text.trim() || '(呼叫工具)'}`);
      }
    }
  }

  const paths = Object.keys(files);
  if (paths.length > 0) {
    printer.log(`虛擬檔案系統：${paths.join('、')}`);
  }
}

/**
 * REPL：一行一輪，直到 `/exit` 或 stdin 收掉。
 *
 * **這一層吞執行期的錯誤**，印完接著問下一句——一輪答壞了不是關掉工具的理由，而手動
 * 驗證正是要一句接一句試。組裝期的錯誤不在這裡：那些在 REPL 開起來之前就拋了。
 *
 * @param agent - 組裝好的 agent。
 * @param io - readline 收發的兩端。
 * @param printer - 輸出去處。
 */
export async function runRepl(
  agent: NexusAgent,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  printer: Printer,
): Promise<void> {
  const rl = createInterface({ input: io.input, output: io.output, prompt: '> ' });
  // `Interface` 的型別沒有 `closed`（執行期有），所以自己記一份。
  let closed = false;
  rl.once('close', () => void (closed = true));
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (text === '/exit') break;
    if (text.length > 0) {
      try {
        await runTurn(agent, text, printer);
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
  const { agent } = await createCliAgent(invocation, plugins);

  printer.log(`模型：${invocation.live ? LIVE_MODEL_ID : '假模型（ScriptedChatModel）'}`);

  if (invocation.prompt !== undefined) {
    printer.log(`> ${invocation.prompt}\n`);
    await runTurn(agent, invocation.prompt, printer);
    return;
  }

  printer.log('輸入 /exit 或按 Ctrl-D 結束。\n');
  await runRepl(agent, { input: options.input, output: options.output }, printer);
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
