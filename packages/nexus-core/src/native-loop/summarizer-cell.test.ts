/**
 * native 的摘要器那一格（#2416）：整串登記成一個環繞步（`model-call-step.ts` 的 `withModelCallStep`），root 由 native 在模型那一串
 * 原位直接呼叫那一步、不經那顆的 `wrapModelCall`；子代理在 native 下仍是 LangGraph 子圖（TODO(#2359)），照舊經 `wrapModelCall`。
 * 摘要關掉時同一格是空殼（`createRecordedProjectionShell`），有 `sessions` 時一樣登記。
 *
 * 計數掛在登記上：登記的那一步包一個計數；native 直接呼叫的那一支（`wrapModelCallFromStep`）包一層 `AsyncLocalStorage`，
 * 沒有那一層就是經 `wrapModelCall`。不換 `build` 收到的那支：`withModelCallStep` 會檢查兩者是同一支。
 * 只數摘要器那一顆（模型那一串其餘登記了環繞步的格不算）。除了那一步被叫幾次，也數它往內交（`next`）幾次：端點真的回超窗時，force 鏈換保留 0 重走，`next` 多一次。
 * 哪一邊照 state 的第一則訊息分。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { ContextOverflowError } from '@langchain/core/errors';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { StateBackend } from 'deepagents';
import { fakeModel } from 'langchain';
import { describe, expect, it, vi } from 'vitest';

import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin, fakeTool } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { loadPlugins } from '../load.js';
import type * as ModelCallStepModule from '../model-call-step.js';
import { SUMMARIZATION_MIDDLEWARE_NAME } from '../summarization.js';

type Via = 'native' | 'hook';
interface Count {
  native: number;
  hook: number;
  next: number;
}

/** 每一邊（照 state 的第一則訊息）各被叫了幾次，分成兩條路，再數往內交幾次。 */
const counts = vi.hoisted(() => new Map<string, Count>());

vi.mock('../model-call-step.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelCallStepModule>();
  const viaNative = new AsyncLocalStorage<true>();
  const sideOf = (request: unknown): string =>
    (request as { state?: { messages?: readonly BaseMessage[] } }).state?.messages?.[0]?.text ?? '';
  const entryOf = (request: unknown): Count => {
    const side = sideOf(request);
    const entry = counts.get(side) ?? { native: 0, hook: 0, next: 0 };
    counts.set(side, entry);
    return entry;
  };
  const withModelCallStep: typeof actual.withModelCallStep = (step, build) => {
    let summarizer = false;
    const middleware = actual.withModelCallStep((request, next) => {
      if (!summarizer) return step(request, (inner) => viaNative.exit(() => next(inner)));
      const entry = entryOf(request);
      entry[(viaNative.getStore() === true ? 'native' : 'hook') satisfies Via] += 1;
      return step(request, (inner) => {
        entry.next += 1;
        return viaNative.exit(() => next(inner));
      });
    }, build);
    summarizer = (middleware as { name?: unknown }).name === SUMMARIZATION_MIDDLEWARE_NAME;
    return middleware;
  };
  const wrapModelCallFromStep = ((step: ModelCallStepModule.ModelCallStep) => {
    const wrap = actual.wrapModelCallFromStep(step);
    return (request: object, handler: (request: object) => unknown) =>
      viaNative.run(true, () => wrap(request, handler));
  }) as typeof actual.wrapModelCallFromStep;
  return { ...actual, withModelCallStep, wrapModelCallFromStep };
});

const SUMMARY_TEXT = '這是摘要。';

async function run(options: { summarization: boolean; overflow?: boolean }) {
  counts.clear();
  const { registry } = await loadPlugins([
    fakePlugin('tools', (r) => {
      r.tools.register(fakeTool('alpha'));
    }),
  ]);
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    ...(options.summarization ? {} : { summarization: false }),
    stepInbox: true,
    defaultBackend: backend,
    events: registry.dispatch,
  });
  let model = fakeModel()
    .respondWithTools([{ name: 'alpha', args: {}, id: 'root-alpha' }])
    .respondWithTools([
      {
        name: 'task',
        args: { description: '叫一下 alpha', subagent_type: 'general-purpose' },
        id: 'root-task',
      },
    ])
    .respondWithTools([{ name: 'alpha', args: {}, id: 'sub-alpha' }])
    .respond(new AIMessage('子代理好了'));
  // root 的第三次模型呼叫：端點說超窗 → 生摘要（同一顆模型）→ 保留 0 重走一次。
  if (options.overflow === true) {
    model = model
      .respond(new ContextOverflowError('Input exceeded the model context window.'))
      .respond(new AIMessage(SUMMARY_TEXT));
  }
  model = model.respond(new AIMessage('好了'));
  const agent = assembleAgent({
    ...params,
    model,
    backend: params.backend ?? backend,
    loop: 'native',
    events: registry.dispatch,
  });
  const state = await agent.invoke(
    { messages: [new HumanMessage('動手')] },
    { configurable: { thread_id: 't' } },
  );
  return { messages: state.messages as BaseMessage[] };
}

const countsOf = () => Object.fromEntries(counts);

describe('native 的摘要器那一格：root 由 native 原位呼叫、子代理經 wrapModelCall', () => {
  it('摘要開著：root 三次都由 native 直接呼叫，子代理兩次都經 wrapModelCall，各往內交一次', async () => {
    const { messages } = await run({ summarization: true });
    expect(messages.at(-1)?.text).toBe('好了');
    expect(countsOf()).toMatchInlineSnapshot(`
      {
        "動手": {
          "hook": 0,
          "native": 3,
          "next": 3,
        },
        "叫一下 alpha": {
          "hook": 2,
          "native": 0,
          "next": 2,
        },
      }
    `);
  });

  it('端點真的回超窗：force 鏈在 native 原位呼叫的那一步裡，root 多往內交一次', async () => {
    const { messages } = await run({ summarization: true, overflow: true });
    // 最後一則是「好了」不是摘要的字：生摘要那次吃掉了排在它前面的那一則，摘要真的跑了。
    expect(messages.at(-1)?.text).toBe('好了');
    expect(countsOf()).toMatchInlineSnapshot(`
      {
        "動手": {
          "hook": 0,
          "native": 3,
          "next": 4,
        },
        "叫一下 alpha": {
          "hook": 2,
          "native": 0,
          "next": 2,
        },
      }
    `);
  });

  it('摘要關掉（有 sessions 的空殼）：同樣 root 由 native 直接呼叫、子代理經 wrapModelCall', async () => {
    const { messages } = await run({ summarization: false });
    expect(messages.at(-1)?.text).toBe('好了');
    expect(countsOf()).toMatchInlineSnapshot(`
      {
        "動手": {
          "hook": 0,
          "native": 3,
          "next": 3,
        },
        "叫一下 alpha": {
          "hook": 2,
          "native": 0,
          "next": 2,
        },
      }
    `);
  });
});
