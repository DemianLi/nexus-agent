/**
 * **摘要器排在換模型的外面，但它讀的是選中的那顆**——
 * [#1369](https://github.com/DemianLi/nexus-agent/issues/1369) 修 [#1354](https://github.com/DemianLi/nexus-agent/issues/1354)
 * （盤點 [#1340](https://github.com/DemianLi/nexus-agent/issues/1340) 的 F1）。
 *
 * ## 現象（修之前）
 *
 * 我們的摘要器與基座同名 `SummarizationMiddleware`，被 `mergeMiddlewareStack` 原地換進基座 core 段的第三格
 * （`packages/nexus-core/src/agent-assembly.ts`）；換模型（`nexusModelSelection`）是新名字，排在基座那幾個**之後**。
 * LangChain 先列者最外層，所以摘要器在換模型**外面**：它看到的 `request.model` 還是組裝時給的預設那顆——門檻按預設那顆的窗口算、
 * 摘要打到預設那顆，選到小窗口的模型之後請求長到它窗口的好幾倍都不摘要。
 *
 * ## 怎麼修的（#1369）
 *
 * **順序不動**（`summarization.test.ts` 釘著第三格），改成讓摘要器自己讀這一步選中的那顆：fold 在摘要器外面包一層
 * `withSelectedModel`（`model-selection.ts`），進來時把 `request.model` 換成選中的實例、往下交時換回原本那顆。選中的實例來自
 * 路由狀態（`ModelSelectionController.peekStepRoute()`，與換模型那顆讀同一份快照），不是中介層的順序——dsh 同方向：
 * `compaction-basic/src/index.ts:274` 的 `routedTarget(agent.session)` 算窗口，`summarizer.ts:127-137` 的摘要目標是
 * `configured ?? latest ?? agentTarget`（`configured` 不在這張卡）。
 *
 * 下面各組各量一件事：
 *
 * 1. **順序**：合併後的疊裡摘要器仍在換模型前面——**刻意不動**；正確性不靠順序。
 * 2. **門檻**：摘要器問 `modelLimits` 的是選中那顆（而且只有它，沒有別的呼叫者混進來）。
 * 3. **生摘要**：摘要那次模型呼叫打到選中那顆，預設那顆一次都沒收到。
 * 4. **後果**：選到小窗口的模型之後，同一串輸入走選擇路徑與「小的直接當預設」一樣會在夾窗之下摘要。
 *
 * ## 子代理與背景圖
 *
 * 子代理的摘要器問的路由與它的跟隨那顆是同一個函式（`subagentRouteOf`），單元測試在 `model-selection.test.ts`；
 * 背景圖（`follow: false`）把摘要器摘回沒包的那份，測試在 `subagent-graph.test.ts`。
 *
 * ## PINNED：溢出的現況（#1374 要整組翻面）
 *
 * 摘要跟著選中的小模型之後，**第一份摘要請求本身**可能比小模型的窗口還大（要摘的是「保留的 20 則」之外的全部，基座不帶
 * `trimTokensToSummarize`，整段塞進一個請求）。這個檔案最後一組釘的是今天的實際值，修的卡是
 * [#1374](https://github.com/DemianLi/nexus-agent/issues/1374)。dsh 在這一點上同樣沒有針對目標窗口的截斷
 * （`index.ts:205-222`：摘要失敗就回原本的請求錯誤）。
 *
 * ## 射程（只量到這裡）
 *
 * - **「請求量是窗口的幾倍」是我們自己的估算器（`estimateAnchoredTokens`）量的**，假模型不擋窗口，所以
 *   「真端點會不會因此拒絕」沒有量（真模型實跑被上游 429 擋著，見 #1343）。
 * - 對**預設那顆**的夾窗一直是有效的（第 4 條的對照組）；壞的是「換模型之後窗口跟著換」那一段，現在修了。
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

describe('摘要器讀選中的那顆（#1369；修 #1354 F1）', () => {
  it('順序：摘要器仍排在換模型前面——刻意不動，正確性來自它自己讀選中的那顆', async () => {
    const run = await observe({ viaSelection: true, rounds: 1, payloadChars: 10 });
    const summarizer = run.stackNames.indexOf('SummarizationMiddleware');
    const swap = run.stackNames.indexOf(MODEL_SELECTION_MIDDLEWARE_NAME);
    expect(summarizer).toBeGreaterThanOrEqual(0);
    expect(swap).toBeGreaterThanOrEqual(0);
    // 方向 (b)：不挪順序（`summarization.test.ts` 釘著第三格）。
    expect(summarizer).toBeLessThan(swap);
  });

  it('門檻：摘要器問 modelLimits 的是選中那顆，而且只有它（兩邊都是 SMALL）', async () => {
    const run = await observe({ viaSelection: true, rounds: 1, payloadChars: 10 });
    expect(run.innerSaw).toEqual(['SMALL']);
    expect(run.limitsAskedAbout.length).toBeGreaterThan(0);
    // 問的人只有摘要器那兩處（剪刀的壓力判斷 `summarization.ts:519`、預算層 `:1017`，#1369 實測呼叫點）；這組沒有圖片，
    // `image-offload` 那幾處不會問。精確相等：混進一個 'DEFAULT' 或 'other'（替身、別的呼叫者）就紅。
    expect(new Set(run.limitsAskedAbout)).toEqual(new Set(['SMALL']));
  });

  it('生摘要：摘要那次呼叫打到選中那顆，預設那顆一次都沒收到（同 dsh 的 `latest`）', async () => {
    // 用 messages 門檻觸發，與 token 門檻拆開：這一條只量「誰生」，不牽涉窗口。
    const run = await observe({
      viaSelection: true,
      rounds: 5,
      payloadChars: 10,
      trigger: [{ type: 'messages', value: 6 }],
    });
    // 前提：對話真的走在選中那顆上，而且真的摘要過。
    expect(run.innerSaw.every((label) => label === 'SMALL')).toBe(true);
    expect(summaryCallsOf(run.smallModel)).toBeGreaterThan(0);
    expect(summaryCallsOf(run.defaultModel)).toBe(0);
  });

  it('後果：選到小窗口之後，同一串輸入走選擇路徑與「小的當預設」一樣會夾窗摘要', async () => {
    // 十輪、每輪六千字：以出廠的 100000 門檻，摘要器還不到動手的時候；以 SMALL 的夾窗（`windowThreshold`），早就過了。
    const input = { rounds: 10, payloadChars: 6_000 } as const;
    const ceiling = windowThreshold(SMALL_LIMITS);

    const selected = await observe({ ...input, viaSelection: true });
    const control = await observe({ ...input, viaSelection: false });

    // 對照組：小的當預設，夾窗生效，摘要發生、請求沒越過窗口。
    expect(summaryCallsOf(control.smallModel)).toBeGreaterThan(0);
    expect(largestRequestOf(control.smallModel)).toBeLessThan(SMALL_LIMITS.contextWindow);
    expect(largestRequestOf(control.smallModel)).toBeLessThan(ceiling);

    // 選擇路徑：同一個模型、同一串輸入，摘要發生在選中那顆上，請求不再長到窗口的兩倍以上。
    expect(summaryCallsOf(selected.smallModel)).toBeGreaterThan(0);
    expect(summaryCallsOf(selected.defaultModel)).toBe(0);
    expect(largestRequestOf(selected.smallModel)).toBeLessThan(SMALL_LIMITS.contextWindow);
    expect(largestRequestOf(selected.smallModel)).toBeLessThan(ceiling);
  });
});

/** 出廠的摘要設定（`summarization` 整個省略）下，在預設那顆上聊到 `preRounds` 輪，再 select 到 SMALL 跑一輪。 */
async function switchAfterLongChat(options: { payloadChars: number; preRounds: number }) {
  const defaultModel = new ScriptedChatModel({ turns: script() });
  const smallModel = new ScriptedChatModel({ turns: script() });
  const controller = new ModelSelectionController({
    defaultRoute: { model: 'default' },
    instanceFor: (route) => (route.model === 'small' ? smallModel : undefined),
  });
  const built = await createNexusAgent({
    model: defaultModel,
    checkpointer: new MemorySaver(),
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    plugins: [],
    modelSelection: controller,
    modelLimits: (model) =>
      model === defaultModel ? DEFAULT_LIMITS : model === smallModel ? SMALL_LIMITS : undefined,
  });
  const sessions = new SessionRegistry('root-1');
  const detach = built.attachSession(sessions, {});
  try {
    controller.attach(sessions.root);
    const say = (round: number) =>
      built.agent.invoke(
        toAgentInvocation(`第 ${round} 句。${'字'.repeat(options.payloadChars)}`),
        {
          configurable: { thread_id: 'thread-1' },
        },
      );
    for (let round = 1; round <= options.preRounds; round += 1) await say(round);
    const historyBeforeSwitch = largestRequestOf(defaultModel);
    const summariesBeforeSwitch = summaryCallsOf(defaultModel);
    controller.select({ model: 'small' });
    await say(options.preRounds + 1);
    return {
      historyBeforeSwitch,
      summariesBeforeSwitch,
      summaryRequests: smallModel.prompts.filter(isSummaryCall).map(sizeOf),
      defaultSummaryCalls: summaryCallsOf(defaultModel) - summariesBeforeSwitch,
    };
  } finally {
    detach();
    await built.dispose();
  }
}

/**
 * **PINNED：今天的實際值，#1374 要整組翻面。**
 *
 * 摘要請求 ≈ 切換時的歷史 − 保留的 20 則（基座不帶 `trimTokensToSummarize`，整段塞進一個請求）。
 * 歷史夠長時這一份比小模型的窗口還大——估算器量的，假模型不擋，所以是「量到的大小」不是「端點拒絕」。
 * dsh 對同一點也沒有針對目標窗口的截斷（`index.ts:205-222`：摘要失敗就回原本的請求錯誤）。
 */
describe('PINNED：切到小窗口後的第一份摘要請求會超過它的窗口（#1374）', () => {
  it('量過沒溢的對照：歷史約 3.6 萬 token、保留之外的約 2.3 萬 token，摘要請求塞得進窗口', async () => {
    const run = await switchAfterLongChat({ payloadChars: 1_500, preRounds: 24 });
    expect(run.summariesBeforeSwitch).toBe(0);
    expect(run.historyBeforeSwitch).toBeGreaterThan(SMALL_LIMITS.contextWindow);
    expect(run.defaultSummaryCalls).toBe(0);
    expect(run.summaryRequests.length).toBeGreaterThan(0);
    expect(Math.max(...run.summaryRequests)).toBeLessThan(SMALL_LIMITS.contextWindow);
  });

  it('溢出：3000 字 × 22 輪（歷史約 6.6 萬 token），第一份摘要請求 3.9 萬 > 32,768（該有：不超過小模型的窗口，見 #1374）', async () => {
    const run = await switchAfterLongChat({ payloadChars: 3_000, preRounds: 22 });
    // 前提：切換前沒摘要過，歷史本身遠超小模型的窗口；摘要打到選中那顆（不是預設那顆）。
    expect(run.summariesBeforeSwitch).toBe(0);
    expect(run.historyBeforeSwitch).toBeGreaterThan(SMALL_LIMITS.contextWindow * 1.5);
    expect(run.defaultSummaryCalls).toBe(0);
    expect(run.summaryRequests.length).toBeGreaterThan(0);
    // 今天的實際值（估算器量到約 39,480）。該有：`Math.max(...) <= SMALL_LIMITS.contextWindow - SMALL_LIMITS.maxOutputTokens`。
    expect(Math.max(...run.summaryRequests)).toBeGreaterThan(SMALL_LIMITS.contextWindow);
  });
});
