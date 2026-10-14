/**
 * `ask_user_question` 套一次、服務兩條 thread（[#1418](https://github.com/DemianLi/nexus-agent/issues/1418) 的 C 類試點）。
 *
 * 今天每條 thread 各組裝一次，答題者（`channel`）在那一次算出來、`apply` 當下抓住。插件只套一次之後，一份 registry
 * 服務好幾條 thread，各自的答題者不同：一條有人在、一條是 `policy-never`。這一檔把「同一份掛一次、綁兩條 thread、交錯呼叫」
 * 的結果拿來跟「各自一份」比（`@nexus/sdk` 的 {@link checkSharedAcrossThreads}，SDK 不 import core，轉接在這裡寫）。
 *
 * **轉接用真的圖**：`interrupt()` 只在圖裡有意義，所以每次呼叫都是一張只有一個節點的 `StateGraph`，帶存檔點、以 thread 為鍵，
 * 同 serve 那條路的形狀。結果只留兩種：「問了」（圖停在中斷上，帶題目 id）與「沒問」（回給模型的那一句）。
 */

import { MemorySaver, Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { StructuredTool } from '@langchain/core/tools';
import {
  CHANNEL_FOR_THREAD_SERVICE,
  CHANNEL_SERVICE,
  createHostServicesPlugin,
  loadPlugins,
  SessionRegistry,
} from '@nexus/core';
import type { ApprovalChannel } from '@nexus/core';
import { checkSharedAcrossThreads } from '@nexus/sdk';
import type { ThreadStep } from '@nexus/sdk';
import { describe, expect, it } from 'vitest';

import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserPlugin,
  NO_CHANNEL_MESSAGE,
  noAnswererMessage,
} from './index.js';

/** 每條 thread 各自的答題者：人在的、沒人在的、沒有存檔點的。 */
const CHANNELS: Readonly<Record<string, ApprovalChannel>> = {
  'with-human': { kind: 'human' },
  'no-human': { kind: 'policy-never' },
  'no-checkpointer': { kind: 'no-channel' },
};

const channelOf = (thread: string | undefined): ApprovalChannel | undefined =>
  thread === undefined ? undefined : CHANNELS[thread];

interface Mounted {
  readonly tool: StructuredTool;
}

/**
 * 掛一次。**組裝點提供的東西與產品路徑同形**：`channel`（今天的值）與 `channelForThread`（逐條 thread）。
 * 基準那一份（只綁一條 thread）的 `channel` 就是那條 thread 的答題者，等於今天「一條 thread 一次組裝」；
 * 共用那一份的 `channel` 沒有「那一條」可指，給預設的 `human`——沒改的插件在 `apply` 當下抓住的就是它。
 */
async function mount(threads: readonly string[]): Promise<Mounted> {
  const only = threads.length === 1 ? channelOf(threads[0]) : undefined;
  const { registry } = await loadPlugins([
    createHostServicesPlugin({
      channel: only ?? { kind: 'human' },
      channelForThread: channelOf,
    }),
    createAskUserPlugin(),
  ]);
  for (const thread of threads) registry.sessions.bind(new SessionRegistry(thread));
  const entry = registry.tools.resolve(ASK_USER_QUESTION_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒有註冊上去');
  return { tool: entry.value };
}

const State = Annotation.Root({ text: Annotation<string>() });

/** 以某條 thread 的身分問一次：圖停在中斷上就是「問了」，否則是回給模型的字。 */
async function askAs(mounted: Mounted, thread: string, questionId: string): Promise<unknown> {
  const graph = new StateGraph(State)
    .addNode('ask', async (_state, config) => {
      const result = await mounted.tool.invoke(
        {
          questions: [{ id: questionId, question: '要哪個？', options: [{ label: 'A' }] }],
        },
        { ...config, toolCall: { id: `call-${questionId}` } } as never,
      );
      return { text: String((result as { content?: unknown }).content ?? result) };
    })
    .addEdge(START, 'ask')
    .addEdge('ask', END)
    .compile({ checkpointer: new MemorySaver() });
  const out = (await graph.invoke(
    { text: '' },
    // thread_id 就是這條 thread：身分從呼叫設定來。每次一個新的存檔點，同一條 thread 才不會接上上一題的中斷。
    { configurable: { thread_id: thread } },
  )) as { text: string; __interrupt__?: { value: { questions: { id: string }[] } }[] };
  const interrupt = out.__interrupt__?.[0]?.value;
  if (interrupt !== undefined) return { asked: interrupt.questions.map((q) => q.id) };
  return { refused: out.text };
}

describe('ask_user_question 套一次、服務兩條 thread', () => {
  it('一條有人在、一條沒人在：各自得到對的結果，與各自一份時相同', async () => {
    const steps: ThreadStep<string>[] = [
      { thread: 'with-human', input: 'q1' },
      { thread: 'no-human', input: 'q2' },
      { thread: 'with-human', input: 'q3' },
      { thread: 'no-human', input: 'q4' },
    ];
    const failures = await checkSharedAcrossThreads({
      name: 'ask-user',
      steps,
      mount,
      call: (mounted, thread, input) => askAs(mounted, thread, input),
    });
    expect(failures).toEqual([]);
  });

  it('三種答題者交錯：有人就問、沒人就在呼叫當下拒絕（#669）', async () => {
    const mounted = await mount(['with-human', 'no-human', 'no-checkpointer']);
    expect(await askAs(mounted, 'with-human', 'a')).toEqual({ asked: ['a'] });
    expect(await askAs(mounted, 'no-human', 'b')).toEqual({
      refused: `Error: ${noAnswererMessage({ kind: 'policy-never' })}`,
    });
    expect(await askAs(mounted, 'no-checkpointer', 'c')).toEqual({
      refused: `Error: ${noAnswererMessage({ kind: 'no-channel' })}`,
    });
    // 再回到有人的那一條：沒有被前面兩條的拒絕帶偏。
    expect(await askAs(mounted, 'with-human', 'd')).toEqual({ asked: ['d'] });
  });

  it('組裝點不認得這條 thread：退回 channel；channel 也沒有就是 NO_CHANNEL（fail-closed，#669）', async () => {
    const { registry } = await loadPlugins([
      createHostServicesPlugin({ channelForThread: () => undefined }),
      createAskUserPlugin(),
    ]);
    registry.sessions.bind(new SessionRegistry('stranger'));
    const entry = registry.tools.resolve(ASK_USER_QUESTION_TOOL_NAME);
    const mounted: Mounted = { tool: entry!.value };
    expect(await askAs(mounted, 'stranger', 'x')).toEqual({
      refused: `Error: ${NO_CHANNEL_MESSAGE}`,
    });
  });

  it('只提供 channel（今天的產品路徑）：行為不變', async () => {
    const { registry } = await loadPlugins([
      createHostServicesPlugin({ channel: { kind: 'policy-never' } }),
      createAskUserPlugin(),
    ]);
    registry.sessions.bind(new SessionRegistry('solo'));
    const mounted: Mounted = { tool: registry.tools.resolve(ASK_USER_QUESTION_TOOL_NAME)!.value };
    expect(await askAs(mounted, 'solo', 'x')).toEqual({
      refused: `Error: ${noAnswererMessage({ kind: 'policy-never' })}`,
    });
    expect(CHANNEL_SERVICE).toBe('channel');
    expect(CHANNEL_FOR_THREAD_SERVICE).toBe('channelForThread');
  });
});
