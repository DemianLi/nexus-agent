/**
 * 跑一條基準任務，把結果收斂成評分器看得懂的形狀。
 *
 * **model 是參數，不是常數** —— 這是整個 eval 分成兩半的接縫：CI 那半傳
 * `ScriptedChatModel`（零憑證、確定性），供應商比較那半傳真模型，跑的是同一份
 * {@link BENCHMARK}、同一組評分器、同一個 runner。**唯一的差別只有這個參數。**
 *
 * 走 `invoke` 而不是 v3 `streamEvents`：這一層要的是「跑完之後做到了什麼」，不是事件
 * 序列。兩條路徑會不會分歧是另一件事，由 [`stream-parity.test.ts`](../stream-parity.test.ts)
 * 釘住（#75 抓到過一次真的分歧，而且是靜默的）。
 *
 * ## 這條路上沒有會話日誌，而那是一個決定
 *
 * 另外兩個入口都有一張會話註冊表——CLI 在 `runCli` 裡建、`serve` 一條 thread 一張
 * （`thread-pump.ts`）——而 eval **一張都沒有**：它組的是 serve 一條 thread 的組裝（`assembly.ts`），但不接
 * 註冊表，所以連行程內的日誌都不存在，更談不上落盤（[#174](https://github.com/DemianLi/nexus-agent/issues/174)）。
 * 組裝因此明著傳 `historySource: 'state'`（出廠的 `log` 沒有日誌就組不起來），見 `assembly.ts`。
 *
 * **今天不接，理由是這條路沒有消費者，不是接不上：**
 *
 * - 這一層要的兩樣東西都不經過日誌。工具呼叫從 `result.messages` 讀，token 用量從
 *   `usage_metadata` 加總（見 {@link BenchmarkRun.usage}）——會話日誌的 `model/usage`
 *   是給人與遙測看的第二本帳，不是這裡的來源。
 * - 日誌是為了跨行程活下去（#172）。基準任務是一次性的：跑完、評分、印出來，沒有人
 *   會回頭讀第 37 次執行的事件序列。
 * - 未來 Proteus 那條要量的是 **CLI**，不是我們自己的基準跑者。
 *
 * **而「決定不接」與「忘了接」在檔案上長得一樣**，所以配一條絆索：
 * [`session-absence.test.ts`](./session-absence.test.ts) 盯著這個檔的 import 行，
 * 出現 `SessionRegistry`／`attachSession`／`attachSessionPersistence` 就紅。那不是禁止
 * ——是要求接的人回來把這一段改掉，順便回答「那落盤呢」。
 */

import { createHash } from 'node:crypto';

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import { AIMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import type { BaseMessage } from '@langchain/core/messages';
import { extractRequest } from '@nexus/core';
import type { AgentModel, PluginEntry } from '@nexus/core';
import type { createNexusAgent } from '../agent-factory.js';
import { toAgentInvocation } from '../messages.js';
import { openBenchmarkAgent } from './assembly.js';
import { ScriptedChatModel } from '../scripted-model.js';
import { BENCHMARK } from './dataset.js';
import type { BenchmarkCase } from './dataset.js';

/** 一次工具呼叫，只留評分要看的兩樣。 */
export interface ObservedToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** 這一輪燒掉的 token。 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** 一次模型呼叫送出的工具：名稱與整份 schema 的雜湊（名稱、說明、參數一起算）。 */
export interface RecordedTool {
  readonly name: string;
  readonly hash: string;
}

/**
 * 一次模型呼叫記下的東西：LangChain 即將送進供應商的 `request/system` 全文、工具，與這一次的用量。
 *
 * 取的位置跟會話日誌的請求快照是同一個（`handleChatModelStart`，見 `@nexus/core` 的 `extractRequest`），所以記到的是洋蔥
 * 走完之後實際送出的，不是組裝前的樣板。用量在呼叫結束才有；被中止的那一次沒有。
 */
export interface ModelCallRecord {
  /** 渲染後的系統提示詞全文（所有系統訊息以空行串起來）。 */
  readonly system: string;
  readonly tools: readonly RecordedTool[];
  inputTokens?: number;
  outputTokens?: number;
}

/** 一條基準任務跑完之後留下的東西。 */
export interface BenchmarkRun {
  readonly caseId: string;
  /** 依發生順序的工具呼叫。 */
  readonly toolCalls: readonly ObservedToolCall[];
  /** 最後那段 AI 文字。一輪都沒說話就是空字串。 */
  readonly finalText: string;
  /**
   * 全程加總的 token 用量。
   *
   * **模型沒回報就是 `undefined`，不是零。** 兩者在成本比較上是完全不同的結論：一個是
   * 「這條路免費」，另一個是「我們不知道」。假模型只在腳本明著給 `usage` 時才回報。
   */
  readonly usage?: TokenUsage;
  /** 依發生順序的每一次模型呼叫（含工具回合之間的每一次）。 */
  readonly calls?: readonly ModelCallRecord[];
}

/**
 * 每次模型呼叫開始時記下請求、結束時回報用量的觀察者。
 *
 * **它存在是為了失敗的執行**：`runBenchmarkCase` 丟出例外時，`result.messages` 跟著沒了，
 * 迴圈上限切掉的那一次可能已經燒了十幾輪的 token（#1002）。只有在呼叫結束的那一刻記帳，
 * 後面不管怎麼死，已經花掉的都留得住。
 *
 * 看不到的：被中止的那一次呼叫（沒有結束事件）。所以失敗那幾次的 token 是**下限**。
 */
export class UsageTally extends BaseCallbackHandler {
  name = 'eval-usage-tally';

  private readonly open = new Map<string, ModelCallRecord>();

  /**
   * @param sink - 每次呼叫結束回報一次用量。
   * @param calls - 給了就在每次呼叫**開始**時推一筆 {@link ModelCallRecord}（結束時補上用量），整輪失敗也留得住已記的。
   * @param toolsOf - 模型自己不在請求選項裡報工具時的備援：回這一刻綁在模型上的工具。
   */
  constructor(
    private readonly sink: (usage: TokenUsage) => void,
    private readonly calls?: ModelCallRecord[],
    private readonly toolsOf?: () => readonly unknown[],
  ) {
    super();
    this.awaitHandlers = true;
  }

  override handleChatModelStart(
    _llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    if (this.calls === undefined) return;
    const invocation = extraParams?.['invocation_params'];
    const options = extraParams?.['options'];
    const { system, header: sent } = extractRequest(messages, invocation, options);
    const header =
      sent.tools === undefined && this.toolsOf !== undefined
        ? extractRequest(messages, {}, { tools: this.toolsOf() }).header
        : sent;
    const record: ModelCallRecord = {
      system,
      tools: (header.tools ?? []).map((tool) => ({
        name: tool.name,
        hash: createHash('sha256').update(JSON.stringify(tool)).digest('hex').slice(0, 12),
      })),
    };
    this.calls.push(record);
    this.open.set(runId, record);
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    for (const generation of output.generations.flat()) {
      const message = (generation as { message?: unknown }).message;
      if (!AIMessage.isInstance(message)) continue;
      const usage = message.usage_metadata;
      if (usage === undefined) continue;
      const record = this.open.get(runId);
      if (record !== undefined) {
        record.inputTokens = (record.inputTokens ?? 0) + usage.input_tokens;
        record.outputTokens = (record.outputTokens ?? 0) + usage.output_tokens;
      }
      this.sink({
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
      });
    }
  }
}

export interface RunBenchmarkOptions {
  /**
   * 每一次模型呼叫的請求與用量記到這裡，**包括後來整輪失敗的那一輪**。省略就只留在回傳值的 {@link BenchmarkRun.calls}
   * （失敗時沒有回傳值，要留住就要自己傳一份）。
   */
  readonly calls?: ModelCallRecord[];
  /**
   * 整份清單換成這一份（測試用：在出貨清單上動一句提示詞）。省略即 serve 的出貨清單。
   * 模型這一列照樣由 {@link model} 換。
   */
  readonly plugins?: readonly PluginEntry[];
  /**
   * 每次模型呼叫結束就回報一次用量，**包括後來整輪失敗的那一輪**。省略即不記。
   *
   * 評分用的 {@link BenchmarkRun.usage} 不走這條（仍然從最終訊息串加總）；這條是給
   * 失敗的執行補帳用的，見 {@link UsageTally}。
   */
  readonly onUsage?: (usage: TokenUsage) => void;
  /** 這一輪用哪個模型。CI 傳假模型，供應商比較傳真模型。 */
  readonly model: AgentModel;
  /**
   * agent 迴圈的上限。省略即組裝點的三態——出貨清單裡有 `recursion-limit`
   * 那一列就用它的，沒有那一列才是 `DEFAULT_RECURSION_LIMIT`（#529）。**基準測試那條路永遠
   * 明著傳**（`compare.ts` 的 `options.recursionLimit ?? EVAL_RECURSION_LIMIT`），所以它恆走
   * 第一態，不會因為誰往清單裡加了那一列而改變。
   *
   * 這一層收得下它，是因為**基準任務要的上限比互動用的緊**：最長的一題期望 3 次工具
   * 呼叫（約 8 個 super-step），而互動 session 可能真的需要一長串。
   */
  readonly recursionLimit?: number;
  /**
   * 整輪的中止訊號。省略即不設上限。
   *
   * **這是迴圈上限管不到的那一半。** 一次跑掉可以是「叫了太多次」，也可以是「叫的次數
   * 不多但每一次都很久」——[#86](https://github.com/DemianLi/nexus-agent/pull/86) 兩種都
   * 量到了（`llama-11b` 25 次多叫 / 792.8 秒；`ultra` 沒幾次卻 420.9 秒）。前者靠
   * {@link recursionLimit}，後者只有時鐘擋得住。
   *
   * **驗這條路的假模型每一輪一定要 await 真的東西**：純 microtask 的迴圈會把計時器餓死，
   * 實測過一次 `AbortSignal.timeout(1000)` 完全沒觸發、跑滿 35.6 秒到迴圈上限才停 ——
   * 那是探針的產物，不是基座的行為（見 [`looping-model.ts`](../looping-model.ts)）。
   */
  readonly signal?: AbortSignal;
}

type EvalAgent = Awaited<ReturnType<typeof createNexusAgent>>['agent'];

/** 基座回的最終狀態，只取我們讀的那一格。 */
interface AgentResult {
  readonly messages: readonly BaseMessage[];
}

/**
 * 跑一條基準任務。
 *
 * 每條任務一個全新的 agent：虛擬 FS 與對話狀態都不跨題，否則第二題的分數會取決於
 * 第一題留下了什麼，而那不是我們要量的東西。
 *
 * @param testCase - 要跑的那條任務。
 * @param options - 模型與選項。
 * @returns 跑完之後的觀測值。
 */
export async function runBenchmarkCase(
  testCase: BenchmarkCase,
  options: RunBenchmarkOptions,
): Promise<BenchmarkRun> {
  const { agent, model, dispose } = await openBenchmarkAgent({
    model: options.model,
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
    ...(options.recursionLimit === undefined ? {} : { recursionLimit: options.recursionLimit }),
  });
  const calls = options.calls ?? [];

  try {
    const invoke = (
      agent as EvalAgent as unknown as {
        invoke(input: unknown, config?: unknown): Promise<AgentResult>;
      }
    ).invoke.bind(agent);
    const boundTools = (model as unknown as { boundTools?: readonly unknown[] }).boundTools;
    const tally = new UsageTally(
      options.onUsage ?? (() => {}),
      calls,
      boundTools === undefined
        ? undefined
        : () => (model as unknown as { boundTools: readonly unknown[] }).boundTools,
    );
    const config = {
      callbacks: [tally],
      configurable: { thread_id: `eval-${testCase.id}` },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const result = await invoke(toAgentInvocation(testCase.prompt), config);
    return summarize(testCase.id, result.messages, calls);
  } finally {
    await dispose();
  }
}

/** 把最終訊息串收斂成觀測值。 */
function summarize(
  caseId: string,
  messages: readonly BaseMessage[],
  calls: readonly ModelCallRecord[],
): BenchmarkRun {
  const ai = messages.filter((message) => AIMessage.isInstance(message));

  const toolCalls: ObservedToolCall[] = [];
  for (const message of ai) {
    for (const call of message.tool_calls ?? []) {
      toolCalls.push({ name: call.name, args: call.args ?? {} });
    }
  }

  const spoken = ai.filter((message) => message.text.trim() !== '');
  const finalText = spoken.at(-1)?.text ?? '';

  const reported = ai
    .map((message) => message.usage_metadata)
    .filter((usage) => usage !== undefined);
  const usage =
    reported.length === 0
      ? undefined
      : {
          inputTokens: sum(reported.map((entry) => entry.input_tokens)),
          outputTokens: sum(reported.map((entry) => entry.output_tokens)),
          totalTokens: sum(reported.map((entry) => entry.total_tokens)),
        };

  return { caseId, toolCalls, finalText, calls, ...(usage === undefined ? {} : { usage }) };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * 出貨的組裝實際送出的 `request/system`：用一顆只回一句話的假模型跑一次，取第一次模型呼叫記下的那一份。
 * 結果檔的提示詞雜湊記的是它，不是組裝前的樣板。
 *
 * @param plugins - 省略即 serve 的出貨清單。
 * @throws {Error} 一次模型呼叫都沒記到。
 */
export async function shippedSystemPrompt(plugins?: readonly PluginEntry[]): Promise<string> {
  const probe = BENCHMARK[0];
  if (probe === undefined) throw new Error('題組是空的');
  const run = await runBenchmarkCase(probe, {
    model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
    ...(plugins === undefined ? {} : { plugins }),
  });
  const system = run.calls?.[0]?.system;
  if (system === undefined) throw new Error('組裝點沒有送出任何一次模型呼叫');
  return system;
}
