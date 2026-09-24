/**
 * 讀檔結果最後補上讀到哪的那一層自己的邏輯——直接餵 middleware 一個假 `handler`，`handler` 照基座
 * `read_file` 的樣子叫包過的 backend、編號、包成 ToolMessage。「fold 有沒有把它打底進去、排在哪」在
 * `fold.test.ts`；「掛進真的 agent、真的基座工具之後」在 `apps/harness/src/read-continuation.test.ts`。
 */

import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  continuationFooter,
  createReadContinuationMiddleware,
  recordReadExtent,
} from './read-continuation.js';

type Wrapper = (
  request: unknown,
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

function wrapperOf(middleware: unknown): Wrapper {
  const wrap = (middleware as { wrapToolCall?: Wrapper }).wrapToolCall;
  if (wrap === undefined) throw new Error('這個 middleware 沒有 wrapToolCall');
  return wrap;
}

function requestFor(name: string, args: Record<string, unknown> = {}): unknown {
  return { toolCall: { name, args, id: 'call-1' }, state: {}, runtime: {} };
}

/**
 * 切片語意的假 backend，同基座 `StateBackend.read`：`lines[offset, offset+limit)`。
 * `calls` 記下每次實際收到的參數。`#files` 是私有欄位：包過之後要以原物件為 `this` 才讀得到。
 */
class SliceBackend {
  readonly calls: Array<[string, number, number]> = [];
  #files = new Map<string, string>();

  constructor(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) this.#files.set(path, content);
  }

  async read(path: string, offset = 0, limit = 500): Promise<{ content?: string; error?: string }> {
    this.calls.push([path, offset, limit]);
    const content = this.#files.get(path);
    if (content === undefined) return { error: `File '${path}' not found` };
    return {
      content: content
        .split('\n')
        .slice(offset, offset + limit)
        .join('\n'),
    };
  }
}

/** `n` 行的檔，第 i 行（1 起算）是 `line i`，結尾有換行。 */
function numbered(n: number): string {
  return `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
}

/** 照基座 `read_file` 的樣子：讀、去掉結尾的空行、編號（1 起算＋offset）、包成文字塊。 */
function baseReadFile(backend: SliceBackend, offset = 0, limit = 100) {
  return async (): Promise<ToolMessage> => {
    const out = await backend.read('/f', offset, limit);
    if (out.error !== undefined) {
      return new ToolMessage({
        content: [{ type: 'text', text: `Error: ${out.error}` }],
        tool_call_id: 'call-1',
        name: 'read_file',
      });
    }
    const lines = (out.content ?? '').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const text = lines
      .map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`)
      .join('\n');
    return new ToolMessage({
      content: [{ type: 'text', text }],
      tool_call_id: 'call-1',
      name: 'read_file',
    });
  };
}

function textOf(message: ToolMessage): string {
  const block = (message.content as Array<{ type: string; text?: string }>).at(-1);
  return block?.text ?? '';
}

describe('讀檔結果最後補上讀到哪', () => {
  const wrap = wrapperOf(createReadContinuationMiddleware());

  it('沒讀完：寫出總行數與下一頁的 offset，內容跟不包時一字不差', async () => {
    const plain = new SliceBackend({ '/f': numbered(250) });
    const wrapped = new SliceBackend({ '/f': numbered(250) });
    const expected = textOf(await baseReadFile(plain)());
    const result = (await wrap(
      requestFor('read_file'),
      baseReadFile(recordReadExtent(wrapped) as SliceBackend),
    )) as ToolMessage;
    expect(textOf(result)).toBe(
      `${expected}\n\n(Showing lines 1-100 of 250. Use offset=100 to continue.)`,
    );
    // backend 只讀了一次；那一次放開了 limit。
    expect(wrapped.calls).toEqual([['/f', 0, Number.MAX_SAFE_INTEGER]]);
  });

  it('照提示給的 offset 讀下一頁，第一行剛好接上上一頁的最後一行', async () => {
    const backend = recordReadExtent(new SliceBackend({ '/f': numbered(250) })) as SliceBackend;
    const first = (await wrap(requestFor('read_file'), baseReadFile(backend))) as ToolMessage;
    const next = Number(/offset=(\d+)/.exec(textOf(first))?.[1]);
    const second = (await wrap(
      requestFor('read_file'),
      baseReadFile(backend, next),
    )) as ToolMessage;
    expect(textOf(first)).toContain('   100\tline 100\n\n');
    expect(textOf(second).split('\n')[0]).toBe('   101\tline 101');
  });

  it('讀到檔尾：寫檔尾與總行數，結尾的換行不算一行', async () => {
    const backend = recordReadExtent(new SliceBackend({ '/f': numbered(250) })) as SliceBackend;
    const result = (await wrap(requestFor('read_file'), baseReadFile(backend, 200))) as ToolMessage;
    expect(textOf(result)).toMatch(/ {3}250\tline 250\n\n\(End of file - total 250 lines\)$/);
  });

  it('剛好讀完一整頁、後面沒有了：是檔尾，不叫它翻頁', async () => {
    const backend = recordReadExtent(new SliceBackend({ '/f': numbered(100) })) as SliceBackend;
    const result = (await wrap(requestFor('read_file'), baseReadFile(backend))) as ToolMessage;
    expect(textOf(result)).toMatch(/\(End of file - total 100 lines\)$/);
  });

  it('結尾沒有換行的檔，最後一行照樣算', async () => {
    const backend = recordReadExtent(new SliceBackend({ '/f': 'a\nb\nc' })) as SliceBackend;
    const result = (await wrap(
      requestFor('read_file'),
      baseReadFile(backend, 0, 2),
    )) as ToolMessage;
    expect(textOf(result)).toMatch(/\(Showing lines 1-2 of 3\. Use offset=2 to continue\.\)$/);
  });

  it('讀失敗：原樣交出，不補', async () => {
    const backend = recordReadExtent(new SliceBackend({})) as SliceBackend;
    const result = (await wrap(requestFor('read_file'), baseReadFile(backend))) as ToolMessage;
    expect(textOf(result)).toBe("Error: File '/f' not found");
  });

  it('別的工具：不補，backend 的參數也不動', async () => {
    const inner = new SliceBackend({ '/f': numbered(250) });
    const backend = recordReadExtent(inner) as SliceBackend;
    const result = (await wrap(requestFor('grep'), async () => {
      await backend.read('/f', 0, 10);
      return new ToolMessage({ content: 'ok', tool_call_id: 'call-1', name: 'grep' });
    })) as ToolMessage;
    expect(result.content).toBe('ok');
    expect(inner.calls).toEqual([['/f', 0, 10]]);
  });

  it('不在任何一次工具呼叫裡（摘要器、測試直接叫 backend）：參數原樣轉交', async () => {
    const inner = new SliceBackend({ '/f': numbered(250) });
    const out = await (recordReadExtent(inner) as SliceBackend).read('/f', 5, 10);
    expect(inner.calls).toEqual([['/f', 5, 10]]);
    expect(out.content?.split('\n')).toHaveLength(10);
  });

  it('其餘的欄位原樣帶過去，只換內容', async () => {
    const backend = recordReadExtent(new SliceBackend({ '/f': numbered(3) })) as SliceBackend;
    const result = (await wrap(requestFor('read_file'), async () => {
      const base = await baseReadFile(backend)();
      return new ToolMessage({
        content: base.content,
        tool_call_id: 'call-1',
        name: 'read_file',
        id: 'msg-1',
        additional_kwargs: { mark: 1 },
      });
    })) as ToolMessage;
    expect(result.id).toBe('msg-1');
    expect(result.additional_kwargs).toEqual({ mark: 1 });
    expect(result.tool_call_id).toBe('call-1');
  });
});

describe('基座自己截斷時', () => {
  const mark =
    '\n\n[Output was truncated due to size limits. The file content is very large. Consider reformatting the file …]';

  it('最後看得到的那一行可能只顯示了一半：下一頁從它重讀', () => {
    const text = `     1\taaa\n     2\tbbb\n     3\tcc${mark}`;
    expect(continuationFooter({ offset: 0, shown: 100, total: 500 }, text)).toBe(
      '(Output capped. Showing lines 1-2. Use offset=2 to continue.)',
    );
  });

  it('長行切出來的續行編號取整數那一段', () => {
    const text = `    11\taaa\n    12\tbbb\n  12.1\tbbb${mark}`;
    expect(continuationFooter({ offset: 10, shown: 100, total: 500 }, text)).toBe(
      '(Output capped. Showing lines 11-11. Use offset=11 to continue.)',
    );
  });

  it('第一行就被截掉：跳過它，不叫它重讀同一行', () => {
    const text = `    11\t${'x'.repeat(10)}\n  11.1\t${'x'.repeat(10)}${mark}`;
    expect(continuationFooter({ offset: 10, shown: 100, total: 500 }, text)).toBe(
      '(Output capped. Use offset=11 to continue.)',
    );
  });
});
