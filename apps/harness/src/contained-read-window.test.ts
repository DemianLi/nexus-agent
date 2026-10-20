/**
 * **`read_file` 自己讀一次、大檔串流、單行截到 2000 字元**（[#1530](https://github.com/DemianLi/nexus-agent/issues/1530)）的驗收，
 * 量的是真的組裝、真的基座 `read_file` 跑完之後模型拿到什麼、先讀後改的版本對不對。
 *
 * 現狀的逐字基準在 `contained-read-baseline.test.ts`（這張不得讓它變紅）；`scanWindow` 對舊算法的等價在 `text-window.test.ts`。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { open, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import { FilesystemBackend } from 'deepagents';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend, READ_STREAM_MIN_SIZE } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface Result {
  readonly status: string | undefined;
  readonly text: string;
}

const read = (file: string, extra: Record<string, unknown> = {}): Call => ({
  name: 'read_file',
  args: { file_path: file, ...extra },
});
const edit = (file: string, from: string, to: string): Call => ({
  name: 'edit_file',
  args: { file_path: file, old_string: from, new_string: to },
});

const textOf = (message: ToolMessage): string => {
  const content = message.content;
  if (typeof content === 'string') return content;
  return content
    .map((block) => ((block as { text?: unknown }).text as string | undefined) ?? '')
    .join('');
};

/** 照順序跑完這幾個工具呼叫，回每一則工具訊息。 */
async function run(
  backend: ContainedFilesystemBackend,
  calls: readonly Call[],
  signal?: AbortSignal,
): Promise<Result[]> {
  const { agent, attachSession, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [...calls.map((call) => ({ content: '', toolCalls: [call] })), { content: '收工。' }],
    }),
    backend,
    checkpointer: new MemorySaver(),
    plugins: [],
  });
  const detach = attachSession(new SessionRegistry('read-window'));
  try {
    const state = (await agent.invoke(toAgentInvocation('讀。'), {
      configurable: { thread_id: 'read-window' },
      ...(signal === undefined ? {} : { signal }),
    })) as { messages: BaseMessage[] };
    return state.messages
      .filter((message): message is ToolMessage => ToolMessage.isInstance(message))
      .map((message) => ({ status: message.status, text: textOf(message) }));
  } finally {
    detach();
    await dispose();
  }
}

/** `FileHandle` 的原型：spy 它的 `createReadStream`，看讀檔有沒有走串流。 */
async function fileHandlePrototype(
  file: string,
): Promise<Record<string, (...args: never[]) => unknown>> {
  const handle = await open(file);
  try {
    return Object.getPrototypeOf(handle) as Record<string, (...args: never[]) => unknown>;
  } finally {
    await handle.close();
  }
}

let root: string;
let backend: ContainedFilesystemBackend;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-read-window-'));
  backend = new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('驗收 1：沒有換行的巨行，單行截到 2000 字元', () => {
  it('3 MB 一行 → 2000 字元＋後綴，總行數 1，沒有位元組截斷提示', async () => {
    await writeFile(join(root, 'huge.txt'), 'x'.repeat(3 * 1024 * 1024));
    const [result] = await run(backend, [read('/huge.txt')]);
    expect(result?.status).toBe('success');
    const text = result?.text ?? '';
    expect(text).toBe(
      `     1\t${'x'.repeat(2000)}... (line truncated to 2000 chars)\n\n(End of file - total 1 lines)`,
    );
    expect(text).not.toContain('[Output was truncated due to size limits.');
  });
});

describe('驗收 2：一次 read_file 只讀一次檔', () => {
  it('基座 read／readRaw 零次，我們的 read 一次、開檔一次', async () => {
    await writeFile(join(root, 'once.txt'), 'a\nb\nc\n');
    const baseRead = vi.spyOn(FilesystemBackend.prototype, 'read');
    const baseRaw = vi.spyOn(FilesystemBackend.prototype, 'readRaw');
    const ours = vi.spyOn(ContainedFilesystemBackend.prototype, 'read');
    const opened = vi.spyOn(
      ContainedFilesystemBackend.prototype as unknown as { readOpened(): unknown },
      'readOpened',
    );
    const [result] = await run(backend, [read('/once.txt')]);
    expect(result?.text).toContain('(End of file - total 3 lines)');
    expect(baseRead).not.toHaveBeenCalled();
    expect(baseRaw).not.toHaveBeenCalled();
    expect(ours).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});

describe('驗收 2b：邊讀邊算的版本與 readRaw 算的一樣——先讀後改不被誤擋', () => {
  const files: [string, Buffer | string, string][] = [
    ['ascii', 'hello\nworld\n', 'world'],
    ['cjk', '你好\n世界🙂\n再見\n', '世界🙂'],
    ['crlf', 'one\r\ntwo\r\nthree\r\n', 'two'],
    [
      'bom',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom line\nsecond\n')]),
      'second',
    ],
    ['notail', 'x\ny\nz', 'y'],
  ];
  for (const [name, content, needle] of files) {
    it(`${name}：讀完直接改，不得 FS_STALE_VERSION`, async () => {
      await writeFile(join(root, `v-${name}.txt`), content);
      const results = await run(backend, [
        read(`/v-${name}.txt`),
        edit(`/v-${name}.txt`, needle, `${needle}!`),
      ]);
      expect(results[0]?.status).toBe('success');
      expect(results[1]?.status).not.toBe('error');
      expect(results[1]?.text).toContain('Successfully replaced');
    });
  }

  it('讀過之後檔案被換掉 → 仍然擋下（版本真的在比）', async () => {
    const file = join(root, 'v-changed.txt');
    await writeFile(file, 'before\n');
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          { content: '', toolCalls: [read('/v-changed.txt')] },
          { content: '', toolCalls: [edit('/v-changed.txt', 'before', 'after')] },
          { content: '收工。' },
        ],
      }),
      backend,
      checkpointer: new MemorySaver(),
      plugins: [
        {
          plugin: {
            name: 'touch',
            apply(registry) {
              registry.approvals.gate(async (exec, next) => {
                if (exec.name === 'edit_file') await writeFile(file, 'someone else\n');
                return next();
              });
            },
          },
        },
      ],
    });
    const detach = attachSession(new SessionRegistry('read-window-stale'));
    try {
      const state = (await agent.invoke(toAgentInvocation('讀。'), {
        configurable: { thread_id: 'read-window-stale' },
      })) as { messages: BaseMessage[] };
      const tools = state.messages.filter((m): m is ToolMessage => ToolMessage.isInstance(m));
      expect(tools[1]?.status).toBe('error');
    } finally {
      detach();
      await dispose();
    }
  });
});

describe('驗收 3：串流路與整份路輸出逐字相同', () => {
  it('同一批檔，streamMinSize 1024 對 Infinity', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${'你好🙂'.repeat(i % 7)}`);
    await writeFile(join(root, 'many.txt'), `${lines.join('\n')}\n`);
    await writeFile(join(root, 'long.txt'), `short\n${'y'.repeat(5000)}\nend`);
    const whole = new ContainedFilesystemBackend({
      rootDir: root,
      mode: 'workspace-write',
      streamMinSize: Infinity,
    });
    const streamed = new ContainedFilesystemBackend({
      rootDir: root,
      mode: 'workspace-write',
      streamMinSize: 1024,
    });
    const calls = [
      read('/many.txt'),
      read('/many.txt', { offset: 4990, limit: 50 }),
      read('/many.txt', { offset: 99999 }),
      read('/long.txt'),
      read('/absent.txt'),
    ];
    const a = await run(whole, calls);
    const proto = await fileHandlePrototype(join(root, 'many.txt'));
    const spy = vi.spyOn(proto, 'createReadStream');
    const b = await run(streamed, calls);
    expect(b).toEqual(a);
    expect(spy).toHaveBeenCalled();
  });

  it('預設門檻是 10 MiB，小檔不走串流', async () => {
    expect(READ_STREAM_MIN_SIZE).toBe(10 * 1024 * 1024);
    const proto = await fileHandlePrototype(join(root, 'once.txt'));
    const spy = vi.spyOn(proto, 'createReadStream');
    await run(backend, [read('/once.txt')]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('驗收 5：不在 read_file 裡的直接呼叫維持基座語意', () => {
  it('3000 字元的行完整回傳，不截、不加後綴', async () => {
    await writeFile(join(root, 'direct.txt'), `${'d'.repeat(3000)}\nnext\n`);
    const result = await backend.read('/direct.txt', 0, 10);
    expect(result.content).toBe(`${'d'.repeat(3000)}\nnext\n`);
  });
});

describe('驗收 6：看內容，不看副檔名', () => {
  it('叫 .png 的純文字讀得到；真的 PNG 回 binary file', async () => {
    await writeFile(join(root, 'notes.png'), 'just text\n');
    await writeFile(
      join(root, 'real.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    );
    const [text, png] = await run(backend, [read('/notes.png'), read('/real.png')]);
    expect(text).toEqual({
      status: 'success',
      text: '     1\tjust text\n\n(End of file - total 1 lines)',
    });
    expect(png?.status).toBe('error');
    expect(png?.text).toContain('binary file');
  });
});

describe('驗收 7：取消', () => {
  it('50 MB 串流到一半中止 → 200 ms 內收尾，回 read aborted', async () => {
    const big = join(root, 'big.txt');
    const chunk = `${'z'.repeat(99)}\n`;
    await writeFile(big, chunk.repeat((50 * 1024 * 1024) / chunk.length));
    const ours = vi.spyOn(ContainedFilesystemBackend.prototype, 'read');
    const controller = new AbortController();
    const started = Date.now();
    const running = run(backend, [read('/big.txt', { limit: 1 })], controller.signal).catch(
      () => 'rejected',
    );
    // 等讀檔真的開始再中止。
    while (ours.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    const abortedAt = Date.now();
    controller.abort();
    const outcome = await ours.mock.results[0]!.value;
    expect(Date.now() - abortedAt).toBeLessThan(200);
    expect(outcome).toEqual({ error: 'read aborted' });
    await running;
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});
