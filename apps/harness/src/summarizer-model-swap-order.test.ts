/**
 * **摘要器看到的 `request.model` 是這一步選中的那顆**——
 * [#1369](https://github.com/DemianLi/nexus-agent/issues/1369)（#1354 複現的 F1，盤點
 * [#1340](https://github.com/DemianLi/nexus-agent/issues/1340)）。
 *
 * ## 缺陷與修法
 *
 * 摘要器與基座同名 `SummarizationMiddleware`，被 `mergeMiddlewareStack` 原地換進預設疊第三格；換模型
 * （`nexusModelSelection`）與圖片省略是新名字，以前一律排在預設疊**後面**。LangChain 先列者最外層，所以摘要器
 * 在它們外面：門檻按換模型之前那顆算、由那顆生摘要，估算看到的圖還沒標省略。
 *
 * 修法在合併這一步：`mergeMiddlewareStack` 把換模型、子代理跟隨與圖片省略搬到預設疊**前面**
 * （`agent-assembly.ts` 的 `OUTSIDE_DEFAULTS`）。同名取代那條縫與摘要器的位置都沒動。
 *
 * ## 這個檔案量什麼
 *
 * 1. **順序**：合併後的疊裡，換模型在圖片省略前面、圖片省略在摘要器前面。
 * 2. **門檻**：摘要器問 `modelLimits` 的是選中那顆（與內層看到的同一顆）。
 * 3. **生摘要**：摘要那次模型呼叫打到選中那顆，預設那顆一次都沒收到。
 * 4. **後果**：選到小窗口的模型之後，摘要的 token 門檻夾在它的窗口之下，與「把它直接當預設」的對照組一樣。
 * 5. **子代理**：`task` 委派出去的子代理，摘要器問的也是選中那顆（跟隨的那顆也搬到前面）。
 * 6. **換模型那一步誰生摘要**（#1377）：對話已經在大窗口模型上長到比小窗口還大，**那一步**才換——摘要由最近一次已送出的請求
 *    那顆（大的）生，小的那顆收到的請求在夾窗之下。門檻跟選中那顆、生摘要跟 `latest`。
 *
 * ## 與 dsh 的關係（`d7432673886`）
 *
 * dsh 的壓縮在 `agent/pre-step`（`compaction-basic/src/index.ts:158`），**早於 `agent/request` 的路由**，所以它的門檻與
 * 生摘要都用 `session.requestHeader()`——**最近一次已送出的請求**那顆（`routedTarget`、`summarizer.ts:131-138` 的
 * `latest`），換模型那一步還是舊的，靠 `agent/request-error` 的 context-overflow 壓縮接住。**我們比它早一步**：
 * 洋蔥上換模型在摘要器外面，這一步選中的那顆摘要器當場就拿得到，不必等一次失敗。這是偏離，不是「表達不出來」——
 * 要照 dsh 的時序，讀 `ModelSelectionController.state().lastUsed` 就行；選這樣做是因為 #723 的驗收是「換模型之後
 * 窗口跟著換」，而 dsh 的時序在換到小窗口的那一步必定先撞一次失敗。**生摘要則照 dsh**（#1377）：用最近一次已送出的請求
 * 那顆（`summarizer.ts:127-137` 的 `latest`），所以換模型那一步由還裝得下歷史的大的那顆生。
 *
 * ## 範圍
 *
 * - **「請求量是窗口的幾倍」是我們自己的估算器（`estimateAnchoredTokens`）量的**，假模型不擋窗口，真端點會怎樣
 *   沒有量（真模型實跑被上游 429 擋著，見 #1343）。
 * - 圖片省略的搬移只量了**順序**（第 1 條），沒有量估算差多少；既有的 image-offload 與 summarization 測試全綠。
 *
 * **零憑證、零外部連線。**
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  estimateAnchoredTokens,
  MODEL_SELECTION_MIDDLEWARE_NAME,
  ModelSelectionController,
  SessionRegistry,
  SUMMARY_PROMPT,
  TokenAnchorBook,
  tagModelRoute,
  windowThreshold,
} from '@nexus/core';
import type { ModelContextLimits, PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

/** 出廠型錄的真數字（`apps/harness/cordis.yml` 的 `live-model`）：預設那顆，與型錄裡窗口最小的那顆。 */
const DEFAULT_LIMITS: ModelContextLimits = { contextWindow: 700_045, maxOutputTokens: 16_384 };
const SMALL_LIMITS: ModelContextLimits = { contextWindow: 32_768, maxOutputTokens: 4_096 };

/** 摘要那次呼叫的提示詞開頭；用它從 `prompts` 裡把摘要請求挑出來。 */
const SUMMARY_MARK = SUMMARY_PROMPT.split('\n')[0]!;

const isSummaryCall = (prompt: readonly BaseMessage[]) =>
  prompt.some((message) => message.text.includes(SUMMARY_MARK));

const script = (): ScriptedTurn[] =>
  Array.from({ length: 80 }, (_, index) => ({ content: `好 ${index + 1}` }));

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
  /** 做完這幾輪才 `model.select`；省略＝一開始就選。只在 `viaSelection` 時有意義。 */
  readonly selectAfterRound?: number;
  /** 選中那顆的腳本；省略＝每輪回一句「好」。委派子代理的場景要自己排。 */
  readonly smallTurns?: readonly ScriptedTurn[];
  /**
   * 註冊一個 `poke` 工具，被叫到時把選擇換回預設那顆（模擬「使用者在這一輪中間換了模型」）。
   * 委派子代理、子代理叫 `poke`、再讓下一次請求走預設那顆的場景用。
   */
  readonly pokeSelectsDefault?: boolean;
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
  // 與產品組裝一樣給實例貼上路由標籤：`model/start.route` 讀它，生摘要的「最近一次已送出的請求那顆」（#1377）靠它。
  const defaultModel = tagModelRoute(new ScriptedChatModel({ turns: script() }), {
    model: 'default',
  });
  const smallModel = tagModelRoute(
    new ScriptedChatModel({ turns: options.smallTurns ?? script() }),
    { model: 'small' },
  );
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
  const poker: PluginEntry = {
    plugin: {
      name: 'swap-order-poker',
      apply: (registry) =>
        void registry.tools.register(
          tool(
            () => {
              controller.select({ model: 'default' });
              return 'poked';
            },
            { name: 'poke', description: '戳一下。', schema: z.object({}) },
          ),
        ),
    },
  };
  const built = await createNexusAgent({
    model: options.viaSelection ? defaultModel : smallModel,
    checkpointer: new MemorySaver(),
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    plugins: options.pokeSelectsDefault === true ? [observer, poker] : [observer],
    summarization: {
      ...(options.trigger !== undefined && {
        trigger: options.trigger.map((each) => ({ ...each })),
      }),
      retainTokens: 12,
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
    // 組裝點（`createModelSelectionHost`）在 root 日誌 join 時做同一件事。
    if (options.viaSelection) controller.attach(sessions.root);
    const selectAt = options.selectAfterRound ?? 0;
    for (let round = 0; round < options.rounds; round += 1) {
      if (options.viaSelection && round === selectAt) controller.select({ model: 'small' });
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

describe('摘要器看到的是這一步選中的模型（#1369）', () => {
  it('順序：換模型在摘要器前面（外面）', async () => {
    const run = await observe({ viaSelection: true, rounds: 1, payloadChars: 10 });
    const summarizer = run.stackNames.indexOf('SummarizationMiddleware');
    const swap = run.stackNames.indexOf(MODEL_SELECTION_MIDDLEWARE_NAME);
    expect(summarizer).toBeGreaterThanOrEqual(0);
    expect(swap).toBeGreaterThanOrEqual(0);
    expect(summarizer).toBeGreaterThan(swap);
  });

  it('門檻：摘要器問 modelLimits 的與內層看到的是同一顆，都是選中那顆', async () => {
    const run = await observe({ viaSelection: true, rounds: 1, payloadChars: 10 });
    expect(run.innerSaw).toEqual(['SMALL']);
    // 本樹上問 `modelLimits` 的只有摘要器那兩處（剪刀的壓力判斷與預算層），所以這一串就是摘要器看到的。
    expect(run.limitsAskedAbout.length).toBeGreaterThan(0);
    expect(new Set(run.limitsAskedAbout)).toEqual(new Set(['SMALL']));
  });

  it('生摘要：選在第一次請求之前，最近一次已送出的就是選中那顆，摘要打到它、預設那顆一次都沒收到', async () => {
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
    expect(bySmall).toBeGreaterThan(0);
    expect(byDefault).toBe(0);
  });

  it('後果：選到小窗口之後，請求夾在它的窗口之下，與同一串輸入把它直接當預設一樣', async () => {
    // 十輪、每輪六千字：以出廠的 100000 門檻，摘要器還不到動手的時候；
    // 以 SMALL 的夾窗（`windowThreshold`），早就過了。修之前選擇路徑一次都沒摘要，請求長到 60,273（窗口的 1.8 倍）。
    const input = { rounds: 10, payloadChars: 6_000 } as const;
    const ceiling = windowThreshold(SMALL_LIMITS);

    const selected = await observe({ ...input, viaSelection: true });
    const control = await observe({ ...input, viaSelection: false });

    // 對照組：小的當預設，夾窗生效（#723 對預設那顆一直是有效的）。
    expect(summaryCallsOf(control.smallModel)).toBeGreaterThan(0);
    expect(largestRequestOf(control.smallModel)).toBeLessThan(ceiling);

    // 選擇路徑：同一個模型、同一串輸入，摘要由選中那顆生、請求不越過它的窗口——與對照組一樣。
    expect(summaryCallsOf(selected.smallModel)).toBeGreaterThan(0);
    expect(summaryCallsOf(selected.defaultModel)).toBe(0);
    expect(largestRequestOf(selected.smallModel)).toBeLessThan(ceiling);
  });

  it('子代理（task 委派）：它的摘要器問 modelLimits 的也是選中那顆（跟隨的那顆搬到前面）', async () => {
    const run = await observe({
      viaSelection: true,
      rounds: 1,
      payloadChars: 10,
      // 選中那顆接下全部：root 呼叫 task → 子代理回話 → root 收尾。
      smallTurns: [
        {
          content: '',
          toolCalls: [
            { name: 'task', args: { description: '去做。', subagent_type: 'general-purpose' } },
          ],
        },
        { content: '子代理做完了。' },
        { content: '收工。' },
      ],
    });
    // 三次模型呼叫（root、子代理、root）都走在選中那顆上；預設那顆沒有被叫過。
    expect(run.innerSaw).toEqual(['SMALL', 'SMALL', 'SMALL']);
    expect(run.defaultModel.prompts).toHaveLength(0);
    // 摘要器每次呼叫問三次（剪刀的壓力判斷、預算層與保留量，#1374）。子代理那一次也在裡面。
    expect(run.limitsAskedAbout).toHaveLength(9);
    expect(new Set(run.limitsAskedAbout)).toEqual(new Set(['SMALL']));
  });

  it('子代理（task 委派）：生摘要也跟最近一次已送出的請求那顆，不是它這一步選中的（#1377）', async () => {
    // 一開始就選小的。root 叫 task → 子代理叫 poke（工具把選擇換回預設）→ 子代理與 root 的下一次請求走預設那顆。
    // 兩邊的訊息都長到 3 則、messages 門檻 3，所以各摘要一次：最近一次已送出的請求都還是小的那顆。
    const run = await observe({
      viaSelection: true,
      rounds: 1,
      payloadChars: 10,
      pokeSelectsDefault: true,
      trigger: [{ type: 'messages', value: 3 }],
      smallTurns: [
        {
          content: '',
          toolCalls: [
            { name: 'task', args: { description: '去做。', subagent_type: 'general-purpose' } },
          ],
        },
        { content: '', toolCalls: [{ name: 'poke', args: {} }] },
        // 後面兩輪是兩次生摘要（子代理一次、root 一次）：腳本模型每次 `invoke` 都吃一輪。
        { content: '子代理那段的摘要。' },
        { content: 'root 那段的摘要。' },
      ],
    });
    // 前提：換回預設之後，子代理與 root 各有一次請求真的走了預設那顆（不然這一條什麼都沒區分）。
    expect(run.innerSaw).toEqual(['SMALL', 'SMALL', 'DEFAULT', 'DEFAULT']);
    const requests = (model: ScriptedChatModel) =>
      model.prompts.filter((prompt) => !isSummaryCall(prompt)).length;
    expect(requests(run.smallModel)).toBe(2);
    expect(requests(run.defaultModel)).toBe(2);
    // 生摘要：兩次（子代理一次、root 一次）都由最近一次已送出的請求那顆（小的）生，預設那顆一次都沒有。
    expect(summaryCallsOf(run.smallModel)).toBe(2);
    expect(summaryCallsOf(run.defaultModel)).toBe(0);
  });

  it('圖片省略也在摘要器外面（#1270 的設計位置）', async () => {
    const run = await observe({ viaSelection: true, rounds: 1, payloadChars: 10 });
    const summarizer = run.stackNames.indexOf('SummarizationMiddleware');
    const offload = run.stackNames.indexOf('nexusImageOffload');
    expect(offload).toBeGreaterThanOrEqual(0);
    expect(offload).toBeLessThan(summarizer);
    expect(run.stackNames.indexOf(MODEL_SELECTION_MIDDLEWARE_NAME)).toBeLessThan(offload);
  });

  /**
   * **換模型那一步誰生摘要**（[#1377](https://github.com/DemianLi/nexus-agent/issues/1377)，PM 決定 (b)）：對話在大窗口模型上長到
   * 比小窗口還大，那一步才換過去。門檻在這一步就跟選中那顆夾窗（#1369，比 dsh 早一步），所以摘要器這一步動手；但**生摘要**
   * 用最近一次已送出的請求那顆（大的、裝得下整段歷史），小的那顆收到的是摘要之後的請求，在夾窗之下。
   *
   * 修之前（#1369 的實測）：摘要請求送進選中的小的那顆，72,314 token，是它窗口的 2.2 倍。
   *
   * 照 dsh `summarizer.ts:127-137` 的 `latest ?? agentTarget`（`configured` 不做）。代價：這一步的摘要由不是接手的那顆生，
   * 下一步起由選中那顆接手。
   */
  it('換模型那一步：摘要由換之前那顆（最近一次已送出的請求）生，小窗口那顆收到的請求在夾窗之下', async () => {
    const run = await observe({
      viaSelection: true,
      rounds: 16,
      payloadChars: 6_000,
      selectAfterRound: 12,
    });
    const sizes = (model: ScriptedChatModel, summary: boolean) =>
      model.prompts.filter((prompt) => isSummaryCall(prompt) === summary).map(sizeOf);
    const ceiling = windowThreshold(SMALL_LIMITS);

    // 前面十二輪在預設那顆上，沒有一次摘要。
    expect(sizes(run.defaultModel, false)).toHaveLength(12);
    // 換過去那一步：摘要請求送進**預設那顆**（它裝得下），而且那份請求比小的窗口還大——所以小的收下會超窗。
    const summaryRequests = sizes(run.defaultModel, true);
    expect(summaryRequests).toHaveLength(1);
    expect(summaryRequests[0]!).toBeGreaterThan(SMALL_LIMITS.contextWindow);
    // 小的那顆一次摘要請求都沒收到；它收到的每一份請求都在夾窗之下，而且確實有收到（對話在它身上接著走）。
    expect(summaryCallsOf(run.smallModel)).toBe(0);
    const requests = sizes(run.smallModel, false);
    expect(requests.length).toBeGreaterThan(0);
    expect(Math.max(...requests)).toBeLessThan(ceiling);
  });
});
