/**
 * 背景子代理做完，主對話被叫醒（[#840](https://github.com/DemianLi/nexus-agent/issues/840)）：**走產品的線**——
 * 真的組裝、真的 `createWireHandler`（結算通知的接線就在它 `attachSession` 那一行）、假模型。
 *
 * 要釘的：root 已經收尾、閒著；背景子代理之後才做完；root 因此多開一輪，模型讀到的是結算通知，
 * 日誌上那一輪的 `turn/start` 是 `subagent-settled`（不是人話、沒有直接人類授權），畫面上不出現一則人的泡泡。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent, SessionRegistry } from '@nexus/core';
import { hasDirectHumanTurn } from '@nexus/plugin-goal';
import { createWireClient, emptyConversation, reduceConversation } from '@nexus/wire';
import type { ConversationState, Event } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://settle.test';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-bg-settle-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function assemble(options: { readonly stepInbox: boolean; readonly workerSends?: boolean }) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker: PluginEntry = {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: new ScriptedChatModel({
            turns: [
              { content: '', toolCalls: [{ name: 'gate', id: 'bg-call', args: {} }] },
              ...(options.workerSends === true
                ? [
                    {
                      content: '',
                      toolCalls: [
                        {
                          name: 'send_message',
                          id: 'bg-send',
                          args: { agent_id: 'settle-thread', message: '半路發現：入口在 A' },
                        },
                      ],
                    },
                  ]
                : []),
              { content: '做完，結論是 X' },
            ],
          }) as never,
        });
        registry.tools.register(
          tool(async () => (await gate, '放行了'), {
            name: 'gate',
            description: '等放行。',
            schema: z.object({}),
          }),
        );
      },
    },
  };
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'subagent',
              id: 'root-call',
              args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
            },
          ],
        },
        { content: '根收尾' },
        { content: '子代理說結論是 X' },
        { content: '收到' },
        { content: '也收到' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [worker],
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    backgroundSubagents: {},
    stepInbox: options.stepInbox,
  });
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      stepInbox: built.stepInbox,
      attachSession: (registry: SessionRegistry, backgroundPort) => {
        sessions = registry;
        return built.attachSession(registry, backgroundPort);
      },
      dispose: built.dispose,
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const events = await client.openEvents('settle-thread');
  const frames: Event[] = [];
  let state: ConversationState = emptyConversation();
  const draining = (async () => {
    for (;;) {
      const next = await events.next();
      if (next.done === true) return;
      frames.push(next.value);
      state = reduceConversation(state, next.value);
    }
  })();
  const rootLog = (): readonly SessionEvent[] =>
    sessions
      ?.list()
      .filter((entry) => entry.address.kind === 'root')
      .map((entry) => entry.log.events)[0] ?? [];
  const childLogs = (): (readonly SessionEvent[])[] =>
    sessions
      ?.list()
      .filter((entry) => entry.address.kind === 'subagent')
      .map((entry) => entry.log.events) ?? [];
  await client.runStart('settle-thread', '幫我查');
  return {
    childLogs,
    release,
    built,
    rootLog,
    state: () => state,
    close: async () => {
      release();
      // 先關 handler（下行就此結束），再等抽乾：對一個還在等下一顆的產生器呼叫 `return()` 會排在那個 `next()` 後面而卡死。
      await handler.close();
      await draining.catch(() => undefined);
    },
  };
}

const turnKinds = (events: readonly SessionEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'turn/start' ? [event.data.kind] : []));

describe('背景子代理做完，閒著的主對話被叫醒', () => {
  it('多開一輪：模型讀到結算通知（含子代理最後那句），日誌是 subagent-settled，畫面沒有人的泡泡', async () => {
    const r = await assemble({ stepInbox: true });
    try {
      // root 那一輪先收尾（背景的 gate 還沒放行）。
      await until(() => r.rootLog().filter((event) => event.type === 'turn/end').length === 1);
      expect(turnKinds(r.rootLog())).toEqual(['message']);
      r.release();
      await until(() => turnKinds(r.rootLog()).includes('subagent-settled'));
      await until(() => r.rootLog().filter((event) => event.type === 'turn/end').length === 2);

      const events = r.rootLog();
      expect(turnKinds(events)).toEqual(['message', 'subagent-settled']);
      const start = events.filter((event) => event.type === 'turn/start')[1]!.data as {
        text: string;
        summary: string;
        senderSessionId: string;
      };
      expect(start.summary).toMatch(
        /^Background subagent bg-[0-9a-f]{12} finished and will do no further work unless you send it more\.$/,
      );
      expect(start.text).toBe(`${start.summary}\n\nIts closing message:\n做完，結論是 X`);
      expect(start.senderSessionId).toMatch(/^settle-thread\/bg-[0-9a-f]{12}$/);

      // 沒有人的授權：這一輪背後沒有人。
      expect(hasDirectHumanTurn(events)).toBe(false);

      // 模型手上的訊息：通知是以 human 訊息進去的，字與日誌同一份。
      const checkpoint = await (r.built.agent as unknown as PumpAgent).getState({
        configurable: { thread_id: 'settle-thread' },
      });
      const messages = (checkpoint.values as { messages: { type?: string; text?: string }[] })
        .messages;
      expect(messages.some((message) => message.text === start.text)).toBe(true);

      // 畫面：只有使用者那一句話是人的泡泡，通知不是；模型的回覆有。
      const humans = r.state().entries.filter((entry) => entry.kind === 'human');
      expect(humans.map((entry) => entry.text)).toEqual(['幫我查']);
      expect(
        r
          .state()
          .entries.some((entry) => entry.kind === 'ai' && entry.text.includes('子代理說結論是 X')),
      ).toBe(true);
    } finally {
      await r.close();
    }
  });

  it('沒掛插話載體也一樣：閒著就是開一輪', async () => {
    const r = await assemble({ stepInbox: false });
    try {
      await until(() => r.rootLog().filter((event) => event.type === 'turn/end').length === 1);
      r.release();
      await until(() => r.rootLog().filter((event) => event.type === 'turn/end').length === 2);
      expect(turnKinds(r.rootLog())).toEqual(['message', 'subagent-settled']);
    } finally {
      await r.close();
    }
  });
});

describe('背景子代理半路寫話給主對話（#849）', () => {
  it('閒著的主對話被叫醒多開一輪：turn/start 是 agent-message、前綴照 dsh，不是人話，畫面沒有人的泡泡', async () => {
    const r = await assemble({ stepInbox: true, workerSends: true });
    try {
      await until(() => r.rootLog().filter((event) => event.type === 'turn/end').length === 1);
      r.release();
      await until(() => turnKinds(r.rootLog()).includes('agent-message'));
      await until(() => r.rootLog().filter((event) => event.type === 'turn/end').length >= 2);

      const events = r.rootLog();
      const start = events
        .filter((event) => event.type === 'turn/start')
        .find((event) => event.data.kind === 'agent-message')!.data as {
        text: string;
        senderSessionId: string;
      };
      expect(start.senderSessionId).toMatch(/^settle-thread\/bg-[0-9a-f]{12}$/);
      expect(start.text).toBe(`Agent ${start.senderSessionId} sent a message: 半路發現：入口在 A`);
      expect(hasDirectHumanTurn(events)).toBe(false);

      const humans = r.state().entries.filter((entry) => entry.kind === 'human');
      expect(humans.map((entry) => entry.text)).toEqual(['幫我查']);

      // **被叫醒的那一輪是 root 自己的**：模型的回覆記在 root 的日誌，不是寄件的子代理的。這一輪是在子代理的
      // 工具呼叫裡被排程的，會繼承它的非同步環境——繼承下來的話，日誌路由會把 root 的回覆記到子代理名下
      // （live 實跑抓到的：子代理日誌裡出現了給使用者的話）。
      const said = (events: readonly SessionEvent[]) =>
        events.flatMap((event) =>
          event.type === 'assistant/message' ? [JSON.stringify(event.data.message)] : [],
        );
      expect(said(r.rootLog()).some((text) => text.includes('子代理說結論是 X'))).toBe(true);
      for (const log of r.childLogs()) {
        expect(said(log).some((text) => text.includes('子代理說結論是 X'))).toBe(false);
      }
    } finally {
      await r.close();
    }
  });
});
