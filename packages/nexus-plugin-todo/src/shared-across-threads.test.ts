/**
 * `todo_write` 套一次、服務兩條 thread（[#1463](https://github.com/DemianLi/nexus-agent/issues/1463)，#1418 的 C 類）。
 *
 * 一份服務好幾條 thread：「同一份掛一次、綁兩條 thread、交錯呼叫」的結果，要與「各自一份」相同
 * （`@nexus/sdk` 的 {@link checkSharedAcrossThreads}，SDK 不 import core，轉接在這裡寫）。
 *
 * **這一檔量的是插件本身**：它不保存任何逐條 thread 的狀態，每次呼叫都問會話查找（`apply` 抓進閉包的那一份）。**行程裡
 * 活著哪幾條 thread 的挑法**不在這裡——那是宿主的、與相容層共用的 `pickSessionForCall`，在 `apps/harness/src/todo-on-tree.test.ts`
 * 量。
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import { pickSessionForCall, SessionRegistry } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { checkSharedAcrossThreads } from '@nexus/sdk';
import type { ThreadStep } from '@nexus/sdk';
import { createSessionLookupProvider } from '@nexus/session/provider';
import { createToolsProvider } from '@nexus/tools/provider';
import { afterEach, describe, expect, it } from 'vitest';

import * as todo from './index.js';

interface Mounted {
  readonly tool: StructuredToolInterface;
  readonly sessions: ReadonlyMap<string, SessionRegistry>;
}

const opened: Context[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
});

/** 掛一次：每條 thread 一張註冊表（root 日誌 id 就是 thread id），共用同一份查找與同一顆工具。 */
async function mountFor(threads: readonly string[], allowParallel = true): Promise<Mounted> {
  const sessions = new Map(threads.map((thread) => [thread, new SessionRegistry(thread)]));
  const tools = createToolsProvider();
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    tools: tools.Provider,
    'session-lookup': createSessionLookupProvider((config) =>
      pickSessionForCall(sessions.values(), config),
    ).Provider,
    todo,
  });
  const create = (options: { id: string; name: string; config?: unknown }) =>
    root.loader.create(options as never, null);
  await create({ id: 'tools', name: 'cordis:tools' });
  await create({ id: 'session-lookup', name: 'cordis:session-lookup' });
  await create({
    id: 'todo',
    name: 'cordis:todo',
    config: { allowParallelInProgress: allowParallel },
  });
  await root.loader.await();
  const entry = tools.entries().find((item) => item.tool.name === todo.TODO_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒有註冊上去');
  return { tool: entry.tool, sessions };
}

/** 以某條 thread 的身分寫一次：回模型看到的字，與那條 thread 的日誌上現在有的 `todo/write`。 */
async function writeAs(mounted: Mounted, thread: string, content: string): Promise<unknown> {
  const answer = await mounted.tool.invoke({ todos: [{ content, status: 'pending' }] }, {
    configurable: { thread_id: thread, checkpoint_ns: 'tools:call' },
  } as never);
  const log = mounted.sessions.get(thread)?.root;
  return {
    answer: String((answer as { content?: unknown }).content ?? answer),
    written: (log?.events ?? []).map((event) => event.data),
  };
}

describe('todo_write 套一次、服務兩條 thread', () => {
  const STEPS: ThreadStep<string>[] = [
    { thread: 'thread-a', input: '甲1' },
    { thread: 'thread-b', input: '乙1' },
    { thread: 'thread-a', input: '甲2' },
    { thread: 'thread-b', input: '乙2' },
  ];

  it('共用一份與各自一份相同：每條 thread 的日誌只有自己寫的', async () => {
    const failures = await checkSharedAcrossThreads({
      name: 'todo',
      steps: STEPS,
      mount: (threads) => mountFor(threads),
      call: (mounted, thread, input) => writeAs(mounted, thread, input),
    });
    expect(failures).toEqual([]);
  });

  it('禁止並行的設定下結果一樣（政策是掛載時定的，不是逐條 thread 的狀態）', async () => {
    const failures = await checkSharedAcrossThreads({
      name: 'todo',
      steps: STEPS,
      mount: (threads) => mountFor(threads, false),
      call: (mounted, thread, input) => writeAs(mounted, thread, input),
    });
    expect(failures).toEqual([]);
  });

  it('交錯呼叫之後兩條 thread 的日誌各只有自己的清單', async () => {
    const mounted = await mountFor(['thread-a', 'thread-b']);
    for (const step of STEPS) await writeAs(mounted, step.thread, step.input);
    const written = (thread: string) =>
      mounted.sessions.get(thread)?.root.events.map((event) => event.data);
    expect(written('thread-a')).toEqual([
      { todos: [{ content: '甲1', status: 'pending' }] },
      { todos: [{ content: '甲2', status: 'pending' }] },
    ]);
    expect(written('thread-b')).toEqual([
      { todos: [{ content: '乙1', status: 'pending' }] },
      { todos: [{ content: '乙2', status: 'pending' }] },
    ]);
  });
});
