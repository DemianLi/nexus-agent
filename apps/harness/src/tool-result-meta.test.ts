/**
 * **工具結果的結構化 `meta`**——[#617](https://github.com/DemianLi/nexus-agent/issues/617) 的驗收 1、2、4，
 * 量的是真的組裝、真的基座工具跑完之後，會話日誌那顆 `tool/result` 記下什麼、模型拿到什麼。
 *
 * 兩條 backend 都走：`--workspace` 的 `ContainedFilesystemBackend`（落磁碟，`edit` 不回 `filesUpdate`），
 * 與沒給時的 `StateBackend`（`edit` 的改後全文要從同一步的 state 讀回來）。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** 一顆 `tool/result` 裡這組測試看的那幾格。 */
interface Logged {
  readonly isError: boolean;
  /** `'meta' in data`：分得出「沒有這一格」與「這一格是 undefined」。 */
  readonly hasMeta: boolean;
  readonly meta: unknown;
}

/** `n` 行的檔，第 i 行（1 起算）是 `line i`，結尾有換行。 */
function numbered(n: number): string {
  return `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
}

/** 工具訊息的文字：基座回的可能是字串，也可能是文字塊陣列。 */
function textOf(message: ToolMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((block) => ((block as { text?: unknown }).text as string | undefined) ?? '')
    .join('');
}

/** 擋掉一條跟這組測試無關的路徑：只為了讓組裝裡有一條 `permissions` 規則。 */
const guard: PluginEntry = {
  plugin: {
    name: 'guard',
    apply: (registry) => void registry.permissions.deny(['/secret/**']),
  },
};

/** 註冊一個**自帶 `permissions`** 的 subagent，root 一條規則都沒有。 */
const crew: PluginEntry = {
  plugin: {
    name: 'crew',
    apply: (registry) =>
      void registry.subagents.register({
        name: 'writer',
        description: '負責寫檔的 subagent。',
        permissions: [{ operations: ['write'], paths: ['/secret/**'], mode: 'deny' }],
      }),
  },
};

describe('工具結果帶結構化 meta', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-tool-result-meta-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * 依序跑幾顆呼叫，回模型拿到的工具訊息與 root 日誌上每顆 `tool/result`。
   *
   * @param workspace - 給就走 `ContainedFilesystemBackend`，不給走基座預設的 `StateBackend`。
   */
  async function run(
    calls: readonly Call[],
    { workspace = true, plugins = [] as PluginEntry[] } = {},
  ): Promise<{ messages: ToolMessage[]; logged: Logged[] }> {
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          ...calls.map((call) => ({ content: '', toolCalls: [call] })),
          { content: '收工。' },
        ],
      }),
      ...(workspace
        ? { backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }) }
        : {}),
      checkpointer: new MemorySaver(),
      plugins,
    });
    const sessions = new SessionRegistry('tool-result-meta');
    const detach = attachSession(sessions);
    let state: { messages: BaseMessage[] };
    try {
      state = (await agent.invoke(toAgentInvocation('做。'), {
        configurable: { thread_id: 'tool-result-meta' },
      })) as { messages: BaseMessage[] };
    } finally {
      detach();
      await dispose();
    }
    const rootLog = sessions.list().find((entry) => entry.address.kind === 'root');
    return {
      messages: state.messages.filter((message): message is ToolMessage =>
        ToolMessage.isInstance(message),
      ),
      logged: (rootLog?.log.events ?? []).flatMap((event) =>
        event.type === 'tool/result'
          ? [{ isError: event.data.isError, hasMeta: 'meta' in event.data, meta: event.data.meta }]
          : [],
      ),
    };
  }

  describe('read_file', () => {
    it('行號從 1 算而且連續、totalLines 對得上、.ts 帶 lang；從中段讀 offset 對得上', async () => {
      await writeFile(join(root, 'app.ts'), numbered(250));
      const { logged } = await run([
        { name: 'read_file', args: { file_path: '/app.ts' } },
        { name: 'read_file', args: { file_path: '/app.ts', offset: 100, limit: 5 } },
      ]);
      const first = logged[0]?.meta as {
        path: string;
        offset: number;
        lines: { number: number; text: string }[];
        totalLines: number;
        lang?: string;
      };
      expect(first.path).toBe('/app.ts');
      expect(first.offset).toBe(1);
      expect(first.totalLines).toBe(250);
      expect(first.lang).toBe('ts');
      // 沒給 `limit`：一頁 2000 行（#602），250 行一次讀完。
      expect(first.lines).toHaveLength(250);
      expect(first.lines.map((line) => line.number)).toEqual(
        Array.from({ length: 250 }, (_, i) => i + 1),
      );
      expect(first.lines[249]).toEqual({ number: 250, text: 'line 250' });
      expect(logged[1]?.meta).toEqual({
        path: '/app.ts',
        offset: 101,
        lines: [101, 102, 103, 104, 105].map((n) => ({ number: n, text: `line ${n}` })),
        totalLines: 250,
        lang: 'ts',
      });
    }, 20000);

    it('沒有副檔名的檔不帶 lang 這一格', async () => {
      await writeFile(join(root, 'Makefile'), numbered(2));
      const { logged } = await run([{ name: 'read_file', args: { file_path: '/Makefile' } }]);
      expect(logged[0]?.meta).toEqual({
        path: '/Makefile',
        offset: 1,
        lines: [
          { number: 1, text: 'line 1' },
          { number: 2, text: 'line 2' },
        ],
        totalLines: 2,
      });
    }, 20000);

    it('基座自己截斷：只放完整看到的那幾行，跟 footer 講的一樣多', async () => {
      const long = Array.from({ length: 100 }, (_, i) => `${i + 1}:${'x'.repeat(1000)}`).join('\n');
      await writeFile(join(root, 'wide.txt'), long);
      const { messages, logged } = await run([
        { name: 'read_file', args: { file_path: '/wide.txt' } },
      ]);
      const footer = /Showing lines 1-(\d+)\. Use offset/.exec(textOf(messages[0]));
      const meta = logged[0]?.meta as { lines: { number: number }[]; totalLines: number };
      expect(meta.lines.length).toBe(Number(footer?.[1]));
      expect(meta.lines.at(-1)?.number).toBe(Number(footer?.[1]));
      expect(meta.totalLines).toBe(100);
    }, 20000);
  });

  it('grep：依檔案分組、檔案照路徑排序（同模型看到的文字）；total 是命中筆數', async () => {
    await writeFile(join(root, 'b.txt'), 'needle one\nhay\nneedle two\n');
    await writeFile(join(root, 'a.txt'), 'hay\nneedle three\n');
    const { messages, logged } = await run([
      { name: 'grep', args: { pattern: 'needle', path: '/' } },
    ]);
    const meta = logged[0]?.meta as {
      shape: string;
      files: { path: string; matches: { lineNumber: number; line: string }[] }[];
      truncated: boolean;
      total: number;
    };
    expect(meta.shape).toBe('matches');
    expect(meta.truncated).toBe(false);
    expect(meta.total).toBe(3);
    // 檔案照路徑排序，跟模型看到的文字同序。b 先寫、a 後寫，列檔順序照檔案系統而定；
    // 不照交出來的順序排的那一版在 Linux CI 上紅過（#619 之後），這裡把兩份的順序都釘死。
    const text = textOf(messages[0]);
    const order = meta.files.map((file) => file.path);
    expect(order).toEqual(['/a.txt', '/b.txt']);
    expect(text.indexOf('/a.txt')).toBeLessThan(text.indexOf('/b.txt'));
    expect(Object.fromEntries(meta.files.map((file) => [file.path, file.matches]))).toEqual({
      '/b.txt': [
        { lineNumber: 1, line: 'needle one' },
        { lineNumber: 3, line: 'needle two' },
      ],
      '/a.txt': [{ lineNumber: 2, line: 'needle three' }],
    });
  }, 20000);

  it('grep 撞到 max_count：files 是模型看到的那幾筆、truncated，total 是截之前的數（同 dsh）；模型那一份不變', async () => {
    await writeFile(join(root, 'many.txt'), 'needle\n'.repeat(5));
    const { messages, logged } = await run([
      { name: 'grep', args: { pattern: 'needle', path: '/', max_count: 2 } },
    ]);
    expect(logged[0]?.meta).toEqual({
      shape: 'matches',
      files: [
        {
          path: '/many.txt',
          matches: [
            { lineNumber: 1, line: 'needle' },
            { lineNumber: 2, line: 'needle' },
          ],
        },
      ],
      truncated: true,
      total: 5,
    });
    // 模型看到兩筆與基座的截斷提示——數總數的那一次沒有漏進模型那一份。
    const text = textOf(messages[0]);
    expect(text.match(/needle/g)).toHaveLength(2);
    expect(text).toContain('the search stopped early because it hit the maximum match count');
  }, 20000);

  it('grep 沒命中也帶，同 dsh：files 是空的、total 是 0', async () => {
    await writeFile(join(root, 'a.txt'), 'hay\n');
    const { logged } = await run([{ name: 'grep', args: { pattern: 'needle', path: '/' } }]);
    expect(logged[0]?.meta).toEqual({ shape: 'matches', files: [], truncated: false, total: 0 });
  }, 20000);

  it('grep 的另兩種模式不帶：模型看到的是檔名或計數，卡片不畫它沒看到的東西', async () => {
    await writeFile(join(root, 'a.txt'), 'needle\n');
    const { logged } = await run([
      { name: 'grep', args: { pattern: 'needle', path: '/', output_mode: 'files_with_matches' } },
      { name: 'grep', args: { pattern: 'needle', path: '/', output_mode: 'count' } },
    ]);
    expect(logged.map((entry) => entry.hasMeta)).toEqual([false, false]);
  }, 20000);

  it('glob：paths 與 total 對得上', async () => {
    await writeFile(join(root, 'a.md'), 'a');
    await writeFile(join(root, 'b.md'), 'b');
    await writeFile(join(root, 'c.txt'), 'c');
    const { logged } = await run([{ name: 'glob', args: { pattern: '*.md', path: '/' } }]);
    const meta = logged[0]?.meta as { shape: string; paths: string[]; total: number };
    expect(meta.shape).toBe('paths');
    expect([...meta.paths].sort()).toEqual(['/a.md', '/b.md']);
    expect(meta.total).toBe(2);
  }, 20000);

  for (const workspace of [true, false]) {
    const label = workspace ? 'ContainedFilesystemBackend' : 'StateBackend';

    it(`${label}：write_file 新建是空 diffs，覆寫照 hunk 算；edit_file 每個 hunk 一組、上下文 3 行`, async () => {
      const before = numbered(20);
      const after = before.replace('line 15\n', 'line fifteen\n');
      const { messages, logged } = await run(
        [
          { name: 'write_file', args: { file_path: '/doc.txt', content: before } },
          { name: 'read_file', args: { file_path: '/doc.txt' } },
          {
            name: 'edit_file',
            args: { file_path: '/doc.txt', old_string: 'line 3\n', new_string: 'line three\n' },
          },
          { name: 'write_file', args: { file_path: '/doc.txt', content: after } },
        ],
        { workspace },
      );
      // 新建那一次：模型收到的文字與狀態跟沒有 meta 時逐字相同——讀原檔那一次沒有被記成 backend 失敗。
      expect(messages[0]?.status).not.toBe('error');
      expect(textOf(messages[0])).toBe("Successfully wrote to '/doc.txt'");
      expect(logged[0]?.meta).toEqual({ operation: 'create', diffs: [] });

      expect(textOf(messages[2])).toBe("Successfully replaced 1 occurrence(s) in '/doc.txt'");
      expect(logged[2]?.meta).toEqual({
        diffs: [
          {
            path: '/doc.txt',
            oldText: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'].join('\n'),
            newText: ['line 1', 'line 2', 'line three', 'line 4', 'line 5', 'line 6'].join('\n'),
          },
        ],
      });

      // 覆寫的基準是 edit 之後那份（第 3 行已經是 three），所以這一次改了兩處：第 3 行與第 15 行，
      // 中間隔 11 行，多過兩邊上下文加起來的 6 行，所以是兩個 hunk。
      expect(textOf(messages[3])).toBe("Successfully wrote to '/doc.txt'");
      const overwrite = logged[3]?.meta as {
        operation: string;
        diffs: { oldText: string | null; newText: string }[];
      };
      expect(overwrite.operation).toBe('update');
      expect(overwrite.diffs).toHaveLength(2);
      expect(overwrite.diffs[0]?.oldText).toContain('line three');
      expect(overwrite.diffs[0]?.newText).toContain('line 3');
      expect(overwrite.diffs[1]?.oldText).toContain('line 15');
      expect(overwrite.diffs[1]?.newText).toContain('line fifteen');
      if (workspace) expect(await readFile(join(root, 'doc.txt'), 'utf8')).toBe(after);
    }, 20000);
  }

  it('不帶：ls、失敗的呼叫、二進位檔都沒有 meta 這一格', async () => {
    await writeFile(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const { logged } = await run([
      { name: 'ls', args: { path: '/' } },
      { name: 'read_file', args: { file_path: '/nope.txt' } },
      { name: 'edit_file', args: { file_path: '/nope.txt', old_string: 'a', new_string: 'b' } },
      { name: 'read_file', args: { file_path: '/pic.png' } },
    ]);
    expect(logged.map((entry) => entry.hasMeta)).toEqual([false, false, false, false]);
    expect(logged[1]?.isError).toBe(true);
  }, 20000);

  describe('有 permissions 規則的組裝，搜尋不帶 meta（抓的是濾之前那份）', () => {
    for (const [name, plugin] of [
      ['root 的規則', guard],
      ['subagent 自帶的規則', crew],
    ] as const) {
      it(
        name,
        async () => {
          await writeFile(join(root, 'a.txt'), 'needle\n');
          const { logged } = await run(
            [
              { name: 'grep', args: { pattern: 'needle', path: '/' } },
              { name: 'glob', args: { pattern: '*.txt', path: '/' } },
              { name: 'read_file', args: { file_path: '/a.txt' } },
            ],
            { plugins: [plugin] },
          );
          // 讀檔照帶：基座在呼叫 backend 之前就擋掉了，讀得到的就是模型看得到的。
          expect(logged.map((entry) => entry.hasMeta)).toEqual([false, false, true]);
        },
        20000,
      );
    }
  });

  it('模型看不到：ToolMessage 上沒有任何 meta 的痕跡', async () => {
    await writeFile(join(root, 'small.txt'), numbered(3));
    const { messages, logged } = await run([
      { name: 'read_file', args: { file_path: '/small.txt' } },
    ]);
    expect(logged[0]?.hasMeta).toBe(true);
    expect(textOf(messages[0])).toBe(
      '     1\tline 1\n     2\tline 2\n     3\tline 3\n\n(End of file - total 3 lines)',
    );
    expect(JSON.stringify(messages[0]?.toDict())).not.toContain('totalLines');
  }, 20000);
});
