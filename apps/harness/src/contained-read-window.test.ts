/**
 * **`read_file` 自己讀一次、大檔串流、單行截到 2000 字元**（[#1530](https://github.com/DemianLi/nexus-agent/issues/1530)）的驗收，
 * 量的是真的組裝、真的基座 `read_file` 跑完之後模型拿到什麼、先讀後改的版本對不對。
 *
 * 現狀的逐字基準在 `contained-read-baseline.test.ts`（這張不得讓它變紅）；`scanWindow` 對舊算法的等價在 `text-window.test.ts`。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { FILE_VERSION, SessionRegistry } from '@nexus/core';
import { FilesystemBackend } from 'deepagents';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * 計數 `node:fs/promises` 開檔的次數（#1776）：`contained-backend.ts` 開檔是 `open`，用路徑直接讀是 `readFile(path)`（內部也是開一次檔），
 * 兩支都原樣轉給真的，只多記一筆路徑。傳進來的若是 FileHandle（不是路徑）就不算開檔。只有這個測試檔看得到這層包裝。
 */
const fsOpenCalls = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const counting = <F extends (...args: never[]) => unknown>(original: F): F =>
    ((target: unknown, ...rest: unknown[]) => {
      if (typeof target === 'string' || target instanceof URL) fsOpenCalls.push(String(target));
      return (original as unknown as (...args: unknown[]) => unknown)(target, ...rest);
    }) as unknown as F;
  return { ...actual, open: counting(actual.open), readFile: counting(actual.readFile) };
});

/**
 * `read_file` 回報給「先讀後改」的版本（#2030）：`contained-backend.ts` 從 `@nexus/core` 叫 `noteReadVersion`，這裡包一層記下來再原樣轉交，
 * 好跟寫前比對那一側（`FILE_VERSION`）逐字比。
 */
const reportedVersions = vi.hoisted(() => [] as string[]);
vi.mock('@nexus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nexus/core')>();
  return {
    ...actual,
    noteReadVersion: (version: string) => {
      reportedVersions.push(version);
      actual.noteReadVersion(version);
    },
  };
});

/** 這個測試檔從現在起開過幾次這個檔。 */
const openCountOf = (file: string): number => fsOpenCalls.filter((path) => path === file).length;

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

  // #1776：上面只 spy `readOpened`，在 `read` 開檔前多開一次檔（再 `readFile`）它一樣是 1 次。這裡數 `node:fs/promises` 的 `open` 與用路徑讀的 `readFile`。
  it('同一路徑只開一次檔（數 fs 的 open 與用路徑的 readFile，不是我們自己的方法）', async () => {
    const file = join(root, 'once-open.txt');
    await writeFile(file, 'a\nb\nc\n');
    const before = openCountOf(file);
    const [result] = await run(backend, [read('/once-open.txt')]);
    expect(result?.text).toContain('(End of file - total 3 lines)');
    expect(openCountOf(file) - before).toBe(1);
  });
});

describe('驗收 2b：讀檔回報的版本與寫前比對的一樣——先讀後改不被誤擋', () => {
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

  it('讀檔回報的就是寫前比對的那個 stat token，逐字相同（#2030）', async () => {
    await writeFile(join(root, 'v-pin.txt'), 'pin\n');
    reportedVersions.length = 0;
    const [result] = await run(backend, [read('/v-pin.txt')]);
    expect(result?.status).toBe('success');
    expect(reportedVersions).toHaveLength(1);
    // dev:ino:size:mtimeNs:ctimeNs；size 是 'pin\n' 的 4 位元組。
    expect(reportedVersions[0]).toMatch(/^\d+:\d+:4:\d+:\d+$/);
    expect(await backend[FILE_VERSION]('/v-pin.txt')).toEqual({
      kind: 'present',
      version: reportedVersions[0],
    });
  });

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

describe('驗收 6b：副檔名不是文字的純文字檔，讀過就改得了（#1776）', () => {
  // `read_file` 回報的版本是對解碼後的文字算的；寫入側的新鮮度檢查走基座 `readRaw`，對非文字副檔名它回位元組，
  // 以前被當成空字串，兩邊永遠對不上，錯誤句子還叫模型重讀。
  it('notes.png：read_file 之後 edit_file 成功', async () => {
    await writeFile(join(root, 'e-notes.png'), 'just text\n');
    const results = await run(backend, [
      read('/e-notes.png'),
      edit('/e-notes.png', 'just', 'only'),
    ]);
    expect(results[0]?.status).toBe('success');
    expect(results[1]?.status).not.toBe('error');
    expect(results[1]?.text).toContain('Successfully replaced');
  });

  it('cjk.png：read_file 之後 write_file 成功（不得 FS_STALE_VERSION），落盤就是寫進去的那段文字（#1813）', async () => {
    await writeFile(join(root, 'e-cjk.png'), '你好\n世界🙂\n');
    const results = await run(backend, [
      read('/e-cjk.png'),
      { name: 'write_file', args: { file_path: '/e-cjk.png', content: '新的內容 hello\n' } },
    ]);
    expect(results[0]?.status).toBe('success');
    expect(results[1]?.status).not.toBe('error');
    expect(results[1]?.text).not.toContain('被改動');
    // #1810 之前這一步被意外擋下、之後會回成功卻把內容當 base64 解碼落成亂碼；#1813 起一律寫文字。
    expect(await readFile(join(root, 'e-cjk.png'), 'utf8')).toBe('新的內容 hello\n');
  });

  // 審查突變 A2：把 `contentText` 的 `ignoreBOM: true` 改成 false，原本沒有任何測試紅。BOM 是版本比對承重的一條：
  // `read_file` 回報的版本是對「BOM 留著」的文字算的，寫入側解碼若丟掉 BOM，長度差 1，讀完 edit 就被擋。
  it('BOM＋CRLF 的 .png：read_file 之後 edit_file 成功（BOM 留著才對得上版本）', async () => {
    await writeFile(join(root, 'e-bom.png'), Buffer.from('\uFEFFfirst\r\nsecond\r\n', 'utf8'));
    const results = await run(backend, [
      read('/e-bom.png'),
      edit('/e-bom.png', 'second', 'SECOND'),
    ]);
    expect(results[0]?.status).toBe('success');
    expect(results[1]?.status).not.toBe('error');
    expect(results[1]?.text).toContain('Successfully replaced');
  });

  it('讀完被別人換掉的還是擋下（版本真的在比）：非文字副檔名也一樣', async () => {
    const file = join(root, 'e-changed.png');
    await writeFile(file, 'before\n');
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          { content: '', toolCalls: [read('/e-changed.png')] },
          { content: '', toolCalls: [edit('/e-changed.png', 'before', 'after')] },
          { content: '收工。' },
        ],
      }),
      backend,
      checkpointer: new MemorySaver(),
      plugins: [
        {
          plugin: {
            name: 'touch-png',
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
    const detach = attachSession(new SessionRegistry('read-window-stale-png'));
    try {
      const state = (await agent.invoke(toAgentInvocation('讀。'), {
        configurable: { thread_id: 'read-window-stale-png' },
      })) as { messages: BaseMessage[] };
      const tools = state.messages.filter((m): m is ToolMessage => ToolMessage.isInstance(m));
      expect(tools[0]?.status).toBe('success');
      expect(tools[1]?.status).toBe('error');
      expect(tools[1]?.text ?? textOf(tools[1]!)).toContain('被改動');
    } finally {
      detach();
      await dispose();
    }
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
  // #1776：`read` 在開檔之前就看 signal（`contained-backend.ts` 的 `READ_ABORTED` 早退）。上面那條是讀到一半才中止，
  // 這一條是讀之前就已經中止：回 `read aborted`、`open` 零次。突變：拿掉那一行早退 → `open` 變 1 次，這條紅
  // （後面的 `readFile({ signal })` 仍會因為已中止而回同一句，所以只看結果分不出來，要數 `open`）。
  it('signal 先中止 → read aborted，open 0 次', async () => {
    const file = join(root, 'pre-aborted.txt');
    await writeFile(file, 'a\nb\n');
    const controller = new AbortController();
    const ours = vi.spyOn(ContainedFilesystemBackend.prototype, 'read');
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [{ content: '', toolCalls: [read('/pre-aborted.txt')] }, { content: '收工。' }],
      }),
      backend,
      checkpointer: new MemorySaver(),
      plugins: [
        {
          plugin: {
            name: 'abort-before-read',
            apply(registry) {
              // 核准閘門在工具真的跑之前：這裡中止，工具呼叫的 signal 就是已中止的。
              registry.approvals.gate(async (exec, next) => {
                if (exec.name === 'read_file') controller.abort();
                return next();
              });
            },
          },
        },
      ],
    });
    const detach = attachSession(new SessionRegistry('read-window-pre-aborted'));
    const before = openCountOf(file);
    try {
      await agent
        .invoke(toAgentInvocation('讀。'), {
          configurable: { thread_id: 'read-window-pre-aborted' },
          signal: controller.signal,
        })
        .catch(() => undefined);
    } finally {
      detach();
      await dispose();
    }
    expect(ours).toHaveBeenCalledTimes(1);
    await expect(ours.mock.results[0]!.value).resolves.toEqual({ error: 'read aborted' });
    expect(openCountOf(file) - before).toBe(0);
  });
});
