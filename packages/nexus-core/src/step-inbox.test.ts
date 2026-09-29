/**
 * 插話的載體（[#710](https://github.com/DemianLi/nexus-agent/issues/710)）：兩個掛點各自的判斷。真組裝上「下一次模型呼叫看得到、
 * 同一輪再叫一次模型」的驗收在 `apps/harness/src/steer.test.ts`。
 */

import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { createStepInboxMiddleware, STEP_INBOX_CONFIG_KEY } from './step-inbox.js';
import type { StepInbox } from './step-inbox.js';
import { TURN_CANCEL_CONFIG_KEY } from './turn-cancel.js';

interface Hooks {
  beforeModel(state: unknown, runtime: unknown): unknown;
  afterAgent: { canJumpTo: readonly string[]; hook(state: unknown, runtime: unknown): unknown };
}

const hooks = () => createStepInboxMiddleware() as unknown as Hooks;

/** 記下被叫了幾次的 handle；`pending` 是還沒被領走的插話。 */
function inbox(pending: string[]) {
  const calls = { claim: 0, finish: 0, closed: false };
  const take = () => pending.splice(0).map((text) => new HumanMessage(text));
  const handle: StepInbox = {
    // 領走與關窗都在呼叫的那一刻同步做完，回的 Promise 只是交付（#713）。
    claim: () => {
      calls.claim += 1;
      return Promise.resolve(take());
    },
    finish: () => {
      calls.finish += 1;
      const messages = take();
      if (messages.length === 0) calls.closed = true;
      return Promise.resolve(messages);
    },
  };
  return { handle, calls };
}

/** root 的模型呼叫：`checkpoint_ns` 只有一段。子代理的前面多一段父圖的 `task`。 */
const ROOT_NS = 'model_request:1';
const SUBAGENT_NS = 'tools:9|model_request:1';

function runtime(handle: StepInbox, ns = ROOT_NS, signal?: AbortSignal) {
  return {
    configurable: {
      checkpoint_ns: ns,
      [STEP_INBOX_CONFIG_KEY]: handle,
      ...(signal === undefined ? {} : { [TURN_CANCEL_CONFIG_KEY]: signal }),
    },
  };
}

describe('beforeModel：叫模型之前領走整條插話', () => {
  it('有就併進 state，沒有就不動', async () => {
    const { handle } = inbox(['改用 X']);
    const update = (await hooks().beforeModel({}, runtime(handle))) as { messages: HumanMessage[] };
    expect(update.messages.map((message) => message.text)).toEqual(['改用 X']);
    expect(await hooks().beforeModel({}, runtime(handle))).toBeUndefined();
  });

  it('子代理的圖裡不領：那是給 root 那一輪的', async () => {
    const { handle, calls } = inbox(['改用 X']);
    expect(await hooks().beforeModel({}, runtime(handle, SUBAGENT_NS))).toBeUndefined();
    expect(calls.claim).toBe(0);
  });

  it('沒放 handle（CLI、手搭的組裝）什麼都不做', async () => {
    expect(
      await hooks().beforeModel({}, { configurable: { checkpoint_ns: ROOT_NS } }),
    ).toBeUndefined();
  });
});

describe('領走是同步的（#713）', () => {
  it('掛點被叫的那一刻就已經領走、關窗，不等回傳的 Promise', () => {
    const { handle, calls } = inbox(['改用 X']);
    void hooks().beforeModel({}, runtime(handle));
    expect(calls.claim).toBe(1);
    const empty = inbox([]);
    void hooks().afterAgent.hook({}, runtime(empty.handle));
    expect(empty.calls).toMatchObject({ finish: 1, closed: true });
  });
});

describe('afterAgent：收尾時還有插話就同一輪再叫一次模型', () => {
  it('宣告跳得回模型', () => {
    expect(hooks().afterAgent.canJumpTo).toEqual(['model']);
  });

  it('有插話：併進 state 並跳回模型（只回 jumpTo 的話路由器看到說完了的 AI 就收尾）', async () => {
    const { handle, calls } = inbox(['那個檔先別動']);
    const update = (await hooks().afterAgent.hook({}, runtime(handle))) as {
      messages: HumanMessage[];
      jumpTo: string;
    };
    expect(update.jumpTo).toBe('model');
    expect(update.messages.map((message) => message.text)).toEqual(['那個檔先別動']);
    expect(calls.closed).toBe(false);
  });

  it('沒有插話：關窗、不跳', async () => {
    const { handle, calls } = inbox([]);
    expect(await hooks().afterAgent.hook({}, runtime(handle))).toBeUndefined();
    expect(calls).toMatchObject({ finish: 1, closed: true });
  });

  it('中止之後不領也不跳：留著的由下一輪開頭領走', async () => {
    const { handle, calls } = inbox(['改用 X']);
    const controller = new AbortController();
    controller.abort();
    expect(
      await hooks().afterAgent.hook({}, runtime(handle, ROOT_NS, controller.signal)),
    ).toBeUndefined();
    expect(calls).toMatchObject({ claim: 0, finish: 0 });
  });

  it('子代理的圖收尾時不問', async () => {
    const { handle, calls } = inbox(['改用 X']);
    expect(await hooks().afterAgent.hook({}, runtime(handle, SUBAGENT_NS))).toBeUndefined();
    expect(calls.finish).toBe(0);
  });
});
