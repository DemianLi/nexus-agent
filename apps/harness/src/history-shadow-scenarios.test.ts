/**
 * 影子比對的兩個分開數的類別，各在一條會產生它的路徑上量（[#2355](https://github.com/DemianLi/nexus-agent/issues/2355)）；同一條路徑再跑一次
 * `history-source=log`，看送出去的是哪一份。`log-derived-history` 的場景一個都打不到，所以在這裡另外造：
 *
 * - `patch-closer`：一輪在工具開始前失敗，補結寫進了日誌、寫存檔點那一步失敗，下一輪由 `patchToolCallsMiddleware` 補。
 * - `image-offload-after-start`：adapter 沒掛 `IMAGE_BUDGET_PROPERTY`、送出才拋 `IMAGE_OFFLOAD_REQUIRED`，recovery 在 `model/start` 之後寫 offload；
 *   舊日誌裡的同一個形狀從凍結夾具 `v52-image-offload-after-start` 讀。
 *
 * 真的 `createNexusAgent`＋`ThreadPump`，模型是腳本。**零憑證、零外部連線**。
 */

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  compareHistoryWithLog,
  createHistoryShadowTally,
  IMAGE_BUDGET_PROPERTY,
  isHistoryFromLog,
  ModelHistoryCache,
  SessionLog,
  TOOL_NOT_STARTED_TEXT,
  toBaseMessage,
  WIRE_EMPTY_TOOL_RESULT_TEXT,
  wireProjection,
} from '@nexus/core';
import type {
  AttachmentRef,
  HistoryShadowOutcome,
  HistorySource,
  ImageBudget,
  PluginEntry,
} from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { EMPTY_TOOL_RESULT_TEXT } from './live-model.js';
import { toolResultAsSeen } from './conversation-restore.js';
import { openJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function assemble(
  model: ScriptedChatModel,
  options: {
    readonly plugins?: readonly PluginEntry[];
    readonly recursionLimit?: number;
    readonly wrapAgent?: (agent: PumpAgent) => PumpAgent;
    readonly source?: HistorySource;
    readonly agentLoop?: 'langgraph';
  } = {},
) {
  const outcomes: HistoryShadowOutcome[] = [];
  const tally = createHistoryShadowTally((outcome) => outcomes.push(outcome));
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    summarization: false,
    observationPolicy: false,
    plugins: options.plugins ?? [],
    ...(options.recursionLimit !== undefined && { recursionLimit: options.recursionLimit }),
    // 有型錄才掛圖片那兩顆 middleware。
    modelLimits: () => ({ contextWindow: 32_768, maxOutputTokens: 4096 }),
    historySource: options.source ?? 'shadow',
    historyShadow: tally,
    ...(options.agentLoop !== undefined && { agentLoop: options.agentLoop }),
  });
  const agent = built.agent as unknown as PumpAgent;
  const pump = new ThreadPump(options.wrapAgent?.(agent) ?? agent, 'history-shadow-scenarios');
  const detach = built.attachSession(pump.sessions);
  cleanups.push(async () => {
    pump.close();
    detach();
    await built.dispose();
  });
  return { pump, tally, outcomes };
}

describe('patch-closer', () => {
  const PINGS: PluginEntry = {
    plugin: {
      name: 'pings',
      apply(registry) {
        registry.tools.register(
          tool(() => 'pong', { name: 'ping', description: '一次。', schema: z.object({}) }),
        );
        registry.tools.register(
          tool(() => 'pang', { name: 'pang', description: '另一次。', schema: z.object({}) }),
        );
      },
    },
  };
  const TWO_CALLS: ScriptedTurn = {
    content: '',
    toolCalls: [
      { name: 'ping', args: {}, id: 'call-a' },
      { name: 'pang', args: {}, id: 'call-b' },
    ],
  };
  /** 撞在第一次模型呼叫之後、工具那一步之前（同 `step-failure-closers.test.ts`，量過）。 */
  const FAILS_BEFORE_TOOLS = 4;
  const noUpdateState = (agent: PumpAgent): PumpAgent =>
    new Proxy(agent, {
      get(target, key, receiver) {
        if (key === 'updateState') return () => Promise.reject(new Error('存檔點寫不進去'));
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });

  // 存檔點寫不進去是 `langgraph` 才有的情境：native 沒有存檔點，補結經 `appendLoggedMessages` 接進快取。
  it('補結只寫進日誌、存檔點沒有：下一輪請求是基座那句、推導是「還沒開始」，記成 patch-closer', async () => {
    const model = new ScriptedChatModel({ turns: [TWO_CALLS, { content: '好。' }] });
    const { pump, tally, outcomes } = await assemble(model, {
      plugins: [PINGS],
      recursionLimit: FAILS_BEFORE_TOOLS,
      wrapAgent: noUpdateState,
      agentLoop: 'langgraph',
    });
    await pump.submit({ kind: 'message', text: '跑' }).catch(() => undefined);
    await pump.whenIdle();
    const results = pump.sessions.root.events.filter((event) => event.type === 'tool/result');
    expect(results.map((event) => (event.data as { callId: string }).callId)).toEqual([
      'call-a',
      'call-b',
    ]);

    await pump.submit({ kind: 'message', text: '再來' }).catch(() => undefined);
    await pump.whenIdle();

    // 第二輪的那一次：兩顆呼叫的結果各差一句。
    expect(outcomes).toEqual([{ kind: 'patch-closer', detail: '2 則補結的句子不同' }]);
    expect(tally.counts()).toMatchObject({ match: 1, 'patch-closer': 1, other: 0 });
    const prompt = model.prompts.at(-1) ?? [];
    expect(
      prompt.filter((message) => message.getType() === 'tool').map((message) => message.text),
    ).not.toContain(TOOL_NOT_STARTED_TEXT);
  });

  it('log：同一條路徑，送出去的補結是日誌上那句（#1827 D181）', async () => {
    const model = new ScriptedChatModel({ turns: [TWO_CALLS, { content: '好。' }] });
    const { pump, outcomes } = await assemble(model, {
      plugins: [PINGS],
      recursionLimit: FAILS_BEFORE_TOOLS,
      wrapAgent: noUpdateState,
      source: 'log',
    });
    await pump.submit({ kind: 'message', text: '跑' }).catch(() => undefined);
    await pump.whenIdle();
    await pump.submit({ kind: 'message', text: '再來' }).catch(() => undefined);
    await pump.whenIdle();

    expect(outcomes).toEqual([]);
    const prompt = model.prompts.at(-1) ?? [];
    expect(
      prompt.filter((message) => message.getType() === 'tool').map((message) => message.text),
    ).toEqual([TOOL_NOT_STARTED_TEXT, TOOL_NOT_STARTED_TEXT]);
  });
});

describe('image-offload-after-start', () => {
  const imageRef = (letter: string, name: string): AttachmentRef => ({
    type: 'image',
    attachmentId: `sha256:${letter.repeat(64)}`,
    mediaType: 'image/png',
    bytes: 90,
    width: 3,
    height: 2,
    name,
  });

  /** 照樣量額度、超額就拋，但不把額度掛出來：上層量不到，只能等 adapter 拋了再由 recovery 接。 */
  class UndeclaredBudgetModel extends ScriptedChatModel {
    override get [IMAGE_BUDGET_PROPERTY](): ImageBudget | undefined {
      return undefined;
    }
  }

  it('recovery 在 model/start 之後寫 offload：被拒的那次 match，重送的那次記成 image-offload-after-start', async () => {
    const model = new UndeclaredBudgetModel({
      turns: [{ content: '一' }, { content: '二' }],
      imageBudget: { maxImages: 1 },
    });
    const { pump, tally, outcomes } = await assemble(model);
    await pump.submit({
      kind: 'message',
      text: '看這張',
      id: 'm1',
      attachments: [imageRef('a', 'one.png')],
    });
    await pump.whenIdle();
    await pump.submit({
      kind: 'message',
      text: '再看這張',
      id: 'm2',
      attachments: [imageRef('b', 'two.png')],
    });
    await pump.whenIdle();

    const types = pump.sessions.root.events.map((event) => event.type);
    const lastStart = types.lastIndexOf('model/start');
    expect(types.indexOf('image/offload')).toBeGreaterThan(lastStart);
    expect(model.rejectedImageRequests).toBe(1);
    expect(outcomes).toEqual([{ kind: 'image-offload-after-start' }]);
    // 第一輪一次、第二輪被拒的一次與重送的一次：比對跟著嘗試數，不跟著模型呼叫數。
    expect(tally.counts()).toMatchObject({ match: 2, 'image-offload-after-start': 1, other: 0 });
  });

  it('log：重送那次推導帶上 model/start 之後的 offload，圖不會再送一次，送出去的跟 state 相同', async () => {
    const run = async (source: HistorySource) => {
      const model = new UndeclaredBudgetModel({
        turns: [{ content: '一' }, { content: '二' }],
        imageBudget: { maxImages: 1 },
      });
      const { pump } = await assemble(model, { source });
      await pump.submit({
        kind: 'message',
        text: '看這張',
        id: 'm1',
        attachments: [imageRef('a', 'one.png')],
      });
      await pump.whenIdle();
      await pump.submit({
        kind: 'message',
        text: '再看這張',
        id: 'm2',
        attachments: [imageRef('b', 'two.png')],
      });
      await pump.whenIdle();
      return model;
    };
    const state = await run('state');
    const log = await run('log');
    expect(log.rejectedImageRequests).toBe(1);
    expect(log.prompts).toHaveLength(2);
    expect(log.prompts.map((prompt) => prompt.map(wireProjection))).toEqual(
      state.prompts.map((prompt) => prompt.map(wireProjection)),
    );
  });

  it('凍結夾具 v52-image-offload-after-start：重送那一刻推出來的，跟下一輪推出來的同一段相同', async () => {
    const fixture = fileURLToPath(
      new URL('./fixtures/session-format/v52-image-offload-after-start/', import.meta.url),
    );
    const directory = await mkdtemp(join(tmpdir(), 'nexus-history-shadow-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await cp(fixture, directory, { recursive: true });
    const events = await (
      await openJsonlSessionStore({ directory }).open('image-offload', 'read')
    ).read();
    const offload = events.findIndex((event) => event.type === 'image/offload');
    expect(events[offload - 1]?.type).toBe('model/start');
    const nextStart = events.findIndex(
      (event, index) => index > offload && event.type === 'model/start',
    );
    const options = {
      toolResultAsSeen,
      applyPrunes: true,
      applyArgTruncations: true,
      applyImageOffloads: true,
    };

    // 請求那一邊：下一輪推出來的；offload 落在它的 model/start 之前，由一般的 image/offload 套用處理，不經 eventsForModelCall 的接法。
    // 取到第二輪的使用者那句為止。
    const later = new ModelHistoryCache(options).derive(events.slice(0, nextStart));
    expect(later.kind).toBe('replayed');
    const sent = later.kind === 'replayed' ? later.messages : [];
    const humans = sent.flatMap((message, index) => (message.type === 'human' ? [index] : []));
    const request = sent.slice(0, humans[1]! + 1).map((message) => toBaseMessage(message));
    // 第一張圖在這一段裡已經省略：不套重送那一刻的 offload，推出來的就會不同。
    expect(JSON.stringify(request[0]?.content)).toContain('"offloaded":true');

    const log = new SessionLog('image-offload', { seed: events.slice(0, offload + 1) });
    expect(compareHistoryWithLog(request, log, new ModelHistoryCache(options))).toEqual({
      kind: 'image-offload-after-start',
    });
  });
});

describe('記進日誌的那幾顆查得到 log', () => {
  /**
   * pre-step 宿主與重複提醒在載入插件時就拿走 `registry.sessions`，fold 開頭才標。插件 `apply` 拿到的就是那一個物件：
   * 標記要落在它身上，記不進去時才會拋（`pre-step-middleware.test.ts`、`repeat-reminder.test.ts` 量拋不拋）。
   */
  it.each([
    ['log', true],
    ['shadow', false],
    ['state', false],
  ] as const)('%s：插件拿到的 registry.sessions 標記是 %s', async (source, marked) => {
    let seen: object | undefined;
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [] }),
      checkpointer: new MemorySaver(),
      summarization: false,
      observationPolicy: false,
      plugins: [
        {
          plugin: {
            name: 'peek',
            apply(registry) {
              seen = registry.sessions;
            },
          },
        },
      ],
      historySource: source,
    });
    cleanups.push(() => built.dispose());
    expect(seen).toBeDefined();
    expect(isHistoryFromLog(seen!)).toBe(marked);
  });
});

describe('投影與出貨 fetch 層用同一個字', () => {
  it('空的工具結果：core 投影用的就是 live-model 送上線的那一個', () => {
    expect(WIRE_EMPTY_TOOL_RESULT_TEXT).toBe(EMPTY_TOOL_RESULT_TEXT);
  });
});
