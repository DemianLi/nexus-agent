/**
 * `ask_user_question` 套一次、服務兩條 thread（[#1418](https://github.com/DemianLi/nexus-agent/issues/1418) 的 C 類試點）。
 *
 * 一份 registry 服務好幾條 thread：「同一份掛一次、綁兩條 thread、交錯呼叫」的結果，要與「各自一份」相同
 * （`@nexus/sdk` 的 {@link checkSharedAcrossThreads}，SDK 不 import core，轉接在這裡寫）。
 *
 * **#1458 之後答題者是行程級的**：宿主在建樹時交給樹一份預設答題管道（`approval-channel` 那一列），ask-user 在 `apply`
 * 當下抓住它，**不再逐條 thread 查**（`channelForThread` 退成定義套件裡的 token 與型別，今天沒有提供者）。所以這一檔的
 * 「兩條 thread」共用同一個答題者；「一條有人在、一條沒人在」是兩個進程級組裝（serve 與 headless CLI）的事，
 * 各自一棵樹，那一格的測試在 `apps/harness/src/ask-user-on-tree.test.ts`。
 *
 * **轉接用真的圖**：`interrupt()` 只在圖裡有意義，所以每次呼叫都是一張只有一個節點的 `StateGraph`，帶存檔點、以 thread 為鍵，
 * 同 serve 那條路的形狀。結果只留兩種：「問了」（圖停在中斷上，帶題目 id）與「沒問」（回給模型的那一句）。
 */

import { MemorySaver, Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ApprovalChannel } from '@nexus/approval-channel';
import { createApprovalChannelProvider } from '@nexus/approval-channel/provider';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { checkSharedAcrossThreads } from '@nexus/sdk';
import type { ThreadStep } from '@nexus/sdk';
import { createToolsProvider } from '@nexus/tools/provider';
import { afterEach, describe, expect, it } from 'vitest';

import * as askUser from './index.js';
import { NO_CHANNEL_MESSAGE, noAnswererMessage } from './index.js';

interface Mounted {
  readonly tool: StructuredToolInterface;
}

const opened: Context[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
});

/**
 * 掛一次：行程級的答題管道給定一個值（宿主在建樹時決定），這一份工具服務 `threads` 裡的每一條。
 * `threads` 只用來讓呼叫端寫得出「這一份服務幾條」——工具不需要事先知道有哪些 thread，身分從每次呼叫的設定來。
 */
async function mountWith(channel: ApprovalChannel | undefined): Promise<Mounted> {
  const tools = createToolsProvider();
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    tools: tools.Provider,
    'approval-channel': createApprovalChannelProvider(channel).Provider,
    'ask-user': askUser,
  });
  const create = (options: { id: string; name: string; config?: unknown }) =>
    root.loader.create(options as never, null);
  await create({ id: 'tools', name: 'cordis:tools' });
  await create({ id: 'approval-channel', name: 'cordis:approval-channel' });
  await create({ id: 'ask-user', name: 'cordis:ask-user', config: {} });
  await root.loader.await();
  const entry = tools
    .entries()
    .find((item) => item.tool.name === askUser.ASK_USER_QUESTION_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒有註冊上去');
  return { tool: entry.tool };
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
  const STEPS: ThreadStep<string>[] = [
    { thread: 'thread-a', input: 'q1' },
    { thread: 'thread-b', input: 'q2' },
    { thread: 'thread-a', input: 'q3' },
    { thread: 'thread-b', input: 'q4' },
  ];

  it('有人在：共用一份與各自一份相同，每條 thread 都停在自己的中斷上', async () => {
    const failures = await checkSharedAcrossThreads({
      name: 'ask-user',
      steps: STEPS,
      mount: () => mountWith({ kind: 'human' }),
      call: (mounted, thread, input) => askAs(mounted, thread, input),
    });
    expect(failures).toEqual([]);
  });

  it('沒人在（policy-never）：共用一份與各自一份相同，每條 thread 都在呼叫當下被拒', async () => {
    const failures = await checkSharedAcrossThreads({
      name: 'ask-user',
      steps: STEPS,
      mount: () => mountWith({ kind: 'policy-never' }),
      call: (mounted, thread, input) => askAs(mounted, thread, input),
    });
    expect(failures).toEqual([]);
  });

  it('三種答題者各自成一棵樹：有人就問、沒人就在呼叫當下拒絕（#669）', async () => {
    const human = await mountWith({ kind: 'human' });
    const never = await mountWith({ kind: 'policy-never' });
    const none = await mountWith({ kind: 'no-channel' });
    expect(await askAs(human, 'thread-a', 'a')).toEqual({ asked: ['a'] });
    expect(await askAs(never, 'thread-a', 'b')).toEqual({
      refused: `Error: ${noAnswererMessage({ kind: 'policy-never' })}`,
    });
    expect(await askAs(none, 'thread-a', 'c')).toEqual({
      refused: `Error: ${noAnswererMessage({ kind: 'no-channel' })}`,
    });
    // 再回到有人的那一棵：沒有被別棵的拒絕帶偏——答題者是各棵樹自己的，不是模組層級的狀態。
    expect(await askAs(human, 'thread-b', 'd')).toEqual({ asked: ['d'] });
  });

  it('宿主沒有給答題管道：呼叫當下 NO_CHANNEL，載入照常（fail-closed，#669）', async () => {
    const mounted = await mountWith(undefined);
    expect(await askAs(mounted, 'stranger', 'x')).toEqual({
      refused: `Error: ${NO_CHANNEL_MESSAGE}`,
    });
  });
});
