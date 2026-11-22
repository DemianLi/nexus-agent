/**
 * `agent/pre-step` 接縫的宿主端（[#1474](https://github.com/DemianLi/nexus-agent/issues/1474)）：listener 登記進來之後，宿主建的那顆
 * middleware 做了什麼。分兩半：
 *
 * 1. **通用的宿主行為**（假 listener）：名字、沒有 `stateSchema`、listener 收到什麼、訊息怎麼建、日誌怎麼記、失敗怎麼辦。
 * 2. **摘要之後（#397）**——用真的 agent-instructions listener（經 `agent-instructions.fixture.ts` 的舊外殼建構式）：摘要器不改寫
 *    `state.messages`，切點記在組裝的切點表（#2416）；宿主拿這次呼叫的切點算出模型看得到的那一串，再交給 listener。這一組是從
 *    插件套件的測試搬來的。宿主與摘要器拿的是同一張表，由 `agent-instructions.test.ts` 經真的組裝負責。
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { PreStepInjection, PreStepInvocation, PreStepListener } from '@nexus/agent-loop';
import {
  markHistoryFromLog,
  MESSAGE_SOURCE_KWARG,
  SESSION_EVENT_MAX_DEPTH,
  SessionLog,
  toLoggedMessage,
  TURN_CANCEL_CONFIG_KEY,
} from '@nexus/core';
import type { SessionLookup, SummaryCutoff } from '@nexus/core';
import {
  AGENT_INSTRUCTIONS_MARKER,
  DEFAULT_MAX_BYTES,
  isAgentInstructionsMessage,
} from '@nexus/plugin-agent-instructions';
import { describe, expect, it } from 'vitest';

import { createAgentInstructionsMiddleware } from './agent-instructions.fixture.js';
import { createPreStepMiddleware } from './pre-step-middleware.js';

interface Appended {
  readonly type: string;
  readonly data: unknown;
}

/** 一份會記下 `append` 的假日誌，與它被問到的設定。 */
function fakeSessions(options: { kind?: SessionLookup['kind'] } = {}): {
  forCall(config: unknown): SessionLookup;
  asked: unknown[];
  appended: Appended[];
} {
  const asked: unknown[] = [];
  const appended: Appended[] = [];
  return {
    asked,
    appended,
    forCall(config: unknown): SessionLookup {
      asked.push(config);
      if ((options.kind ?? 'ok') !== 'ok') return { kind: options.kind } as SessionLookup;
      return {
        kind: 'ok',
        address: { kind: 'root' },
        log: {
          append: (type: string, data: unknown) => {
            appended.push({ type, data });
          },
        },
      } as unknown as SessionLookup;
    },
  };
}

type Hook = (
  state: { messages?: readonly BaseMessage[] },
  runtime?: { readonly configurable?: unknown; readonly signal?: AbortSignal },
) => Promise<{ messages: BaseMessage[] } | undefined>;

const hookOf = (middleware: unknown): Hook => (middleware as { beforeAgent: Hook }).beforeAgent;

/** 沒摘要過的組裝：切點查找一律沒有。要切點的那幾條自己交。 */
const preStep = (
  name: string,
  listener: PreStepListener,
  sessions: Parameters<typeof createPreStepMiddleware>[2],
  cutoffOf: Parameters<typeof createPreStepMiddleware>[3] = () => undefined,
) => createPreStepMiddleware(name, listener, sessions, cutoffOf);

const NAME = 'FakePreStep';
const injecting =
  (...injections: PreStepInjection[]): PreStepListener =>
  () =>
    injections;

describe('宿主建的 middleware', () => {
  it('名字是登記時給的名字，掛在 beforeAgent，沒有 stateSchema（切點不在 graph state）', () => {
    const middleware = preStep(NAME, () => undefined, fakeSessions()) as unknown as {
      name: string;
      beforeAgent: unknown;
      stateSchema?: unknown;
    };
    expect(middleware.name).toBe(NAME);
    expect(typeof middleware.beforeAgent).toBe('function');
    expect(middleware.stateSchema).toBeUndefined();
  });

  it('listener 回 undefined 或空陣列：什麼都不加、也不記日誌', async () => {
    for (const result of [undefined, []]) {
      const sessions = fakeSessions();
      const middleware = preStep(NAME, () => result, sessions);
      expect(await hookOf(middleware)({ messages: [] }, { configurable: {} })).toBeUndefined();
      expect(sessions.appended).toEqual([]);
    }
  });

  it('listener 收到的呼叫設定是 { configurable: runtime.configurable }（不是裸的 configurable）', async () => {
    const seen: PreStepInvocation[] = [];
    const middleware = preStep(
      NAME,
      (_visible, invocation) => {
        seen.push(invocation);
        return undefined;
      },
      fakeSessions(),
    );
    const configurable = { thread_id: 't', checkpoint_ns: 'x:1' };
    await hookOf(middleware)({ messages: [] }, { configurable });
    await hookOf(middleware)({ messages: [] });
    expect(seen).toEqual([{ configurable }, { configurable: undefined }]);
    expect(seen[0]?.configurable).toBe(configurable);
    expect('configurable' in (seen[1] ?? {})).toBe(true);
  });

  describe('交給 listener 的中止訊號（契約 1.1.0，#1533）', () => {
    function seenSignals(runtimes: readonly Parameters<Hook>[1][]) {
      const seen: PreStepInvocation[] = [];
      const middleware = preStep(
        NAME,
        (_visible, invocation) => {
          seen.push(invocation);
          return undefined;
        },
        fakeSessions(),
      );
      return Promise.all(
        runtimes.map((runtime) => hookOf(middleware)({ messages: [] }, runtime)),
      ).then(() => seen);
    }

    it('這一輪的訊號在 configurable 的 TURN_CANCEL_CONFIG_KEY（pump 放的那顆）：原樣交出去，configurable 也照原樣', async () => {
      const turn = new AbortController();
      const configurable = { thread_id: 't', [TURN_CANCEL_CONFIG_KEY]: turn.signal };
      const [invocation] = await seenSignals([{ configurable }]);
      expect(invocation?.signal).toBe(turn.signal);
      expect(invocation?.configurable).toBe(configurable);
    });

    it('只有基座的 runtime.signal：交那一顆', async () => {
      const graph = new AbortController();
      const [invocation] = await seenSignals([{ configurable: {}, signal: graph.signal }]);
      expect(invocation?.signal).toBe(graph.signal);
    });

    it.each([
      ['這一輪的', 'turn'],
      ['基座的', 'graph'],
    ] as const)('兩顆都有：合成一顆，%s那顆舉起來就算停', async (_label, which) => {
      const turn = new AbortController();
      const graph = new AbortController();
      const [invocation] = await seenSignals([
        { configurable: { [TURN_CANCEL_CONFIG_KEY]: turn.signal }, signal: graph.signal },
      ]);
      expect(invocation?.signal?.aborted).toBe(false);
      (which === 'turn' ? turn : graph).abort();
      expect(invocation?.signal?.aborted).toBe(true);
    });

    it('兩顆都沒有（CLI、eval）：invocation 上沒有 signal 這一格', async () => {
      const seen = await seenSignals([{ configurable: { thread_id: 't' } }, undefined]);
      for (const invocation of seen) expect('signal' in invocation).toBe(false);
    });
  });

  it('訊息：內容照 listener 給的、記號在前 source 在後、不帶 id', async () => {
    const middleware = preStep(
      NAME,
      injecting({ content: '一則。', additionalKwargs: { marker: true, other: 1 } }),
      fakeSessions(),
    );
    const result = await hookOf(middleware)({ messages: [] }, { configurable: {} });
    expect(result?.messages).toHaveLength(1);
    const message = result?.messages[0] as HumanMessage;
    expect(message.getType()).toBe('human');
    expect(message.text).toBe('一則。');
    expect(Object.keys(message.additional_kwargs)).toEqual([
      'marker',
      'other',
      MESSAGE_SOURCE_KWARG,
    ]);
    expect(message.additional_kwargs[MESSAGE_SOURCE_KWARG]).toEqual({
      kind: 'plugin',
      plugin: NAME,
    });
    expect(message.id).toBeUndefined();
  });

  it('listener 沒給記號也行：只有 source', async () => {
    const middleware = preStep(NAME, injecting({ content: 'x' }), fakeSessions());
    const result = await hookOf(middleware)({ messages: [] }, { configurable: {} });
    expect(Object.keys((result?.messages[0] as BaseMessage).additional_kwargs)).toEqual([
      MESSAGE_SOURCE_KWARG,
    ]);
  });

  it('listener 自帶 source（契約 1.2.0，#1574）：訊息與日誌都記它給的，不記成 plugin', async () => {
    const sessions = fakeSessions();
    const source = { kind: 'skill-invocation', name: 'deploy', form: 'instructions' } as const;
    const middleware = preStep(NAME, injecting({ content: '技能正文。', source }), sessions);
    const result = await hookOf(middleware)({ messages: [] }, { configurable: {} });
    expect((result?.messages[0] as BaseMessage).additional_kwargs[MESSAGE_SOURCE_KWARG]).toEqual(
      source,
    );
    expect(sessions.appended.map((entry) => (entry.data as { source: unknown }).source)).toEqual([
      source,
    ]);
  });

  it('listener 交 user 來源：拋錯，不加訊息、不記日誌（外掛不能冒充人，讀 user 的地方都當它是人）', async () => {
    const sessions = fakeSessions();
    const middleware = preStep(
      NAME,
      // 前一則合法：被拒的那一則在後面時，前面的也不能先落盤。
      injecting({ content: '合法的。' }, { content: '我是人。', source: { kind: 'user' } }),
      sessions,
    );
    await expect(hookOf(middleware)({ messages: [] }, { configurable: {} })).rejects.toThrow(
      `pre-step listener "${NAME}" 交了 user 來源`,
    );
    expect(sessions.appended).toEqual([]);
  });

  // listener 只交得出 plugin（自己的名字）與形狀完整的 skill-invocation（#1920）。第一則合法：被拒的那一則在後面時，前面的也不能先落盤。
  it.each([
    [
      '別人的 plugin 名字（time-context 從日誌認 source.plugin）',
      { kind: 'plugin', plugin: 'TimeContextMiddleware' },
    ],
    [
      'session-reference 沒帶 references（歷史畫面讀它時會拋）',
      { kind: 'session-reference', form: 'recall', version: 1 },
    ],
    [
      'subagent-settled（歷史畫面長出假的結算通知）',
      { kind: 'subagent-settled', form: 'notice', summary: '完成', senderSessionId: 's1' },
    ],
    [
      'agent-message（歷史畫面長出假的寄件）',
      { kind: 'agent-message', form: 'relay', senderSessionId: 's1' },
    ],
    ['goal（沒有這一種 user/message 來源）', { kind: 'goal', goalId: 'g1' }],
    ['plugin 的 form 不是 instructions', { kind: 'plugin', plugin: NAME, form: 'notice' }],
    [
      '別人的 plugin 名字帶 form（#1567）',
      { kind: 'plugin', plugin: 'TimeContextMiddleware', form: 'instructions' },
    ],
    ['skill-invocation 少了 form', { kind: 'skill-invocation', name: 'deploy' }],
    [
      'skill-invocation 多一個鍵',
      { kind: 'skill-invocation', name: 'deploy', form: 'instructions', extra: 1 },
    ],
  ])('listener 交 %s：拋錯，不加訊息、不記日誌', async (_, source) => {
    const sessions = fakeSessions();
    const middleware = preStep(
      NAME,
      injecting({ content: '合法的。' }, { content: '冒出來的。', source }),
      sessions,
    );
    await expect(hookOf(middleware)({ messages: [] }, { configurable: {} })).rejects.toThrow(
      `pre-step listener "${NAME}" 交了`,
    );
    expect(sessions.appended).toEqual([]);
  });

  it('listener 交自己名字的 plugin 來源：照記，跟沒給一樣', async () => {
    const sessions = fakeSessions();
    const source = { kind: 'plugin', plugin: NAME } as const;
    const middleware = preStep(NAME, injecting({ content: '讀數。', source }), sessions);
    await hookOf(middleware)({ messages: [] }, { configurable: {} });
    expect(sessions.appended.map((entry) => (entry.data as { source: unknown }).source)).toEqual([
      source,
    ]);
  });

  it('listener 交自己名字、帶 form: instructions 的 plugin 來源（契約 1.3.0，#1567 N0136）：訊息與日誌都記這一格', async () => {
    const sessions = fakeSessions();
    const source = { kind: 'plugin', plugin: NAME, form: 'instructions' } as const;
    const middleware = preStep(NAME, injecting({ content: '指示。', source }), sessions);
    const result = await hookOf(middleware)({ messages: [] }, { configurable: {} });
    expect(result?.messages?.[0]?.additional_kwargs[MESSAGE_SOURCE_KWARG]).toEqual(source);
    expect(sessions.appended.map((entry) => (entry.data as { source: unknown }).source)).toEqual([
      source,
    ]);
  });

  it('listener 回多則：依序都加、依序都記', async () => {
    const sessions = fakeSessions();
    const middleware = preStep(NAME, injecting({ content: '甲' }, { content: '乙' }), sessions);
    const result = await hookOf(middleware)({ messages: [] }, { configurable: {} });
    expect(result?.messages.map((m) => m.text)).toEqual(['甲', '乙']);
    expect(sessions.appended.map((entry) => entry.type)).toEqual(['user/message', 'user/message']);
    expect(
      sessions.appended.map(
        (entry) => (entry.data as { message: { data?: { content?: unknown } } }).message,
      ),
    ).toHaveLength(2);
  });

  describe('日誌', () => {
    it('注入的訊息記成 user/message，來源是 { kind: plugin, plugin: 名字 }', async () => {
      const sessions = fakeSessions();
      const middleware = preStep(NAME, injecting({ content: '一則。' }), sessions);
      const configurable = { thread_id: 't', checkpoint_ns: 'x:1' };
      await hookOf(middleware)({ messages: [] }, { configurable });
      expect(sessions.asked).toEqual([{ configurable }]);
      expect(sessions.appended).toHaveLength(1);
      expect(sessions.appended[0]?.type).toBe('user/message');
      expect((sessions.appended[0]?.data as { source: unknown }).source).toEqual({
        kind: 'plugin',
        plugin: NAME,
      });
      expect(JSON.stringify(sessions.appended[0]?.data)).toContain('一則。');
    });

    it('兩顆 middleware 各綁各的 sessions：跑哪一顆就只問、只記那一顆綁的，不串到另一顆（#1479）', async () => {
      const mineSessions = fakeSessions();
      const otherSessions = fakeSessions();
      const mine = preStep(NAME, injecting({ content: '我的。' }), mineSessions);
      const other = preStep(NAME, injecting({ content: '別人的。' }), otherSessions);

      await hookOf(mine)({ messages: [] }, { configurable: {} });
      expect(mineSessions.asked).toHaveLength(1);
      expect(mineSessions.appended).toHaveLength(1);
      expect(otherSessions.asked).toHaveLength(0);
      expect(otherSessions.appended).toHaveLength(0);

      // 反方向也要量：先建的那顆不能把後建的那顆的查找佔走。
      await hookOf(other)({ messages: [] }, { configurable: {} });
      expect(otherSessions.asked).toHaveLength(1);
      expect(otherSessions.appended).toHaveLength(1);
      expect(JSON.stringify(otherSessions.appended[0]?.data)).toContain('別人的。');
      expect(mineSessions.asked).toHaveLength(1);
      expect(mineSessions.appended).toHaveLength(1);
    });

    it.each(['not-attached', 'unknown-caller', 'ambiguous'] as const)(
      '查找是 %s：不記，訊息照送',
      async (kind) => {
        const sessions = fakeSessions({ kind });
        const middleware = preStep(NAME, injecting({ content: 'x' }), sessions);
        const result = await hookOf(middleware)({ messages: [] }, { configurable: {} });
        expect(result?.messages).toHaveLength(1);
        expect(sessions.appended).toEqual([]);
      },
    );

    it('history-source=log、root：listener 看到的是日誌推出來的那一串，不是 state（#2355）', async () => {
      const log = new SessionLog('pre-step');
      log.append('turn/start', { kind: 'message', text: '日誌上的那句' });
      const sessions = {
        forCall: (): SessionLookup => ({ kind: 'ok', address: { kind: 'root' }, log }),
      };
      const seen: string[][] = [];
      const listener: PreStepListener = (messages) => {
        seen.push(messages.map((message) => message.text));
        return undefined;
      };
      const state = { messages: [new HumanMessage('state 裡的另一句')] };
      await hookOf(preStep(NAME, listener, sessions))(state, { configurable: {} });
      markHistoryFromLog(sessions);
      await hookOf(preStep(NAME, listener, sessions))(state, { configurable: {} });
      expect(seen).toEqual([['state 裡的另一句'], ['日誌上的那句']]);
    });

    it('history-source=log、子代理：listener 看到的是子代理自己日誌推出來的那一串，不是 state（#2751）', async () => {
      const log = new SessionLog('pre-step-sub');
      log.append('user/message', {
        message: toLoggedMessage(new HumanMessage('子代理日誌上的那句')),
        source: { kind: 'user' },
      });
      const sessions = {
        forCall: (): SessionLookup => ({
          kind: 'ok',
          address: { kind: 'subagent', runId: 'r' },
          log,
        }),
      };
      const seen: string[][] = [];
      const listener: PreStepListener = (messages) => {
        seen.push(messages.map((message) => message.text));
        return undefined;
      };
      const state = { messages: [new HumanMessage('子代理 state 裡的另一句')] };
      await hookOf(preStep(NAME, listener, sessions))(state, { configurable: {} });
      markHistoryFromLog(sessions);
      await hookOf(preStep(NAME, listener, sessions))(state, { configurable: {} });
      expect(seen).toEqual([['子代理 state 裡的另一句'], ['子代理日誌上的那句']]);
    });

    it('history-source=log、子代理的日誌推不回：listener 還沒叫就拋，訊息講子代理（#2751）', async () => {
      const log = new SessionLog('pre-step-sub-broken');
      log.append('turn/start', { kind: 'message', text: '甲' });
      log.append('model/start', {});
      log.append('model/end', {});
      log.append('turn/end', {});
      const sessions = {
        forCall: (): SessionLookup => ({
          kind: 'ok',
          address: { kind: 'subagent', runId: 'r' },
          log,
        }),
      };
      markHistoryFromLog(sessions);
      let called = false;
      const middleware = preStep(
        NAME,
        () => {
          called = true;
          return undefined;
        },
        sessions,
      );
      await expect(
        hookOf(middleware)({ messages: [new HumanMessage('甲')] }, { configurable: {} }),
      ).rejects.toThrow(/這個子代理的日誌推不回它的模型歷史/u);
      expect(called).toBe(false);
    });

    it.each(['not-attached', 'unknown-caller', 'ambiguous'] as const)(
      '查找是 %s、history-source=log：listener 還沒叫就拋，這一輪失敗（#2355）',
      async (kind) => {
        const sessions = fakeSessions({ kind });
        markHistoryFromLog(sessions);
        let called = false;
        const middleware = preStep(
          NAME,
          () => {
            called = true;
            return [{ content: 'x' }];
          },
          sessions,
        );
        await expect(hookOf(middleware)({ messages: [] }, { configurable: {} })).rejects.toThrow(
          `pre-step listener 找不到這次呼叫的日誌（${kind}）`,
        );
        expect(called).toBe(false);
        expect(sessions.appended).toEqual([]);
      },
    );

    /**
     * #1665：照 dsh，注入的訊息寫不進去就是這一輪失敗，不吞（`agent.ts:427-436`）。用真的日誌、真的拒收：插件交來的記號巢狀
     * 超過上限。
     */
    it('日誌拒收（插件的記號太深）：原錯往外拋，日誌上沒有這一則', async () => {
      const log = new SessionLog('pre-step');
      let deep: unknown = 'leaf';
      for (let level = 0; level < SESSION_EVENT_MAX_DEPTH; level++) deep = [deep];
      const middleware = preStep(NAME, injecting({ content: 'x', additionalKwargs: { deep } }), {
        forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log }),
      });
      await expect(hookOf(middleware)({ messages: [] }, { configurable: {} })).rejects.toThrow(
        /^會話事件的 user\/message 的 data\.message\..* 是第 \d+ 層巢狀，超過上限 600 層$/,
      );
      expect(log.events).toEqual([]);
    });

    it('反例：收得下的記號照常記、照常送', async () => {
      const log = new SessionLog('pre-step');
      const middleware = preStep(
        NAME,
        injecting({ content: 'x', additionalKwargs: { shallow: [1] } }),
        { forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log }) },
      );
      const result = await hookOf(middleware)({ messages: [] }, { configurable: {} });
      expect(result?.messages).toHaveLength(1);
      expect(log.events.map((event) => event.type)).toEqual(['user/message']);
    });
  });

  it('listener 自己拋錯不被吞：注入靜靜消失比一個明確的錯誤更難發現', async () => {
    const middleware = preStep(
      NAME,
      () => {
        throw new Error('listener 壞了');
      },
      fakeSessions(),
    );
    await expect(hookOf(middleware)({ messages: [] }, { configurable: {} })).rejects.toThrow(
      'listener 壞了',
    );
  });

  it('listener 是非同步的也行', async () => {
    const middleware = preStep(
      NAME,
      async () => {
        await Promise.resolve();
        return [{ content: '晚到的。' }];
      },
      fakeSessions(),
    );
    const result = await hookOf(middleware)({ messages: [] }, { configurable: {} });
    expect(result?.messages[0]?.text).toBe('晚到的。');
  });
});

describe('listener 看到的是「模型看得到的那一串」（摘要切點套上去之後）', () => {
  const summary = new HumanMessage({
    content: '前情提要。',
    additional_kwargs: { lc_source: 'summarization' },
  });
  const messages = (): BaseMessage[] => [
    new HumanMessage('第一句'),
    new HumanMessage('第二句'),
    new HumanMessage('第三句'),
  ];

  it('沒有切點：整個 state.messages', async () => {
    let seen: readonly BaseMessage[] = [];
    const middleware = preStep(
      NAME,
      (visible) => {
        seen = visible;
        return undefined;
      },
      fakeSessions(),
    );
    const all = messages();
    await hookOf(middleware)({ messages: all }, { configurable: {} });
    expect(seen.map((m) => m.text)).toEqual(['第一句', '第二句', '第三句']);
  });

  it('有切點：[摘要, ...切點之後]，切點之前的 listener 看不到；查找拿到的是這次呼叫的設定與 state 的訊息', async () => {
    let seen: readonly BaseMessage[] = [];
    const asked: { configurable: unknown; messages: readonly BaseMessage[] }[] = [];
    const cutoff = { cutoffIndex: 2, summaryMessage: summary, filePath: null };
    const middleware = preStep(
      NAME,
      (visible) => {
        seen = visible;
        return undefined;
      },
      fakeSessions(),
      (config, current) => {
        asked.push({ configurable: config.configurable, messages: current });
        return cutoff;
      },
    );
    const all = messages();
    const configurable = { thread_id: 't', checkpoint_ns: 'model_request:x' };
    await hookOf(middleware)({ messages: all }, { configurable });
    expect(seen.map((m) => m.text)).toEqual(['前情提要。', '第三句']);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.configurable).toBe(configurable);
    expect(asked[0]!.messages).toBe(all);
  });
});

/** 只回得出指定那幾個檔的假 backend；其餘一律「讀不到」。 */
function fakeBackend(files: Record<string, string>) {
  return {
    read: (path: string) =>
      Object.prototype.hasOwnProperty.call(files, path)
        ? Promise.resolve({ content: files[path] })
        : Promise.resolve({ error: 'file_not_found' }),
  };
}

async function inject(
  files: Record<string, string>,
  messages: readonly BaseMessage[] = [],
  cutoff?: SummaryCutoff,
): Promise<BaseMessage[] | undefined> {
  const middleware = createAgentInstructionsMiddleware(
    fakeBackend(files) as never,
    DEFAULT_MAX_BYTES,
    undefined,
    () => cutoff,
  );
  const result = await hookOf(middleware)({ messages });
  return result?.messages;
}

function baselineMessage(): HumanMessage {
  return new HumanMessage({
    content: '舊的基線',
    additional_kwargs: { [AGENT_INSTRUCTIONS_MARKER]: true },
  });
}

/**
 * 摘要之後（[#397](https://github.com/DemianLi/nexus-agent/issues/397)）。摘要器不改寫 `state.messages`，切點記在組裝的
 * 切點表，模型看到的是 `[summary, ...messages.slice(cutoffIndex)]`。這裡直接交切點；宿主與摘要器拿同一張表，由
 * `agent-instructions.test.ts` 經真的組裝負責。
 */
describe('摘要之後：模型看得到一則才算有（agent-instructions listener 經宿主 middleware）', () => {
  const summary = new HumanMessage({
    content: '前情提要。',
    additional_kwargs: { lc_source: 'summarization' },
  });
  const history = (): BaseMessage[] => [
    new HumanMessage('第一句'),
    baselineMessage(),
    new HumanMessage('第二句'),
    new HumanMessage('第三句'),
  ];

  it('舊基線落在切點之前：補一則新的', async () => {
    const cutoff = { cutoffIndex: 2, summaryMessage: summary, filePath: null };
    const messages = await inject({ '/AGENTS.md': '規矩。' }, history(), cutoff);
    expect(messages).toHaveLength(1);
    expect(isAgentInstructionsMessage(messages?.[0] as BaseMessage)).toBe(true);
  });

  it('舊基線就在切點上（模型看得到）：不補', async () => {
    const cutoff = { cutoffIndex: 1, summaryMessage: summary, filePath: null };
    expect(await inject({ '/AGENTS.md': '規矩。' }, history(), cutoff)).toBeUndefined();
  });

  it('沒有切點：退回「state 裡有一則就不補」', async () => {
    expect(await inject({ '/AGENTS.md': '規矩。' }, history())).toBeUndefined();
  });

  it('沒有基線的 state：補一則，帶記號與標成指示的 plugin 來源', async () => {
    const messages = await inject({ '/AGENTS.md': '規矩。' }, [new HumanMessage('開工')]);
    expect(messages).toHaveLength(1);
    const kwargs = (messages?.[0] as BaseMessage).additional_kwargs;
    expect(Object.keys(kwargs)).toEqual([AGENT_INSTRUCTIONS_MARKER, MESSAGE_SOURCE_KWARG]);
    expect(kwargs[MESSAGE_SOURCE_KWARG]).toEqual({
      kind: 'plugin',
      plugin: 'AgentInstructionsMiddleware',
      form: 'instructions',
    });
  });
});

describe('舊外殼（fixture）', () => {
  it('沒接會話時照樣加訊息、只是不記', async () => {
    const messages = await inject({ '/AGENTS.md': '規矩。' });
    expect(messages).toHaveLength(1);
  });

  it('這一輪已經停下（pump 放的訊號舉起來了）：真的 listener 經宿主拋中止，一個檔都沒讀、沒有訊息', async () => {
    const reads: string[] = [];
    const backend = {
      read: (path: string) => {
        reads.push(path);
        return Promise.resolve({ content: '規矩。' });
      },
    };
    const turn = new AbortController();
    turn.abort();
    const middleware = createAgentInstructionsMiddleware(backend as never, DEFAULT_MAX_BYTES);
    await expect(
      hookOf(middleware)(
        { messages: [] },
        { configurable: { [TURN_CANCEL_CONFIG_KEY]: turn.signal } },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toEqual([]);
  });
});
