/**
 * `agent-instructions` 套一次、服務兩條 thread（[#1418](https://github.com/DemianLi/nexus-agent/issues/1418) 的 B 類試點）。
 *
 * 樹上這一列的 `apply` 一個行程只跑一次，登記的 listener 服務所有 thread、root 與每個子代理。兩條 thread 各有自己的工作區
 * （各放一份只有自己才有的 `AGENTS.md`）：listener 若把「這個 agent 已經有基線了」記在閉包裡、或固定讀同一個 backend，兩條 thread
 * 就會串台。這一檔把「同一份掛一次、綁兩條 thread、交錯進來」的結果拿來跟「各自一份」比（`@nexus/sdk` 的 {@link checkSharedAcrossThreads}，
 * 轉接在這裡寫）。
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createAgentLoopProvider } from '@nexus/agent-loop/provider';
import type { PreStepListener } from '@nexus/agent-loop';
import { pickBoundForCall, SessionRegistry } from '@nexus/core';
import type { FsService } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { createFsLookupProvider } from '@nexus/fs/provider';
import { checkSharedAcrossThreads } from '@nexus/sdk';
import type { ThreadStep } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import * as module from './index.js';
import { AGENT_INSTRUCTIONS_MARKER } from './index.js';

const opened: Context[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
});

interface Mounted {
  readonly listener: PreStepListener;
  /** 每條 thread 目前「模型看得到的那一串」：注入進來的訊息會被追加上去，同圖裡的樣子。 */
  readonly visible: Map<string, BaseMessage[]>;
}

/** 掛一次：樹上這一列只掛一列，綁 `threads` 各一份**自己的**工作區（只有自己才有的 `AGENTS.md`）與 fs 把手。 */
async function mount(threads: readonly string[]): Promise<Mounted> {
  const live: { sessions: SessionRegistry; fs: FsService }[] = [];
  const visible = new Map<string, BaseMessage[]>();
  for (const thread of threads) {
    const files: Record<string, string> = { '/AGENTS.md': `規矩：${thread}。` };
    const backend = {
      read: (path: string) =>
        Object.prototype.hasOwnProperty.call(files, path)
          ? Promise.resolve({ content: files[path] })
          : Promise.resolve({ error: 'file_not_found' }),
    };
    live.push({
      sessions: new SessionRegistry(thread),
      fs: {
        backend: () => backend as never,
        offWorkspacePrefixes: () => [],
        hasWorkspace: () => true,
        workspaceRoot: () => undefined,
      },
    });
    visible.set(thread, []);
  }
  const loop = createAgentLoopProvider();
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    'pre-step': loop.Provider,
    fs: createFsLookupProvider((config) => {
      const picked = pickBoundForCall(live, (entry) => entry.sessions, config);
      return picked.kind === 'ok'
        ? { kind: 'ok', fs: picked.bound.fs, address: picked.address }
        : picked;
    }).Provider,
    'agent-instructions': module,
  });
  const create = (options: { id: string; name: string; config?: unknown }) =>
    root.loader.create(options as never, null);
  await create({ id: 'pre-step', name: 'cordis:pre-step' });
  await create({ id: 'fs', name: 'cordis:fs' });
  await create({ id: 'agent-instructions', name: 'cordis:agent-instructions', config: {} });
  await root.loader.await();
  const entry = loop.preSteps()[0];
  if (entry === undefined) throw new Error('listener 沒登記上');
  return { listener: entry.listener, visible };
}

/** root 與同步子代理的 `beforeAgent`：`checkpoint_ns` 的最後一段是節點自己，前面的段是誰在跑（同圖裡的樣子）。 */
const ROOT_NS = 'AgentInstructionsMiddleware.before_agent:1';
const SUBAGENT_NS = `tools:spawn-1|${ROOT_NS}`;

interface Step {
  readonly checkpointNs: string;
}

/** 這條 thread 的一次 `beforeAgent`：`thread_id` 與 `checkpoint_ns` 都帶，同圖裡的樣子；回這一次注入了什麼。 */
async function act(mounted: Mounted, thread: string, step: Step): Promise<unknown> {
  const seen = mounted.visible.get(thread);
  if (seen === undefined) throw new Error(`沒有這條 thread：${thread}`);
  const injections = await mounted.listener(seen, {
    configurable: { thread_id: thread, checkpoint_ns: step.checkpointNs },
  });
  for (const injection of injections ?? []) {
    seen.push(
      new HumanMessage({
        content: injection.content,
        additional_kwargs: { ...injection.additionalKwargs },
      }),
    );
  }
  return {
    injected: (injections ?? []).map((injection) =>
      injection.content.includes(`規矩：${thread}。`),
    ),
    marked: (injections ?? []).map(
      (injection) => injection.additionalKwargs?.[AGENT_INSTRUCTIONS_MARKER] === true,
    ),
    visibleBaselines: seen.filter((m) => m.additional_kwargs[AGENT_INSTRUCTIONS_MARKER] === true)
      .length,
  };
}

describe('agent-instructions 套一次、服務兩條 thread', () => {
  it('兩條 thread 交錯進來：各自補一份、補的是自己工作區的，與各自一份時相同', async () => {
    const steps: ThreadStep<Step>[] = [
      { thread: 'a', input: { checkpointNs: ROOT_NS } },
      { thread: 'b', input: { checkpointNs: ROOT_NS } },
      // 第二次 invoke：各自已經有了，不再補。
      { thread: 'a', input: { checkpointNs: ROOT_NS } },
      { thread: 'b', input: { checkpointNs: ROOT_NS } },
    ];
    const failures = await checkSharedAcrossThreads({
      name: 'agent-instructions',
      steps,
      mount,
      call: (mounted, thread, input) => act(mounted, thread, input),
    });
    expect(failures).toEqual([]);
  });

  it('具體結果：各條 thread 只補自己的那一份，第二次不再補', async () => {
    const mounted = await mount(['a', 'b']);
    const first = await act(mounted, 'a', { checkpointNs: ROOT_NS });
    const other = await act(mounted, 'b', { checkpointNs: ROOT_NS });
    const again = await act(mounted, 'a', { checkpointNs: ROOT_NS });
    expect(first).toEqual({ injected: [true], marked: [true], visibleBaselines: 1 });
    expect(other).toEqual({ injected: [true], marked: [true], visibleBaselines: 1 });
    expect(again).toEqual({ injected: [], marked: [], visibleBaselines: 1 });
  });

  it('同一條 thread 的子代理（另一段 checkpoint_ns）自己的那一串是空的，所以自己補一份', async () => {
    const mounted = await mount(['a', 'b']);
    await act(mounted, 'a', { checkpointNs: ROOT_NS });
    mounted.visible.set('a', []);
    const sub = await act(mounted, 'a', { checkpointNs: SUBAGENT_NS });
    expect(sub).toEqual({ injected: [true], marked: [true], visibleBaselines: 1 });
  });
});
