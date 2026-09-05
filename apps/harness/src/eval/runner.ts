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
 * （`thread-pump.ts`）——而 eval **一張都沒有**：它直接叫 `createNexusAgent`，繞過了
 * `createCliAgent`，所以連行程內的日誌都不存在，更談不上落盤
 * （[#174](https://github.com/DemianLi/nexus-agent/issues/174)）。
 *
 * **今天不接，理由是這條路沒有消費者，不是接不上：**
 *
 * - 這一層要的兩樣東西都不經過日誌。工具呼叫從 `result.messages` 讀，token 用量從
 *   `usage_metadata` 加總（見 {@link BenchmarkRun.usage}）——會話日誌的 `model/usage`
 *   是給人與遙測看的第二本帳，不是這裡的來源。
 * - 日誌是為了跨行程活下去（#172）。基準任務是一次性的：跑完、評分、印出來，沒有人
 *   會回頭讀第 37 次執行的事件序列。
 * - 未來 Proteus 那條要量的是 **CLI**（`proteus/adapters/dsh.py` 跑的是一次無頭 CLI
 *   呼叫），不是我們自己的基準跑者。
 *
 * **而「決定不接」與「忘了接」在檔案上長得一樣**，所以配一條絆索：
 * [`session-absence.test.ts`](./session-absence.test.ts) 盯著這個檔的 import 行，
 * 出現 `SessionRegistry`／`attachSession`／`attachSessionPersistence` 就紅。那不是禁止
 * ——是要求接的人回來把這一段改掉，順便回答「那落盤呢」。
 *
 * 同一個形狀在這個檔裡已經有先例：`approvals` 明著傳 {@link HEADLESS_APPROVALS} 而不
 * 靠「反正沒有 checkpointer」的巧合（見 {@link runBenchmarkCase} 裡那段註解）。
 */

import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentModel, NexusPlugin } from '@nexus/core';
import { createNexusAgent, HEADLESS_APPROVALS } from '../agent-factory.js';
import { toAgentInvocation } from '../messages.js';
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
}

export interface RunBenchmarkOptions {
  /** 這一輪用哪個模型。CI 傳假模型，供應商比較傳真模型。 */
  readonly model: AgentModel;
  /** plugin 清單。兩邊必須是同一份，否則比的不是模型是組裝。 */
  readonly plugins: readonly NexusPlugin[];
  /** 附加的 system prompt。省略即不加。 */
  readonly systemPrompt?: string;
  /**
   * agent 迴圈的上限。省略即組裝點的預設（`DEFAULT_RECURSION_LIMIT`）。
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
 * @param options - 模型與 plugin 清單。
 * @returns 跑完之後的觀測值。
 */
export async function runBenchmarkCase(
  testCase: BenchmarkCase,
  options: RunBenchmarkOptions,
): Promise<BenchmarkRun> {
  const { agent, dispose } = await createNexusAgent({
    model: options.model,
    plugins: options.plugins,
    // **基準任務是三個入口裡最 headless 的那個**：CI 跑、零憑證、沒有人看著
    // （[#31](https://github.com/DemianLi/nexus-agent/issues/31)）。
    //
    // 今天不設它**看起來**也一樣：這裡沒給 checkpointer，所以核准閘門本來就走
    // `no-channel` 那條確定性拒絕。但那是**推出來的**，不是說出來的——理由會變成
    // 「接不回來」，而真正的理由是「沒有人被問到」。而且哪天有人替多輪基準任務補上
    // checkpointer，那個巧合就沒了：政策一路退回預設的 `true`，一條標了核准的任務會
    // 停在核准點等一個 CI 裡永遠不會來的答案（[#113](https://github.com/DemianLi/nexus-agent/issues/113)）。
    approvals: HEADLESS_APPROVALS,
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.recursionLimit === undefined ? {} : { recursionLimit: options.recursionLimit }),
  });

  try {
    const invoke = (
      agent as unknown as { invoke(input: unknown, config?: unknown): Promise<AgentResult> }
    ).invoke.bind(agent);
    const result = await invoke(
      toAgentInvocation(testCase.prompt),
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    return summarize(testCase.id, result.messages);
  } finally {
    await dispose();
  }
}

/** 把最終訊息串收斂成觀測值。 */
function summarize(caseId: string, messages: readonly BaseMessage[]): BenchmarkRun {
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

  return { caseId, toolCalls, finalText, ...(usage === undefined ? {} : { usage }) };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
