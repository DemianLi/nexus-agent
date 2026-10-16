/**
 * `submit_record` 套一次、服務兩條 thread（[#1466](https://github.com/DemianLi/nexus-agent/issues/1466)，#1418 的 C 類）。
 *
 * 一份服務好幾條 thread：「同一份掛一次、綁兩條 thread、交錯呼叫」的結果，要與「各自一份」相同
 * （`@nexus/sdk` 的 {@link checkSharedAcrossThreads}，SDK 不 import core，轉接在這裡寫）。
 *
 * **這一檔量的是插件本身**：它不保存任何逐條 thread 的狀態，每次呼叫都問 fs 查找（`apply` 抓進閉包的那一份）、被問到的把手的
 * `backend()` 也在那一次才讀。**行程裡活著哪幾條 thread 的挑法**不在這裡——那是宿主的、與相容層共用的 `pickBoundForCall`，在
 * `apps/harness/src/submit-record-on-tree.test.ts` 量。這裡的查找只依 `thread_id` 查表，不重寫那一份挑法。
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { FsLookup, FsService } from '@nexus/fs';
import { createFsLookupProvider } from '@nexus/fs/provider';
import { checkSharedAcrossThreads } from '@nexus/sdk';
import type { ThreadStep } from '@nexus/sdk';
import { createToolsProvider } from '@nexus/tools/provider';
import type { AnyBackendProtocol } from 'deepagents';
import { afterEach, describe, expect, it } from 'vitest';

import * as submitRecord from './index.js';

interface Mounted {
  readonly tool: StructuredToolInterface;
  readonly files: ReadonlyMap<string, Map<string, string>>;
}

const opened: Context[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
});

/** 每條 thread 各一個假 backend（寫進自己的 Map）。 */
function fakeBackendOver(files: Map<string, string>): AnyBackendProtocol {
  return {
    readRaw: (filePath: string) => {
      const content = files.get(filePath);
      return content === undefined
        ? { error: 'nope' }
        : { data: { content, mimeType: 'text/csv', created_at: '', modified_at: '' } };
    },
    write: (filePath: string, content: string) => {
      files.set(filePath, content);
      return { path: filePath, filesUpdate: null };
    },
  } as unknown as AnyBackendProtocol;
}

/** 掛一次：每條 thread 一個 fs 把手，共用同一份查找與同一顆工具。 */
async function mountFor(threads: readonly string[]): Promise<Mounted> {
  const files = new Map(threads.map((thread) => [thread, new Map<string, string>()]));
  const handles = new Map<string, FsService>(
    threads.map((thread) => {
      const backend = fakeBackendOver(files.get(thread) as Map<string, string>);
      return [thread, { backend: () => backend, offWorkspacePrefixes: () => [] }];
    }),
  );
  const lookup = (config: unknown): FsLookup => {
    const thread = (config as { configurable?: { thread_id?: string } } | undefined)?.configurable
      ?.thread_id;
    const fs = thread === undefined ? undefined : handles.get(thread);
    return fs === undefined
      ? { kind: 'ambiguous', count: handles.size }
      : { kind: 'ok', fs, address: { kind: 'root' } as never };
  };
  const tools = createToolsProvider();
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    tools: tools.Provider,
    fs: createFsLookupProvider(lookup).Provider,
    'submit-record': submitRecord,
  });
  const create = (options: { id: string; name: string; config?: unknown }) =>
    root.loader.create(options as never, null);
  await create({ id: 'tools', name: 'cordis:tools' });
  await create({ id: 'fs', name: 'cordis:fs' });
  await create({ id: 'submit-record', name: 'cordis:submit-record', config: {} });
  await root.loader.await();
  const entry = tools
    .entries()
    .find((item) => item.tool.name === submitRecord.SUBMIT_RECORD_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒有註冊上去');
  return { tool: entry.tool, files };
}

/** 以某條 thread 的身分送一列：回模型看到的字，與那條 thread 的檔案現在的全文。 */
async function submitAs(mounted: Mounted, thread: string, name: string): Promise<unknown> {
  const answer = await mounted.tool.invoke({ file_path: '/v.csv', record: { 姓名: name } }, {
    configurable: { thread_id: thread, checkpoint_ns: 'tools:call' },
  } as never);
  return {
    answer: String((answer as { content?: unknown }).content ?? answer),
    written: mounted.files.get(thread)?.get('/v.csv'),
  };
}

describe('submit_record 套一次、服務兩條 thread', () => {
  const STEPS: ThreadStep<string>[] = [
    { thread: 'thread-a', input: '甲1' },
    { thread: 'thread-b', input: '乙1' },
    { thread: 'thread-a', input: '甲2' },
    { thread: 'thread-b', input: '乙2' },
  ];

  it('共用一份與各自一份相同：每條 thread 的檔案只有自己寫的', async () => {
    const failures = await checkSharedAcrossThreads({
      name: 'submit-record',
      steps: STEPS,
      mount: (threads) => mountFor(threads),
      call: (mounted, thread, input) => submitAs(mounted, thread, input),
    });
    expect(failures).toEqual([]);
  });

  it('交錯呼叫之後兩條 thread 的檔案各只有自己的列', async () => {
    const mounted = await mountFor(['thread-a', 'thread-b']);
    for (const step of STEPS) await submitAs(mounted, step.thread, step.input);
    expect(mounted.files.get('thread-a')?.get('/v.csv')).toBe('姓名\n甲1\n甲2\n');
    expect(mounted.files.get('thread-b')?.get('/v.csv')).toBe('姓名\n乙1\n乙2\n');
  });
});
