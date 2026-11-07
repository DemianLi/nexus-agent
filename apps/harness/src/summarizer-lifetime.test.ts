/**
 * 摘要器狀態的壽命：切點與歷史檔的會話名跟著哪一段生命走。
 *
 * - 前景子代理：同型的子代理委派兩次，各是一段生命，身分（去尾的 `checkpoint_ns`，切點跟著它）不同；歷史檔的會話名跟著
 *   同一個身分，每次委派各一份檔、跟 root 的不同。同一步派出的兩次各寫各的檔，回到 root 時兩段都在。
 * - 續接：壓縮過、重啟、續接之後又壓縮，新的那次從灌回串的座標算起。
 * - 沒有 checkpointer：切點的壽命等於訊息 state 的壽命。langgraph 沒有 checkpointer 時 invoke 之間 state 不延續；native 的
 *   per-thread state 在實例裡，沒有 checkpointer 也延續。同一張表上留著舊切點、這一次交進來的串比切點短，也不套。
 * - 沒有日誌：摘要之後那次模型呼叫失敗，切點不遺失，下一輪接著它。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { SUMMARY_PROMPT } from '@nexus/core';
import type { ModelContextLimits, SessionEvent } from '@nexus/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { createEchoPlugin } from './echo.fixture.js';
import { withShippedRequestBody } from './live-model.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import {
  childLogsOf,
  compareToLog,
  fakeEndpoint,
  hasTools,
  idleWithContent,
  LOW_SUMMARIZATION,
  mainOnly,
  rootLogOf,
  runServeDriver,
  runServePhases,
} from './log-derived-history.fixture.js';
import type { Body, Reply, Script } from './log-derived-history.fixture.js';

beforeAll(() => {
  // `--live` 要有金鑰才肯組模型；端點是本機假的，這顆不會送到任何地方。
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-summarizer-lifetime');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const PAD = '內容'.repeat(100);
const echo = (id: string, message: string) => ({ id, name: 'echo', args: { message } });
const summaries = (events: readonly SessionEvent[]) =>
  events.filter((e): e is SessionEvent<'compaction/summary'> => e.type === 'compaction/summary');

/** 請求屬於誰：第一則使用者訊息（摘要過的話是摘要）裡的記號。 */
const markerOf = (body: Body): string => {
  const text = JSON.stringify(body.messages.filter((m) => m.role === 'user').slice(0, 1));
  return (
    /CHILD-[A-Z]/.exec(text)?.[0] ??
    /摘要 (CHILD-[A-Z])/.exec(JSON.stringify(body.messages))?.[1] ??
    'ROOT'
  );
};

describe('前景子代理：每次委派各一段生命', () => {
  it('同型子代理連兩次前景委派：兩份日誌、身分不同、各自摘要；歷史檔各一份、跟 root 的不同', async () => {
    const counters = new Map<string, number>();
    const child = (mark: string, k: number): Reply => {
      if (k <= 2) return { tools: [echo(`call_${mark}${String(k)}`, `小${String(k)}${PAD}`)] };
      if (k === 3) return { tools: [echo(`call_${mark}_big`, '中'.repeat(10_000))] };
      if (k === 4) return { tools: [echo(`call_${mark}_after`, '之後')] };
      return { content: `${mark} 完成。` };
    };
    const script: Script = (_index, body) => {
      if (!hasTools(body)) {
        const text = JSON.stringify(body.messages);
        // root 的串裡也有子代理的記號（task 的參數），先認 root 的第一句。
        if (text.includes('派兩次前景')) return { content: '摘要 ROOT' };
        const mark = /CHILD-[A-Z]/.exec(text)?.[0];
        return { content: mark === undefined ? '標題' : `摘要 ${mark}` };
      }
      const mark = markerOf(body);
      const k = counters.get(mark) ?? 0;
      counters.set(mark, k + 1);
      if (mark !== 'ROOT') return child(mark, k);
      const task = (id: string, description: string): Reply => ({
        tools: [{ id, name: 'task', args: { description, subagent_type: 'general-purpose' } }],
      });
      if (k === 0) return task('call_ta', 'CHILD-A 做事');
      if (k === 1) return task('call_tb', 'CHILD-B 做事');
      // root 自己也摘要一次，才有它的歷史檔可比。
      if (k === 2) return { tools: [echo('call_root_big', '根'.repeat(10_000))] };
      if (k === 3) return { tools: [echo('call_root_after', '根之後')] };
      return {};
    };
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '派兩次前景');
        // 等 root 的收尾那句：只看 idle，負載下會在委派跑完之前就收工。
        await ctx.fold(
          (state) =>
            idleWithContent(state) &&
            state.entries.some((e) => e.kind === 'ai' && !e.streaming && e.text === '好。'),
          60_000,
        );
      },
      script,
      [
        '- id: background-subagents',
        '  config:',
        '    backgroundMode: one-shot',
        '    maxActiveSubagents: 8',
        LOW_SUMMARIZATION,
      ].join('\n'),
    );

    const children = childLogsOf(run);
    expect(children.map((log) => log.id.split('/')[0])).toEqual(['alpha', 'alpha']);
    const ids = children.map((log) => log.id);
    // 前景子代理的會話 id 是 `<thread>/<去尾的 checkpoint_ns>`（session-address）：兩次委派不同，也不等於 root 的。
    expect(new Set(ids).size, `子代理身分：${ids.join(', ')}`).toBe(2);
    expect(ids).not.toContain(rootLogOf(run).id);

    const filePaths = children.map((log) => {
      const found = summaries(log.events);
      expect(found.length, `${log.id} 應該摘要過`).toBeGreaterThan(0);
      return found.at(-1)!.data.filePath;
    });
    expect(filePaths.every((path) => typeof path === 'string')).toBe(true);
    expect(new Set(filePaths).size, `歷史檔：${filePaths.join(', ')}`).toBe(2);
    const rootSummaries = summaries(rootLogOf(run).events);
    expect(rootSummaries.length, 'root 應該摘要過').toBeGreaterThan(0);
    expect(filePaths).not.toContain(rootSummaries.at(-1)!.data.filePath);

    for (const log of children) {
      const mark = /CHILD-[A-Z]/.exec(
        JSON.stringify(log.events.find((e) => e.type === 'user/message')?.data ?? ''),
      )?.[0];
      const verdicts = await compareToLog(
        log.events,
        run.mainBodies.filter((body) => markerOf(body) === mark),
      );
      expect(verdicts.filter((v) => v.kinds.length > 0 || !v.systemMatches)).toEqual([]);
    }
  }, 180_000);
});

describe('前景子代理：歷史檔每次委派各一份', () => {
  /** 一個子代理：第一句帶暗號，接著撐到摘要，摘要之後再一步收尾。 */
  const child = (mark: string, k: number): Reply => {
    if (k === 0) return { tools: [echo(`call_${mark}0`, `暗號-${mark}${PAD}`)] };
    if (k === 1) return { tools: [echo(`call_${mark}1`, `小1${PAD}`)] };
    if (k === 2) return { tools: [echo(`call_${mark}_big`, '中'.repeat(10_000))] };
    if (k === 3) return { tools: [echo(`call_${mark}_after`, '之後')] };
    return { content: `${mark} 完成。` };
  };
  const summaryOf = (body: Body): Reply => {
    const mark = /CHILD-[A-Z]/.exec(JSON.stringify(body.messages))?.[0];
    return { content: mark === undefined ? '標題' : `摘要 ${mark}` };
  };
  const task = (id: string, description: string) => ({
    id,
    name: 'task',
    args: { description, subagent_type: 'general-purpose' },
  });
  const toolResults = (events: readonly SessionEvent[]) =>
    events
      .filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
      .map((e) => JSON.stringify(e.data));
  const serve = (script: Script, opening: string) =>
    runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', opening);
        await ctx.fold(
          (state) =>
            idleWithContent(state) &&
            state.entries.some((e) => e.kind === 'ai' && !e.streaming && e.text === '好。'),
          60_000,
        );
      },
      script,
      [
        '- id: background-subagents',
        '  config:',
        '    backgroundMode: one-shot',
        '    maxActiveSubagents: 8',
        LOW_SUMMARIZATION,
      ].join('\n'),
    );

  it('同一步派兩次同型前景委派：兩段歷史都留在 root 的 backend 上', async () => {
    const counters = new Map<string, number>();
    const script: Script = (_index, body) => {
      if (!hasTools(body)) return summaryOf(body);
      const mark = markerOf(body);
      const k = counters.get(mark) ?? 0;
      counters.set(mark, k + 1);
      if (mark !== 'ROOT') return child(mark, k);
      if (k === 0)
        return { tools: [task('call_ta', 'CHILD-A 做事'), task('call_tb', 'CHILD-B 做事')] };
      if (k === 1)
        return {
          tools: [
            { id: 'call_ls', name: 'ls', args: { path: '/conversation_history' } },
            {
              id: 'call_grep',
              name: 'grep',
              args: { pattern: '暗號-CHILD-', path: '/conversation_history' },
            },
          ],
        };
      return {};
    };
    const run = await serve(script, '同一步派兩次');

    const children = childLogsOf(run);
    expect(children.length).toBe(2);
    for (const log of children)
      expect(summaries(log.events).length, `${log.id} 應該摘要過`).toBeGreaterThan(0);
    const results = toolResults(rootLogOf(run).events);
    const listing = results.find((text) => text.includes('call_ls')) ?? results.join('\n');
    // backend 上的鍵就是歷史檔路徑：每次委派一個 `session_<8hex>.md`。
    const keys = new Set(listing.match(/\/conversation_history\/session_[0-9a-f]{8}\.md/g) ?? []);
    expect(keys.size, `root 的 /conversation_history：${listing}`).toBe(2);
    const grep = results.find((text) => text.includes('call_grep')) ?? results.join('\n');
    expect(grep).toContain('暗號-CHILD-A');
    expect(grep).toContain('暗號-CHILD-B');
  }, 180_000);

  it('同型前景委派兩次：第二次的歷史檔不含第一次的暗號', async () => {
    const counters = new Map<string, number>();
    const script: Script = (_index, body) => {
      if (!hasTools(body)) return summaryOf(body);
      const mark = markerOf(body);
      const k = counters.get(mark) ?? 0;
      counters.set(mark, k + 1);
      if (mark === 'ROOT') {
        if (k === 0) return { tools: [task('call_ta', 'CHILD-A 做事')] };
        if (k === 1) return { tools: [task('call_tb', 'CHILD-B 做事')] };
        return {};
      }
      if (mark === 'CHILD-B' && k === 4) {
        // 摘要過的串裡有那句「完整歷史存在 <路徑>」：照它讀回自己的歷史檔。
        const path = /saved to (\S+?\.md)/.exec(JSON.stringify(body.messages))?.[1];
        if (path !== undefined)
          return { tools: [{ id: 'call_read', name: 'read_file', args: { file_path: path } }] };
      }
      return child(mark, mark === 'CHILD-B' && k > 4 ? k - 1 : k);
    };
    const run = await serve(script, '派兩次');

    const second = childLogsOf(run).find((log) =>
      JSON.stringify(log.events.find((e) => e.type === 'user/message')?.data ?? '').includes(
        'CHILD-B',
      ),
    );
    expect(second, '找不到第二次委派的日誌').toBeDefined();
    const read = toolResults(second!.events).find((text) => text.includes('call_read'));
    expect(read, '第二次委派沒有讀到自己的歷史檔').toBeDefined();
    expect(read).toContain('暗號-CHILD-B');
    expect(read).not.toContain('暗號-CHILD-A');
  }, 180_000);
});

describe('續接之後又壓縮', () => {
  it('壓縮、重啟續接、再壓縮：新的切點從灌回串算起，推導等於實送', async () => {
    const BIG: Reply = { tools: [echo('call_mid', '中'.repeat(10_000))] };
    const BIG2: Reply = { tools: [echo('call_mid2', '後'.repeat(10_000))] };
    const before = ['短a', '短b', '短c', '大結果', '短d'].map((t) => `${t}${PAD}`);
    const after = ['重啟後一', '重啟後二', '大結果二', '重啟後三'].map((t) => `${t}${PAD}`);
    // 主呼叫編號：前段每句一次，大結果那句多一次（工具之後）；後段同理。
    const script = mainOnly((k) => (k === 3 ? BIG : k === 8 ? BIG2 : {}));
    const run = await runServePhases([before, after], script, LOW_SUMMARIZATION);

    const resumedAt = run.events.find((e) => e.type === 'session/end-seed');
    expect(resumedAt, '應該有一次續接').toBeDefined();
    const found = summaries(run.events);
    const old = found.filter((e) => e.seq < resumedAt!.seq);
    const fresh = found.filter((e) => e.seq > resumedAt!.seq);
    expect(old.length, '重啟前摘要過').toBeGreaterThan(0);
    expect(fresh.length, '重啟後又摘要').toBeGreaterThan(0);

    // 新生命週期第一次摘要的請求：摘要器那次呼叫收到的（不帶工具）裡有上一次的摘要，也就是從灌回串摘起。
    const verdicts = await compareToLog(run.events, run.mainBodies);
    expect(verdicts.filter((v) => v.kinds.length > 0 || !v.systemMatches)).toEqual([]);
    // 續接後最後一次主呼叫：第一則是新的摘要，裡面不再有舊的大結果。
    const last = run.mainBodies.at(-1)!;
    expect(JSON.stringify(last.messages)).not.toContain('中'.repeat(100));
  }, 180_000);
});

describe('沒有 checkpointer 的組裝', () => {
  it('同一個 thread_id invoke 兩次：切點的壽命等於訊息 state 的壽命', async () => {
    const upstream = await fakeEndpoint(
      (_index, body) => (hasTools(body) ? {} : { content: '【摘要】之前聊了很多。' }),
      false,
    );
    const root = await mkdtemp(join(tmpdir(), 'nexus-lifetime-'));
    const { agent, dispose } = await createNexusAgent({
      model: new ChatOpenAI({
        model: 'fake',
        apiKey: 'sk-loopback',
        maxRetries: 0,
        configuration: { baseURL: upstream.baseURL, fetch: withShippedRequestBody() },
      }),
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      systemPrompt: '你是測試助手。',
      plugins: [createEchoPlugin()],
      summarization: { trigger: [{ type: 'tokens', value: 6000 }], retainTokens: 12 },
    });
    const config = { configurable: { thread_id: 'no-saver' } };
    const turns = (count: number, tag: string, big?: number) =>
      Array.from({ length: count }, (_, i) =>
        i % 2 === 0
          ? new HumanMessage(`${tag}人${String(i)}${i === big ? '中'.repeat(30_000) : ''}`)
          : new AIMessage(`${tag}答${String(i)}`),
      );
    try {
      const first = turns(9, '一', 2);
      await agent.invoke({ messages: first }, config);
      const firstSummaries = upstream.bodies.filter((body) => !hasTools(body)).length;
      expect(firstSummaries, '第一次應該摘要過').toBeGreaterThan(0);

      const second = turns(13, '二');
      const count = upstream.bodies.length;
      await agent.invoke({ messages: second }, config);
      const bodies = upstream.bodies.slice(count);
      expect(bodies.every(hasTools), '第二次不該摘要').toBe(true);
      const sent = bodies[0]!.messages.filter((m) => m.role !== 'system').map((m) => m.content);
      const secondTexts = second.map((m) => m.content);
      // 判 loop 同 `human-message-admission-wire.test.ts`：`vitest.native.config.ts` 設這個變數。
      if (process.env.NEXUS_TEST_AGENT_LOOP === 'native') {
        // native 的 per-thread state 在實例裡，沒有 checkpointer 也延續：第二次接在第一次後面，切點跟著延續的訊息串。
        // 送出的是「摘要＋第一次切點之後的＋第二次交進去的」，中間那段是第一次（9 則輸入＋回覆）的尾巴。
        const firstTexts = [...first.map((m) => m.content), '好。'];
        expect(String(sent[0])).toContain('【摘要】之前聊了很多。');
        expect(sent.slice(-secondTexts.length)).toEqual(secondTexts);
        const carried = sent.slice(1, -secondTexts.length);
        expect(carried.length).toBeGreaterThan(0);
        expect(carried.length).toBeLessThan(firstTexts.length);
        expect(carried).toEqual(firstTexts.slice(-carried.length));
      } else {
        // langgraph 沒有 checkpointer 時 invoke 之間 state 不延續：送出的就是第二次交進去的那一串，切點不殘留。
        expect(sent).toEqual(secondTexts);
      }
    } finally {
      await dispose();
      await upstream.close();
    }
  }, 60_000);

  it('同一張表留著舊切點、這一次交進來的串比切點短：不套舊切點', async () => {
    const upstream = await fakeEndpoint(
      (_index, body) => (hasTools(body) ? {} : { content: '【摘要】之前聊了很多。' }),
      false,
    );
    const root = await mkdtemp(join(tmpdir(), 'nexus-lifetime-short-'));
    const { agent, dispose } = await createNexusAgent({
      model: new ChatOpenAI({
        model: 'fake',
        apiKey: 'sk-loopback',
        maxRetries: 0,
        configuration: { baseURL: upstream.baseURL, fetch: withShippedRequestBody() },
      }),
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      systemPrompt: '你是測試助手。',
      plugins: [createEchoPlugin()],
      summarization: { trigger: [{ type: 'tokens', value: 6000 }], retainTokens: 12 },
    });
    const config = { configurable: { thread_id: 'short-after' } };
    try {
      const first = Array.from({ length: 9 }, (_, i) =>
        i % 2 === 0
          ? new HumanMessage(`一人${String(i)}${i === 2 ? '中'.repeat(30_000) : ''}`)
          : new AIMessage(`一答${String(i)}`),
      );
      await agent.invoke({ messages: first }, config);
      expect(upstream.bodies.filter((body) => !hasTools(body)).length, '第一次應該摘要過').toBe(1);

      // 灌回的樣子：比第一次的切點短。
      const second = [new HumanMessage('灌回的摘要'), new HumanMessage('灌回之後')];
      const count = upstream.bodies.length;
      await agent.invoke({ messages: second }, config);
      const sent = upstream.bodies
        .slice(count)[0]!
        .messages.filter((m) => m.role !== 'system')
        .map((m) => m.content);
      if (process.env.NEXUS_TEST_AGENT_LOOP === 'native') {
        // native 的 state 接在第一次後面，沒有「較短的串」：切點跟著延續的串，送的是摘要開頭、第二次交的收尾。
        expect(String(sent[0])).toContain('【摘要】之前聊了很多。');
        expect(sent.slice(-2)).toEqual(['灌回的摘要', '灌回之後']);
      } else {
        expect(sent).toEqual(['灌回的摘要', '灌回之後']);
      }
    } finally {
      await dispose();
      await upstream.close();
    }
  }, 60_000);
});

describe('沒有日誌的組裝', () => {
  const SUMMARY_MARK = SUMMARY_PROMPT.split('\n')[0]!;
  const isSummaryCall = (prompt: readonly BaseMessage[]) =>
    prompt.some((message) => message.text.includes(SUMMARY_MARK));
  const SMALL: ModelContextLimits = { contextWindow: 4_200, maxOutputTokens: 200 };
  const BIG: ModelContextLimits = { contextWindow: 700_045, maxOutputTokens: 16_384 };
  const H1 = `第 1 句。${PAD}`;

  it('摘要之後那次模型呼叫失敗：切點不遺失，下一輪接著它、不重摘', async () => {
    const model = new ScriptedChatModel({
      turns: [
        { content: `好 1${PAD}` },
        { content: '摘要一' },
        { content: '', error: 'upstream 503' },
        { content: '好 3' },
      ],
    });
    const root = await mkdtemp(join(tmpdir(), 'nexus-lifetime-nolog-'));
    let limits = SMALL;
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
      checkpointer: new MemorySaver(),
      plugins: [],
      summarization: { trigger: [{ type: 'tokens', value: 100_000 }], retainTokens: 12 },
      modelLimits: () => limits,
    });
    const config = { configurable: { thread_id: 'no-log' } };
    try {
      await agent.invoke(toAgentInvocation(H1), config);
      await expect(agent.invoke(toAgentInvocation('長'.repeat(2_400)), config)).rejects.toThrow();
      limits = BIG;
      await agent.invoke(toAgentInvocation('第 3 句。'), config);

      // 前提：第 2 輪摘要過一次、那次請求失敗了。
      expect(model.prompts.filter(isSummaryCall)).toHaveLength(1);
      expect(model.prompts).toHaveLength(4);
      // 第 3 輪的請求：摘要開頭，第 1 句不在裡面。
      const last = model.prompts
        .at(-1)!
        .slice(1)
        .map((m) => m.text);
      expect(last[0]).toContain('摘要一');
      expect(last.some((text) => text.includes(H1))).toBe(false);
      expect(last.at(-1)).toBe('第 3 句。');
    } finally {
      await dispose();
    }
  }, 60_000);
});
