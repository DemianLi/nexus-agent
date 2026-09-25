/**
 * 讀檔結果最後補上讀到哪的那一層自己的邏輯——直接餵 middleware 一個假 `handler`，`handler` 照基座
 * `read_file` 的樣子叫包過的 backend、編號、包成 ToolMessage。「fold 有沒有把它打底進去、排在哪」在
 * `fold.test.ts`；「掛進真的 agent、真的基座工具之後」在 `apps/harness/src/read-continuation.test.ts`。
 */

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  continuationFooter,
  createReadContinuationMiddleware,
  READ_LIMIT,
  READ_MAX_BYTES,
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
    expect(
      continuationFooter({ offset: 0, shown: 100, total: 500, cappedByBytes: false }, text),
    ).toBe('(Output capped. Showing lines 1-2. Use offset=2 to continue.)');
  });

  it('長行切出來的續行編號取整數那一段', () => {
    const text = `    11\taaa\n    12\tbbb\n  12.1\tbbb${mark}`;
    expect(
      continuationFooter({ offset: 10, shown: 100, total: 500, cappedByBytes: false }, text),
    ).toBe('(Output capped. Showing lines 11-11. Use offset=11 to continue.)');
  });

  it('第一行就被截掉：跳過它，不叫它重讀同一行', () => {
    const text = `    11\t${'x'.repeat(10)}\n  11.1\t${'x'.repeat(10)}${mark}`;
    expect(
      continuationFooter({ offset: 10, shown: 100, total: 500, cappedByBytes: false }, text),
    ).toBe('(Output capped. Use offset=11 to continue.)');
  });
});

/** 照基座 `read_file` 的樣子，但 `limit` 從呼叫參數讀——看得到 middleware 補的預設。 */
function argsReadFile(backend: SliceBackend) {
  return async (request: unknown): Promise<ToolMessage> => {
    const args = (request as { toolCall: { args: { offset?: number; limit: number } } }).toolCall
      .args;
    return baseReadFile(backend, args.offset ?? 0, args.limit)();
  };
}

/** 一個檔：每行 `bytes` 個 UTF-8 位元組（用三位元組的「中」湊），共 `n` 行，結尾有換行。 */
function wide(n: number, bytes: number): string {
  return `${Array.from({ length: n }, () => '中'.repeat(bytes / 3)).join('\n')}\n`;
}

describe('一頁多大：照 dsh', () => {
  const wrap = wrapperOf(createReadContinuationMiddleware());

  it('沒給 limit：填 2000；給了 null 也是', async () => {
    for (const args of [{}, { limit: null }]) {
      let seen: unknown;
      await wrap(requestFor('read_file', args), async (request) => {
        seen = (request as { toolCall: { args: unknown } }).toolCall.args;
        return new ToolMessage({ content: 'ok', tool_call_id: 'call-1', name: 'read_file' });
      });
      expect(seen).toMatchObject({ limit: READ_LIMIT });
    }
  });

  it('給了就照給的；剛好 2000 也放行', async () => {
    for (const limit of [50, READ_LIMIT]) {
      let seen: unknown;
      await wrap(requestFor('read_file', { limit }), async (request) => {
        seen = (request as { toolCall: { args: unknown } }).toolCall.args;
        return new ToolMessage({ content: 'ok', tool_call_id: 'call-1', name: 'read_file' });
      });
      expect(seen).toEqual({ limit });
    }
  });

  it('超過 2000：拋 dsh 的原句，工具不跑', async () => {
    for (const limit of [READ_LIMIT + 1, String(READ_LIMIT + 1)]) {
      let ran = false;
      await expect(
        wrap(requestFor('read_file', { limit }), async () => {
          ran = true;
          return new ToolMessage({ content: 'ok', tool_call_id: 'call-1', name: 'read_file' });
        }),
      ).rejects.toThrow('limit must be less than or equal to 2000');
      expect(ran).toBe(false);
    }
  });

  it('別的工具的 limit 不管', async () => {
    let seen: unknown;
    await wrap(requestFor('grep', { limit: 99999 }), async (request) => {
      seen = (request as { toolCall: { args: unknown } }).toolCall.args;
      return new ToolMessage({ content: 'ok', tool_call_id: 'call-1', name: 'grep' });
    });
    expect(seen).toEqual({ limit: 99999 });
  });

  it('沒給 limit 時一次讀到 2000 行', async () => {
    const backend = recordReadExtent(new SliceBackend({ '/f': numbered(2500) })) as SliceBackend;
    const result = (await wrap(requestFor('read_file'), argsReadFile(backend))) as ToolMessage;
    expect(textOf(result)).toMatch(
      /\(Showing lines 1-2000 of 2500\. Use offset=2000 to continue\.\)$/,
    );
  });

  it('位元組上限按 UTF-8 算，每行不是第一行的多算一個換行，停在前一行', async () => {
    // 每行 999 位元組（333 字元）：1 行 999，n 行 999 + (n-1) × 1000。51 行 = 50,999 ≤ 51,200，52 行超過。
    // 按字元數算的話 52 行才 17,367，會整份給出去。
    const backend = recordReadExtent(new SliceBackend({ '/f': wide(100, 999) })) as SliceBackend;
    const result = (await wrap(requestFor('read_file'), argsReadFile(backend))) as ToolMessage;
    const text = textOf(result);
    expect(text).toMatch(
      /\n\n\(Output capped\. Showing lines 1-51\. Use offset=51 to continue\.\)$/,
    );
    expect(text).toContain('    51\t');
    expect(text).not.toContain('    52\t');
  });

  it('剛好等於上限還放得下，多一個位元組就停', async () => {
    // 兩行加一個換行剛好 51,200；第三行一個位元組放不下。
    const half = READ_MAX_BYTES / 2;
    const exact = `${'a'.repeat(half)}\n${'b'.repeat(half - 1)}\nc\n`;
    const backend = recordReadExtent(new SliceBackend({ '/f': exact })) as SliceBackend;
    const result = (await wrap(requestFor('read_file'), argsReadFile(backend))) as ToolMessage;
    expect(textOf(result)).toMatch(
      /\(Output capped\. Showing lines 1-2\. Use offset=2 to continue\.\)$/,
    );

    const fits = recordReadExtent(
      new SliceBackend({ '/f': exact.replace('\nc\n', '\n') }),
    ) as SliceBackend;
    const whole = (await wrap(requestFor('read_file'), argsReadFile(fits))) as ToolMessage;
    expect(textOf(whole)).toMatch(/\(End of file - total 2 lines\)$/);
  });

  it('第一行自己就超過上限：照樣給那一行（偏離二），下一頁從第二行接', async () => {
    const big = `${'x'.repeat(READ_MAX_BYTES + 10)}\nsecond\n`;
    const backend = recordReadExtent(new SliceBackend({ '/f': big })) as SliceBackend;
    const first = (await wrap(requestFor('read_file'), argsReadFile(backend))) as ToolMessage;
    expect(textOf(first)).toMatch(
      /\(Output capped\. Showing lines 1-1\. Use offset=1 to continue\.\)$/,
    );
    const next = (await wrap(
      requestFor('read_file', { offset: 1 }),
      argsReadFile(backend),
    )) as ToolMessage;
    expect(textOf(next).split('\n')[0]).toBe('     2\tsecond');
  });

  it('照 capped 給的 offset 翻頁，一行不漏、一行不重', async () => {
    const backend = recordReadExtent(new SliceBackend({ '/f': wide(120, 999) })) as SliceBackend;
    const seen: number[] = [];
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      const result = (await wrap(
        requestFor('read_file', { offset }),
        argsReadFile(backend),
      )) as ToolMessage;
      const text = textOf(result);
      for (const match of text.matchAll(/^ *(\d+)\t/gm)) seen.push(Number(match[1]));
      const next = /offset=(\d+)/.exec(text);
      if (next === null) break;
      offset = Number(next[1]);
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  });
});

type ModelWrapper = (
  request: { tools?: unknown[] },
  handler: (request: { tools?: unknown[] }) => unknown,
) => unknown;

/** 形狀同基座 `read_file` 的一個工具：描述裡那一句、schema 的預設與必填都照 `deepagents@1.13.1`。 */
const baseReadTool = tool(() => '', {
  name: 'read_file',
  description:
    'Reads a file.\n\nUsage:\n- By default, it reads up to 100 lines starting from the beginning of the file. Use `offset`/`limit` to page.',
  schema: z.object({
    file_path: z.string().describe('Absolute path to the file to read'),
    offset: z.coerce.number().optional().default(0).describe('Line offset'),
    limit: z.coerce.number().optional().default(100).describe('Max lines'),
  }),
});
const otherTool = tool(() => '', { name: 'grep', description: 'g', schema: z.object({}) });

describe('模型看到的 read_file', () => {
  const middleware = createReadContinuationMiddleware() as unknown as {
    wrapModelCall: ModelWrapper;
  };
  const toolsSent = (tools: unknown[]): unknown[] => {
    let sent: unknown[] = [];
    middleware.wrapModelCall({ tools }, (request) => {
      sent = request.tools ?? [];
      return undefined;
    });
    return sent;
  };

  it('描述講 2000 行；limit 照 dsh 的措辭、不再必填、沒有預設', () => {
    const [read] = toolsSent([baseReadTool]) as [
      { function: { description: string; parameters: Record<string, unknown> } },
    ];
    expect(read.function.description).toContain('By default, it reads up to 2000 lines');
    expect(read.function.description).not.toContain('100 lines');
    const parameters = read.function.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(parameters.properties.limit).toEqual({
      type: 'number',
      description: 'Maximum number of lines to return. Defaults to 2000.',
    });
    expect(parameters.required).not.toContain('limit');
    expect(parameters.required).toContain('file_path');
    // 其餘參數原樣。
    expect(parameters.properties.file_path).toMatchObject({ type: 'string' });
  });

  it('別的工具原樣；同一個工具每次換出同一份', () => {
    const first = toolsSent([otherTool, baseReadTool]);
    expect(first[0]).toBe(otherTool);
    expect(toolsSent([baseReadTool])[0]).toBe(first[1]);
    // 已經換過的再進來一次，不再換。
    expect(toolsSent([first[1]])[0]).toBe(first[1]);
  });

  it('基座的排除工具照樣認得它，而 name 不會進請求本體', () => {
    const [read] = toolsSent([baseReadTool]) as [Record<string, unknown>];
    // `_ToolExclusionMiddleware` 的判法（`hasToolName`）。
    expect('name' in read && read.name === 'read_file').toBe(true);
    expect(Object.keys(JSON.parse(JSON.stringify(read)) as object)).toEqual(['type', 'function']);
  });

  it('沒有 read_file 的請求原樣交下去', () => {
    const request = { tools: [otherTool] };
    let seen: unknown;
    middleware.wrapModelCall(request, (next) => {
      seen = next;
      return undefined;
    });
    expect(seen).toBe(request);
  });
});
