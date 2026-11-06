/**
 * native 模型那一串接住失敗、再往內交一次的兩格（#2416）：串流重打（`nexusStreamRetry`）與圖片省略的接住端
 * （`nexusImageOffloadRecovery`）。兩格都登記成一步（`model-call-step.ts` 的 `withModelCallStep`），root 由 native 在模型那一串
 * 原位直接呼叫，子代理在 native 下仍是 LangGraph 子圖（TODO(#2359)），經 `wrapModelCall`。摘要器裝不下時換保留量重走也在它那一步
 * 裡面，次數由 `summarizer-cell.test.ts` 數。
 *
 * 這兩格在登記的那一步裡叫 `next` 不只一次，所以這裡多看兩件事：每叫一次 `next`，內層各格都重跑一次（起訖紀錄器每次嘗試各記
 * 一對 `model/start`／`model/end`）；串流重打經 `getConfig().writer` 送給 pump 的通知，native 原位呼叫時照樣送得到。
 *
 * 計數做法同 `mutator-cells.test.ts`。root 第一次叫模型：第一次嘗試回報可重試的 500 失敗，串流重打再交一次；第二次嘗試 adapter
 * 量到圖超額拋碼，接住端省略最舊的一張再交一次；第三次才回。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it, vi } from 'vitest';

import type { AgentLoopKind } from '../agent-assembly.js';
import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { ImageOffloadRequiredError, stampImageOrigin } from '../image-offload.js';
import { loadPlugins } from '../load.js';
import type * as ModelCallStepModule from '../model-call-step.js';
import { SessionRegistry } from '../session-registry.js';
import { noteStreamFailure, streamRetrySignalOf } from '../stream-retry.js';

type Via = 'native' | 'hook';
type Count = Record<Via, number>;

/** `格名 › 哪一邊` → 兩條路各被叫了幾次。 */
const counts = vi.hoisted(() => new Map<string, Count>());
/** 每一次進到登記的那一步，照先後記 `哪一邊 › 格名`。 */
const entered = vi.hoisted((): string[] => []);

vi.mock('../model-call-step.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelCallStepModule>();
  const viaNative = new AsyncLocalStorage<true>();
  const sideOf = (request: unknown): string =>
    (request as { state?: { messages?: readonly BaseMessage[] } }).state?.messages?.[0]?.text ?? '';
  const withModelCallStep: typeof actual.withModelCallStep = (step, build) => {
    let name = '';
    const middleware = actual.withModelCallStep((request, next) => {
      const key = `${name} › ${sideOf(request)}`;
      const entry = counts.get(key) ?? { native: 0, hook: 0 };
      counts.set(key, entry);
      entered.push(`${sideOf(request)} › ${name}`);
      entry[(viaNative.getStore() === true ? 'native' : 'hook') satisfies Via] += 1;
      return step(request, (inner) => viaNative.exit(() => next(inner)));
    }, build);
    name = String((middleware as { name?: unknown }).name);
    return middleware;
  };
  const wrapModelCallFromStep = ((step: ModelCallStepModule.ModelCallStep) => {
    const wrap = actual.wrapModelCallFromStep(step);
    return (request: object, handler: (request: object) => unknown) =>
      viaNative.run(true, () => wrap(request, handler));
  }) as typeof actual.wrapModelCallFromStep;
  return { ...actual, withModelCallStep, wrapModelCallFromStep };
});

const RETRY = 'nexusStreamRetry';
const RECOVERY = 'nexusImageOffloadRecovery';
const CALLS = 'nexusModelCallEvents';
const CELLS = [RETRY, RECOVERY, CALLS];

const usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7 };
const reply = (fields: ConstructorParameters<typeof AIMessage>[0] & object) =>
  new AIMessage({ ...fields, usage_metadata: usage });

/** 一則帶兩張圖的人話，蓋上來源記號（第 1、2 張各來自 seq 0 那則）。 */
function withImages(): HumanMessage {
  const image = (letter: string) => ({
    type: 'nexus-image',
    attachment: {
      attachmentId: `sha256:${letter.repeat(64)}`,
      mediaType: 'image/png',
      bytes: 300,
      width: 4,
      height: 3,
    },
  });
  return stampImageOrigin(
    new HumanMessage({
      content: [image('a'), image('b'), { type: 'text', text: '動手' }] as never,
    }),
    0,
  );
}

const offloaded = (messages: readonly BaseMessage[]) =>
  (
    messages.find((message) => HumanMessage.isInstance(message))?.content as {
      type: string;
      offloaded?: boolean;
    }[]
  )
    .filter((block) => block.type === 'nexus-image')
    .map((block) => block.offloaded === true);

async function run(loop: AgentLoopKind) {
  counts.clear();
  entered.length = 0;
  const { registry } = await loadPlugins([fakePlugin('nothing', () => {})]);
  const sessions = new SessionRegistry('t');
  registry.sessions.bind(sessions);
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    stepInbox: true,
    defaultBackend: backend,
    events: registry.dispatch,
    modelLimits: () => undefined,
    streamRetry: { maxRetries: 2, initialDelayMs: 1, jitterRatio: 0 },
  });
  /** root 第一次叫模型時，第三次嘗試看到的圖：哪幾張已省略。 */
  const seen: boolean[][] = [];
  const model = fakeModel()
    .respond(() => {
      noteStreamFailure({ code: 'SERVER', status: 500 });
      return new Error('串流中段斷了');
    })
    .respond(() => new ImageOffloadRequiredError(1))
    .respond((messages) => {
      seen.push(offloaded(messages));
      return reply({
        content: '',
        tool_calls: [
          {
            name: 'task',
            args: { description: '叫一下', subagent_type: 'general-purpose' },
            id: 'root-task',
          },
        ],
      });
    })
    .respond(reply({ content: '子代理好了' }))
    .respond(reply({ content: '好了' }));
  const agent = assembleAgent({
    ...params,
    model,
    backend: params.backend ?? backend,
    loop,
    events: registry.dispatch,
  });
  const signals: string[] = [];
  const stream = await (
    agent as unknown as {
      streamEvents(
        input: unknown,
        config: object,
      ): Promise<
        AsyncIterable<{ method?: string; params?: { namespace?: unknown; data?: unknown } }>
      >;
    }
  ).streamEvents({ messages: [withImages()] }, { version: 'v3', configurable: { thread_id: 't' } });
  for await (const event of stream) {
    if (event.method !== 'custom') continue;
    const namespace = event.params?.namespace;
    if (Array.isArray(namespace) && namespace.length > 0) continue;
    const signal = streamRetrySignalOf(
      (event.params?.data as { payload?: unknown } | null)?.payload,
    );
    if (signal !== undefined) signals.push(signal.phase);
  }
  const log = sessions.root.events.map((event) => event.type);
  return { seen, signals, log };
}

const cellCounts = () =>
  Object.fromEntries(
    [...counts].filter(([key]) => CELLS.some((cell) => key.startsWith(`${cell} › `))).sort(),
  );

/**
 * 這一輪預期的計數，`root` 那一邊由 `rootVia` 叫。root 叫了兩次模型（委派、收尾）：串流重打兩次各進一次；第一次在裡面重交一次，
 * 接住端與起訖紀錄器那一次各進兩次（第二次嘗試被拋碼、接住端在起訖裡面重交，不算一次新的呼叫），所以起訖 3 次、接住端 3 次。
 * 子代理：串流重打進一次、重交一次，起訖 2 次；接住端只折進 root。
 */
function expected(rootVia: Via) {
  const of = (n: number) => ({
    native: rootVia === 'native' ? n : 0,
    hook: rootVia === 'hook' ? n : 0,
  });
  const hook = (n: number) => ({ native: 0, hook: n });
  return Object.fromEntries(
    [
      [`${RETRY} › 動手`, of(2)],
      [`${RECOVERY} › 動手`, of(3)],
      [`${CALLS} › 動手`, of(3)],
      [`${RETRY} › 叫一下`, hook(1)],
      [`${CALLS} › 叫一下`, hook(1)],
    ].sort(),
  );
}

/** root 那一邊依序進了哪些登記的格（只記錄的與改請求的也在內）。 */
const rootOrder = () =>
  entered.flatMap((line) => (line.startsWith('動手 › ') ? [line.slice('動手 › '.length)] : []));

describe('native 模型那一串重交的兩格：root 由 native 原位呼叫、子代理經 wrapModelCall', () => {
  it('native：root 兩格都由 native 直接呼叫，重交時內層各格都重跑；子代理經 wrapModelCall', async () => {
    const { seen, signals, log } = await run('native');
    expect(cellCounts()).toEqual(expected('native'));
    expect(seen).toEqual([[true, false]]);
    // 經 `getConfig().writer` 送給 pump 的通知：root 那一次的排定與開始。
    expect(signals).toEqual(['scheduled', 'started']);
    expect(log.filter((type) => type === 'model/start')).toHaveLength(3);
    expect(log.filter((type) => type === 'image/offload')).toHaveLength(1);
    expect(log.filter((type) => type === 'llm/retry')).toHaveLength(1);
  });

  it('langgraph：每一格都經 wrapModelCall，次數與 native 相同', async () => {
    const { seen, signals, log } = await run('langgraph');
    expect(cellCounts()).toEqual(expected('hook'));
    expect(seen).toEqual([[true, false]]);
    expect(signals).toEqual(['scheduled', 'started']);
    expect(log.filter((type) => type === 'model/start')).toHaveLength(3);
  });

  it('先後：native 的 root 每次進各格的先後與 langgraph 經 wrapModelCall 的相同', async () => {
    await run('langgraph');
    const langgraph = rootOrder();
    await run('native');
    expect(rootOrder()).toEqual(langgraph);
    expect(langgraph.filter((cell) => CELLS.includes(cell))).toEqual([
      RETRY,
      CALLS,
      RECOVERY,
      CALLS,
      RECOVERY,
      RETRY,
      CALLS,
      RECOVERY,
    ]);
    // 兩格與只記錄的格排在一起，交換任兩格才看得出來。
    for (const cell of ['nexusModelUsage', 'nexusSessionCheckpoint', 'nexusRequestSnapshot']) {
      expect(langgraph).toContain(cell);
    }
  });
});
