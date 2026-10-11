/**
 * **摘要器排在換模型的外面：它拿到的 `request.model` 是換模型之前那顆**——
 * [#1354](https://github.com/DemianLi/nexus-agent/issues/1354)（盤點 [#1340](https://github.com/DemianLi/nexus-agent/issues/1340)
 * 的 F1）。這個檔案不改任何行為，釘的是**今天的實際值**，而那些值是錯的。
 *
 * ## 現象
 *
 * 我們的摘要器與基座同名 `SummarizationMiddleware`，被 `mergeMiddlewareStack` 原地換進基座 core 段的第三格
 * （`packages/nexus-core/src/agent-assembly.ts`）；換模型（`nexusModelSelection`）是新名字，排在基座那幾個**之後**。
 * LangChain 先列者最外層，所以摘要器在換模型**外面**：它看到的 `request.model` 還是組裝時給的預設那顆。
 *
 * 下面這四條各量一件事：
 *
 * 1. **順序**：合併後的疊裡，摘要器在換模型前面。
 * 2. **門檻**：摘要器問 `modelLimits` 的是預設那顆，內層看到的才是選中那顆。
 * 3. **生摘要**：摘要那次模型呼叫打到預設那顆，選中的那顆一次都沒收到。
 * 4. **後果**：選到小窗口的模型之後，摘要的 token 門檻仍按預設那顆算——請求長到選中那顆窗口的好幾倍都不摘要；
 *    同一串輸入換成「那顆小的直接當預設」就會在它的夾窗之下摘要。
 *
 * ## 射程（只量到這裡）
 *
 * - **只量 root。** 子代理的預設疊也是同名換進摘要器，而 `nexusSubagentModelFollow` 同樣是新名字、排在內側，
 *   所以釘了模型的子代理**很可能**有同一個問題——**沒有實測**。
 * - **「請求量是窗口的幾倍」是我們自己的估算器（`estimateAnchoredTokens`）量的**，假模型不擋窗口，所以
 *   「真端點會不會因此拒絕」沒有量（真模型實跑被上游 429 擋著，見 #1343）。
 * - 不是「#723 沒有作用」：對**預設那顆**的夾窗是有效的（第 4 條的對照組），壞的只有「換模型之後窗口跟著換」這一段。
 *
 * ## dsh 怎麼做（`d7432673886`）
 *
 * 門檻與生摘要都跟**路由後**的那顆走：`compaction-basic/src/index.ts:274` 的 `routedTarget(agent.session)`
 * 拿來 `resolveModelInfo` 算窗口；`summarizer.ts:131-138` 的摘要目標是 `configured ?? latest ?? agentTarget`，
 * `latest` 是 `session.requestHeader().config`，也就是最近一次請求走的模型。**這裡沒有「表達不出來」**：
 * 順序是我們同名取代造成的，不是 LangChain 的限制。
 *
 * ## 修的時候這四條怎麼翻
 *
 * 修的方向由修的卡定（挪順序，或讓摘要器自己讀選中的模型）。不論哪個方向，下面 PINNED 那一組要整組翻面，
 * 並且 `fold.ts` 槽位表的註解、`model-selection.ts` 的 `createModelSwapMiddleware` 註解、`image-offload.ts`
 * 的註解（都寫著「摘要器看到的是選中那顆」）要跟著改成真的。**這個 PR 不碰那些註解**：註解寫反是因為順序錯，
 * 方向沒定之前改它們只是換一種錯。
 *
 * **零憑證、零外部連線。**
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  estimateAnchoredTokens,
  MODEL_SELECTION_MIDDLEWARE_NAME,
  ModelSelectionController,
  SessionRegistry,
  SUMMARY_PROMPT,
  TokenAnchorBook,
  windowThreshold,
} from '@nexus/core';
import type { ModelContextLimits, PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 出廠型錄的真數字（`apps/harness/cordis.yml` 的 `live-model`）：預設那顆，與型錄裡窗口最小的那顆。 */
const DEFAULT_LIMITS: ModelContextLimits = { contextWindow: 700_045, maxOutputTokens: 16_384 };
const SMALL_LIMITS: ModelContextLimits = { contextWindow: 32_768, maxOutputTokens: 4_096 };

/** 摘要那次呼叫的提示詞開頭；用它從 `prompts` 裡把摘要請求挑出來。 */
const SUMMARY_MARK = SUMMARY_PROMPT.split('\n')[0]!;

const isSummaryCall = (prompt: readonly BaseMessage[]) =>
  prompt.some((message) => message.text.includes(SUMMARY_MARK));

const script = () => Array.from({ length: 80 }, (_, index) => ({ content: `好 ${index + 1}` }));

/** 預算層用的那把估算器量一次請求（不是 `countTokensApproximately`：兩者差約四倍，混著比會得出假結論）。 */
const sizeOf = (prompt: readonly BaseMessage[]) =>
  estimateAnchoredTokens({ messages: [...prompt] } as never, new TokenAnchorBook()).tokens;

/** agent 身上那份 middleware stack 的名字，與 `summarization.test.ts` 同一個走法；找不到就失敗。 */
function middlewareNames(agent: unknown): string[] {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string[] | null => {
    if (depth > 5 || node == null || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'middleware' && Array.isArray(value)) {
        return value.map((entry) => String((entry as { name?: string })?.name));
      }
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const names = walk(agent, 0);
  if (!names) throw new Error('找不到 agent 的 middleware stack——基座的內部形狀變了。');
  return names;
}

type Label = 'DEFAULT' | 'SMALL' | 'other';

interface Observation {
  /** 摘要器每次問 `modelLimits` 時收到的那顆。 */
  readonly limitsAskedAbout: Label[];
  /** 排在摘要器內側的觀察者看到的 `request.model`。 */
  readonly innerSaw: Label[];
  readonly defaultModel: ScriptedChatModel;
  readonly smallModel: ScriptedChatModel;
  readonly stackNames: string[];
}

interface RunOptions {
  /** `true`：預設那顆當預設、`model.select` 換到小的；`false`：小的直接當預設（對照）。 */
  readonly viaSelection: boolean;
  readonly rounds: number;
  readonly payloadChars: number;
  /** 摘要的門檻；省略＝只留 token 門檻（出廠的 100000）。 */
  readonly trigger?: readonly { type: 'tokens' | 'messages'; value: number }[];
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-f1-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function observe(options: RunOptions): Promise<Observation> {
  const defaultModel = new ScriptedChatModel({ turns: script() });
  const smallModel = new ScriptedChatModel({ turns: script() });
  const labelOf = (model: unknown): Label =>
    model === defaultModel ? 'DEFAULT' : model === smallModel ? 'SMALL' : 'other';
  const limitsAskedAbout: Label[] = [];
  const innerSaw: Label[] = [];
  const controller = new ModelSelectionController({
    defaultRoute: { model: 'default' },
    // 預設那顆回 `undefined`＝沿用組裝時給的那顆（與 `createModelSelectionHost` 同一個約定）。
    instanceFor: (route) => (route.model === 'small' ? smallModel : undefined),
  });
  const observer: PluginEntry = {
    plugin: {
      name: 'swap-order-observer',
      apply: (registry) =>
        void registry.middleware.use({
          name: 'swapOrderObserver',
          wrapModelCall: (request: { model: unknown }, handler: (next: unknown) => unknown) => {
            innerSaw.push(labelOf(request.model));
            return handler(request);
          },
        } as never),
    },
  };
  const built = await createNexusAgent({
    model: options.viaSelection ? defaultModel : smallModel,
    checkpointer: new MemorySaver(),
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    plugins: [observer],
    summarization: {
      ...(options.trigger !== undefined && {
        trigger: options.trigger.map((each) => ({ ...each })),
      }),
      keep: { type: 'messages', value: 2 },
    },
    ...(options.viaSelection && { modelSelection: controller }),
    modelLimits: (model) => {
      limitsAskedAbout.push(labelOf(model));
      return model === defaultModel
        ? DEFAULT_LIMITS
        : model === smallModel
          ? SMALL_LIMITS
          : undefined;
    },
  });
  const sessions = new SessionRegistry('root-1');
  const detach = built.attachSession(sessions, {});
  try {
    if (options.viaSelection) {
      // 組裝點（`createModelSelectionHost`）在 root 日誌 join 時做同一件事。
      controller.attach(sessions.root);
      controller.select({ model: 'small' });
    }
    for (let round = 0; round < options.rounds; round += 1) {
      await built.agent.invoke(
        toAgentInvocation(`第 ${round + 1} 句。${'字'.repeat(options.payloadChars)}`),
        { configurable: { thread_id: 'thread-1' } },
      );
    }
    return {
      limitsAskedAbout,
      innerSaw,
      defaultModel,
      smallModel,
      stackNames: middlewareNames(built.agent),
    };
  } finally {
    detach();
    await built.dispose();
  }
}

const summaryCallsOf = (model: ScriptedChatModel) => model.prompts.filter(isSummaryCall).length;
/** 這顆收到過的、最大的一份**非摘要**請求。 */
const largestRequestOf = (model: ScriptedChatModel) =>
  Math.max(0, ...model.prompts.filter((prompt) => !isSummaryCall(prompt)).map(sizeOf));

/**
 * **釘住今天的實際值——整組都是錯的現況，修的卡要整組翻面。**
 *
 * 每一條旁邊寫著「該有的值」，修的時候照那一行改。
 */
describe('PINNED：摘要器在換模型外面（#1354 F1）', () => {
  it('順序：摘要器排在換模型前面（該有：換模型在前，或摘要器自己讀得到選中的那顆）', async () => {
    const run = await observe({ viaSelection: true, rounds: 1, payloadChars: 10 });
    const summarizer = run.stackNames.indexOf('SummarizationMiddleware');
    const swap = run.stackNames.indexOf(MODEL_SELECTION_MIDDLEWARE_NAME);
    expect(summarizer).toBeGreaterThanOrEqual(0);
    expect(swap).toBeGreaterThanOrEqual(0);
    // 該有：`summarizer > swap`（若走「挪順序」那條路）。
    expect(summarizer).toBeLessThan(swap);
  });

  it('門檻：摘要器問 modelLimits 的是預設那顆；內層看到的才是選中那顆（該有：兩邊都是 SMALL）', async () => {
    const run = await observe({ viaSelection: true, rounds: 1, payloadChars: 10 });
    expect(run.innerSaw).toEqual(['SMALL']);
    // 本樹上問 `modelLimits` 的只有摘要器那兩處（剪刀的壓力判斷與預算層），所以這一串就是摘要器看到的。
    expect(run.limitsAskedAbout.length).toBeGreaterThan(0);
    // 該有：全是 'SMALL'。
    expect(new Set(run.limitsAskedAbout)).toEqual(new Set(['DEFAULT']));
  });

  it('生摘要：摘要那次呼叫打到預設那顆，選中的一次都沒收到（該有：選中那顆生，同 dsh 的 `latest`）', async () => {
    // 用 messages 門檻觸發，與 token 門檻拆開：這一條只量「誰生」，不牽涉窗口。
    const run = await observe({
      viaSelection: true,
      rounds: 5,
      payloadChars: 10,
      trigger: [{ type: 'messages', value: 6 }],
    });
    // 前提：對話真的走在選中那顆上，而且真的摘要過。
    expect(run.innerSaw.every((label) => label === 'SMALL')).toBe(true);
    const bySmall = summaryCallsOf(run.smallModel);
    const byDefault = summaryCallsOf(run.defaultModel);
    // 該有：`bySmall > 0`、`byDefault === 0`。
    expect(byDefault).toBeGreaterThan(0);
    expect(bySmall).toBe(0);
  });

  it('後果：選到小窗口之後，請求長到窗口的好幾倍都不摘要；同一串輸入把它當預設就會夾窗（該有：兩條路徑一樣）', async () => {
    // 十輪、每輪六千字：以出廠的 100000 門檻，摘要器還不到動手的時候；
    // 以 SMALL 的夾窗（`windowThreshold`），早就過了。
    const input = { rounds: 10, payloadChars: 6_000 } as const;
    const ceiling = windowThreshold(SMALL_LIMITS);

    const selected = await observe({ ...input, viaSelection: true });
    const control = await observe({ ...input, viaSelection: false });

    // 對照組：小的當預設，夾窗生效（#723 對預設那顆是有效的），摘要發生、請求沒越過窗口。
    expect(summaryCallsOf(control.smallModel)).toBeGreaterThan(0);
    expect(largestRequestOf(control.smallModel)).toBeLessThan(SMALL_LIMITS.contextWindow);
    expect(largestRequestOf(control.smallModel)).toBeLessThan(ceiling);

    // 選擇路徑：同一個模型、同一串輸入，沒有一次摘要，請求長到它窗口的兩倍以上。
    // 該有：`summaryCallsOf(selected.smallModel) + summaryCallsOf(selected.defaultModel) > 0`，
    // 而且最大請求不超過 `ceiling`。
    expect(summaryCallsOf(selected.smallModel) + summaryCallsOf(selected.defaultModel)).toBe(0);
    expect(largestRequestOf(selected.smallModel)).toBeGreaterThan(SMALL_LIMITS.contextWindow * 1.5);
  });
});
