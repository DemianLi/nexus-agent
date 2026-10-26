/**
 * 共用區讀出來的內容加前綴的那一層（[#1676](https://github.com/DemianLi/nexus-agent/issues/1676)）：路由判斷、成功的判準、形狀。
 * 掛進真的組裝之後的行為在 `apps/harness/src/shared-read-mark-on-tree.test.ts`。
 */

import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { CompositeBackend, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { EMPTY_CONTENT_WARNING } from './read-continuation.js';
import { createSharedReadMarkMiddleware } from './shared-read-mark.js';
import { SHARED_WORKSPACE_CONTENT_NOTICE as NOTICE } from './untrusted-content.js';

type Wrapper = (
  request: unknown,
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

const wrap = (createSharedReadMarkMiddleware('/shared') as unknown as { wrapToolCall: Wrapper })
  .wrapToolCall;

/** 叫一次：工具回 `result`，回 middleware 交出的東西。 */
async function through(name: string, args: Record<string, unknown>, result: unknown) {
  return wrap(
    { toolCall: { name, args, id: 'call-1' }, state: {}, runtime: {} },
    async () => result,
  );
}

const message = (content: ToolMessage['content'], status?: 'error') =>
  new ToolMessage({ content, tool_call_id: 'call-1', name: 'x', ...(status && { status }) });

const textOf = (result: unknown): ToolMessage['content'] => (result as ToolMessage).content;

describe('路由判斷跟 CompositeBackend 一樣', () => {
  // 真的 composite：共用區掛在 `/shared/`（組裝點的路由鍵帶結尾斜線）。它把哪些路徑送到共用區那一格，這一層就標哪些。
  const shared = new StateBackend({} as never);
  const composite = new CompositeBackend(new StateBackend({} as never), { '/shared/': shared });
  const routedToShared = (path: string): boolean => {
    const inner = composite as unknown as {
      getBackendAndKey(key: string): [unknown, string];
      readonly default: unknown;
    };
    return inner.getBackendAndKey(path)[0] !== inner.default;
  };

  it.each([
    '/shared/a.md',
    '/shared/sub/b.md',
    '/shared',
    '/shared/',
    '/shared/../x.md',
    'shared/a.md',
    './shared/a.md',
    '/x/../shared/a.md',
    '//shared/a.md',
    '/sharedx/a.md',
    '/own.md',
    '/attachments/a.png',
    '/large_tool_results/abc-read_file.txt',
    '/',
  ])('%s', async (path) => {
    const result = await through('read_file', { file_path: path }, message('     1\tbody'));
    const marked = String(textOf(result)).startsWith(NOTICE);
    expect(marked).toBe(routedToShared(path));
  });

  it('前提：上面那張表兩邊都有（不是全標或全不標）', () => {
    expect(routedToShared('/shared/a.md')).toBe(true);
    expect(routedToShared('/shared')).toBe(true);
    expect(routedToShared('shared/a.md')).toBe(false);
    expect(routedToShared('/sharedx/a.md')).toBe(false);
  });
});

describe('read_file', () => {
  it('字串結果：前綴、空一行、本文', async () => {
    const result = await through(
      'read_file',
      { file_path: '/shared/a.md' },
      message('     1\tbody'),
    );
    expect(textOf(result)).toBe(`${NOTICE}\n\n     1\tbody`);
  });

  it('一塊文字的陣列（read_file 的文字結果）：前綴併進那一塊，仍是一塊', async () => {
    const block = { type: 'text', text: '     1\tbody' };
    const result = await through('read_file', { file_path: '/shared/a.md' }, message([block]));
    expect(textOf(result)).toEqual([{ type: 'text', text: `${NOTICE}\n\n     1\tbody` }]);
  });

  it('內容塊陣列（第一塊是圖片）：最前面多一塊前綴文字塊，其餘原樣', async () => {
    const image = { type: 'image', mimeType: 'image/png', data: 'AAAA' };
    const result = await through(
      'read_file',
      { file_path: '/shared/a.png' },
      message([image] as never),
    );
    expect(textOf(result)).toEqual([{ type: 'text', text: NOTICE }, image]);
  });

  it('參數用別名 path 也認', async () => {
    const result = await through('read_file', { path: '/shared/a.md' }, message('     1\tbody'));
    expect(String(textOf(result)).startsWith(NOTICE)).toBe(true);
  });

  it('只換內容：id、狀態、artifact 與兩份 kwargs 原樣帶過去', async () => {
    const original = new ToolMessage({
      content: 'body',
      tool_call_id: 'call-1',
      name: 'read_file',
      id: 'msg-1',
      artifact: { raw: true },
      additional_kwargs: { k: 1 },
      response_metadata: { r: 2 },
    });
    const result = (await through(
      'read_file',
      { file_path: '/shared/a.md' },
      original,
    )) as ToolMessage;
    expect(result).not.toBe(original);
    expect({
      id: result.id,
      tool_call_id: result.tool_call_id,
      name: result.name,
      status: result.status,
      artifact: result.artifact,
      additional_kwargs: result.additional_kwargs,
      response_metadata: result.response_metadata,
    }).toEqual({
      id: 'msg-1',
      tool_call_id: 'call-1',
      name: 'read_file',
      status: original.status,
      artifact: { raw: true },
      additional_kwargs: { k: 1 },
      response_metadata: { r: 2 },
    });
  });

  it.each([
    ['空檔（基座原句）', message(EMPTY_CONTENT_WARNING)],
    [
      '空檔（backend 回那句、基座編了行號）',
      message([{ type: 'text', text: `     1\t${EMPTY_CONTENT_WARNING}` }]),
    ],
    ['失敗', message([{ type: 'text', text: 'Error: not found' }], 'error')],
    ['空結果', message('')],
    ['空文字塊（backend 回空字串，基座交出一塊空文字）', message([{ type: 'text', text: '' }])],
  ])('%s：原樣', async (_label, result) => {
    expect(await through('read_file', { file_path: '/shared/a.md' }, result)).toBe(result);
  });

  it('不是 ToolMessage（Command）：原樣', async () => {
    const command = new Command({ update: {} });
    expect(await through('read_file', { file_path: '/shared/a.md' }, command)).toBe(command);
  });
});

describe('grep', () => {
  const mixed = '/own.md:\n  1: hit\n/shared/ref.md:\n  2: hit';

  it.each([
    ['缺省模式', {}],
    ['content 模式', { output_mode: 'content' }],
  ])('%s：命中有一個檔在共用區，整則開頭標一次', async (_label, args) => {
    const result = await through('grep', { pattern: 'hit', path: '/', ...args }, message(mixed));
    expect(textOf(result)).toBe(`${NOTICE}\n\n${mixed}`);
  });

  it('命中都在私有根：原樣', async () => {
    const result = message('/own.md:\n  1: hit\n/sharedx/a.md:\n  1: hit');
    expect(await through('grep', { pattern: 'hit' }, result)).toBe(result);
  });

  it('命中的那一行內容像共用區檔名（縮排的）：不算', async () => {
    const result = message('/own.md:\n  1: /shared/ref.md:');
    expect(await through('grep', { pattern: 'ref' }, result)).toBe(result);
  });

  it.each(['files_with_matches', 'count'])('%s 模式：原樣', async (mode) => {
    const result = message('/shared/ref.md:');
    expect(await through('grep', { pattern: 'x', output_mode: mode }, result)).toBe(result);
  });

  it('沒有命中、失敗：原樣', async () => {
    const none = message("No matches found for pattern 'x'");
    const failed = message('/shared/ref.md:\n  1: x', 'error');
    expect(await through('grep', { pattern: 'x' }, none)).toBe(none);
    expect(await through('grep', { pattern: 'x' }, failed)).toBe(failed);
  });
});

describe('技能來源底下不標', () => {
  const skilled = (
    createSharedReadMarkMiddleware('/shared', ['/shared/skills/', '/plugin/skills']) as unknown as {
      wrapToolCall: Wrapper;
    }
  ).wrapToolCall;
  const run = (name: string, args: Record<string, unknown>, result: unknown) =>
    skilled({ toolCall: { name, args, id: 'call-1' }, state: {}, runtime: {} }, async () => result);

  it.each([
    ['SKILL.md', '/shared/skills/demo/SKILL.md', false],
    ['同目錄的腳本', '/shared/skills/demo/run.sh', false],
    ['來源目錄本身', '/shared/skills', false],
    ['名字只是前綴相同', '/shared/skillsx/a.md', true],
    ['共用區其他檔', '/shared/ref.md', true],
  ])('read_file %s', async (_label, path, expected) => {
    const result = await run('read_file', { file_path: path }, message('     1\tbody'));
    expect(String(textOf(result)).startsWith(NOTICE)).toBe(expected);
  });

  it('grep 命中只在技能目錄：原樣', async () => {
    const result = message('/shared/skills/demo/SKILL.md:\n  1: hit');
    expect(await run('grep', { pattern: 'hit' }, result)).toBe(result);
  });

  it('grep 命中混著技能目錄與共用區其他檔：整則開頭標一次', async () => {
    const mixed = '/shared/skills/demo/SKILL.md:\n  1: hit\n/shared/ref.md:\n  2: hit';
    const result = await run('grep', { pattern: 'hit' }, message(mixed));
    expect(textOf(result)).toBe(`${NOTICE}\n\n${mixed}`);
  });
});

it.each(['glob', 'ls', 'write_file', 'edit_file'])('%s：不看', async (name) => {
  const result = message('/shared/ref.md:');
  expect(await through(name, { path: '/shared', file_path: '/shared/a.md' }, result)).toBe(result);
});
