/**
 * `present` 套一次、服務兩條 thread（[#1418](https://github.com/DemianLi/nexus-agent/issues/1418) 的 B 類試點）。
 *
 * `present` 在 `apply` 的閉包裡有一張「等 `tools/result` 的交付」表（#1469 上樹之後 `apply` 一個行程只跑一次）。
 * 兩條 thread 撞上同一個 `callId`（模型給的 `tool_call.id`，各 thread 各自編號）時，那張表是兩條 thread 共用的，
 * 鍵裡沒有 thread 就會覆蓋：這一檔把「同一份掛一次、綁兩條 thread、同一個 `callId`
 * 交錯進來」的結果拿來跟「各自一份」比（`@nexus/sdk` 的 {@link checkSharedAcrossThreads}，轉接在這裡寫）。
 *
 * 呼叫序列刻意讓兩條 thread 的呼叫**同時懸著**：`a` 叫了還沒落定、`b` 叫了還沒落定、然後 `a` 落定、`b` 落定。
 * 不懸著的話（叫一次、落定一次、再換另一條）表上同一時間只有一筆，串台量不到。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  callThreadId,
  pickBoundForCall,
  pickSessionForCall,
  SessionRegistry,
  toolCallSessionAddress,
} from '@nexus/core';
import type { FsService } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { createFsLookupProvider } from '@nexus/fs/provider';
import { checkSharedAcrossThreads } from '@nexus/sdk';
import type { ThreadStep } from '@nexus/sdk';
import { createSessionLookupProvider } from '@nexus/session/provider';
import { createToolsProvider } from '@nexus/tools/provider';
import { FilesystemBackend } from 'deepagents';
import { afterEach, describe, expect, it } from 'vitest';

import * as present from './index.js';
import { PRESENT_TOOL_NAME } from './index.js';

const roots: string[] = [];
const opened: Context[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Mounted {
  readonly tool: StructuredToolInterface;
  readonly listeners: readonly present.PresentDelivery['onResult'][];
  readonly sessions: Map<string, SessionRegistry>;
}

/**
 * 掛一次：樹上 `present` 只掛一列，綁 `threads` 各一張會話註冊表、各一份**自己的**工作區（各放一個只有自己才有的檔）與 fs 把手。
 * 兩個查找用同一支挑法（`pickBoundForCall`），與宿主行程級查找是同一份實作。
 */
async function mount(threads: readonly string[]): Promise<Mounted> {
  const live: { sessions: SessionRegistry; fs: FsService }[] = [];
  const sessions = new Map<string, SessionRegistry>();
  for (const thread of threads) {
    const root = await mkdtemp(join(tmpdir(), 'nexus-present-shared-'));
    roots.push(root);
    await writeFile(join(root, `${thread}.txt`), thread);
    const backend = new FilesystemBackend({ rootDir: root, virtualMode: true });
    const bound = new SessionRegistry(thread);
    sessions.set(thread, bound);
    live.push({
      sessions: bound,
      fs: {
        backend: () => backend,
        offWorkspacePrefixes: () => [],
        hasWorkspace: () => true,
      },
    });
  }
  const tools = createToolsProvider();
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    tools: tools.Provider,
    'session-lookup': createSessionLookupProvider((config) =>
      pickSessionForCall(
        live.map((entry) => entry.sessions),
        config,
      ),
    ).Provider,
    fs: createFsLookupProvider((config) => {
      const picked = pickBoundForCall(live, (entry) => entry.sessions, config);
      return picked.kind === 'ok'
        ? { kind: 'ok', fs: picked.bound.fs, address: picked.address }
        : picked;
    }).Provider,
    present,
  });
  const create = (options: { id: string; name: string; config?: unknown }) =>
    root.loader.create(options as never, null);
  await create({ id: 'tools', name: 'cordis:tools' });
  await create({ id: 'session-lookup', name: 'cordis:session-lookup' });
  await create({ id: 'fs', name: 'cordis:fs' });
  await create({ id: 'present', name: 'cordis:present', config: {} });
  await root.loader.await();
  const entry = tools.entries().find((item) => item.tool.name === PRESENT_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒註冊上');
  return {
    tool: entry.tool,
    listeners: tools.resultListeners().map((item) => item.listener),
    sessions,
  };
}

type Step = { kind: 'call'; callId: string; path: string } | { kind: 'settle'; callId: string };

/** 這條 thread 的呼叫設定：`thread_id` 與 `checkpoint_ns`（root 的一次工具呼叫）都帶，同圖裡的樣子。 */
const configOf = (thread: string, callId: string) => ({
  configurable: { thread_id: thread, checkpoint_ns: `tools:${callId}` },
  toolCall: { id: callId },
});

async function act(mounted: Mounted, thread: string, step: Step): Promise<unknown> {
  const config = configOf(thread, step.callId);
  const log = mounted.sessions.get(thread)?.root;
  if (log === undefined) throw new Error(`沒有這條 thread：${thread}`);
  if (step.kind === 'call') {
    log.append('tool/call', {
      callId: step.callId,
      name: PRESENT_TOOL_NAME,
      arguments: JSON.stringify({ files: [{ path: step.path }] }),
    });
    const result = await mounted.tool.invoke({ files: [{ path: step.path }] }, config as never);
    return { text: (result as { content?: unknown }).content };
  }
  // 照圍堵落定的順序：先派發 `tools/result`，再同步記 `tool/result`。
  for (const listener of mounted.listeners) {
    await listener(
      {
        callId: step.callId,
        name: PRESENT_TOOL_NAME,
        args: {},
        agent: toolCallSessionAddress(config),
        thread: callThreadId(config),
      },
      { isError: false },
    );
  }
  log.append('tool/result', { callId: step.callId, isError: false });
  // 這條 thread 自己那一份日誌上交付了誰：串台的話，交付會落到別條 thread 的日誌裡，這裡就缺。
  return {
    delivered: log.events
      .filter((event) => event.type === 'deliverables/presented')
      .map((event) => (event.data as { callId: string; files: { path: string }[] }).callId),
  };
}

describe('present 套一次、服務兩條 thread', () => {
  it('兩條 thread 同一個 callId 同時懸著：各自落定、各進自己的日誌，與各自一份時相同', async () => {
    const steps: ThreadStep<Step>[] = [
      { thread: 'a', input: { kind: 'call', callId: 'c1', path: 'a.txt' } },
      { thread: 'b', input: { kind: 'call', callId: 'c1', path: 'b.txt' } },
      { thread: 'a', input: { kind: 'settle', callId: 'c1' } },
      { thread: 'b', input: { kind: 'settle', callId: 'c1' } },
    ];
    const failures = await checkSharedAcrossThreads({
      name: 'present',
      steps,
      mount,
      call: (mounted, thread, input) => act(mounted, thread, input),
    });
    expect(failures).toEqual([]);
  });

  it('具體結果：各條日誌只有自己的那一筆，檔案是自己要交付的那一個', async () => {
    const mounted = await mount(['a', 'b']);
    await act(mounted, 'a', { kind: 'call', callId: 'c1', path: 'a.txt' });
    await act(mounted, 'b', { kind: 'call', callId: 'c1', path: 'b.txt' });
    await act(mounted, 'a', { kind: 'settle', callId: 'c1' });
    await act(mounted, 'b', { kind: 'settle', callId: 'c1' });
    const presented = (thread: string) =>
      mounted.sessions
        .get(thread)!
        .root.events.filter((event) => event.type === 'deliverables/presented')
        .map((event) =>
          (event.data as unknown as { files: { path: string }[] }).files.map((f) => f.path),
        );
    expect(presented('a')).toEqual([['a.txt']]);
    expect(presented('b')).toEqual([['b.txt']]);
  });
});
