/**
 * `tool-result-meta.ts` 自己的邏輯（[#617](https://github.com/DemianLi/nexus-agent/issues/617)）：hunk 的算法、槽的
 * 規則、圍堵怎麼把槽裡的東西寫進 `tool/result`。
 *
 * 掛進真的組裝、真的基座工具跑完之後日誌上長什麼樣，由 `apps/harness/src/tool-result-meta.test.ts` 量。
 * 這裡量的是**產品路徑上今天碰不到、但規則要守住的那幾條**：別顆工具在自己的呼叫裡打 backend、
 * 失敗的呼叫手上有 meta、圍堵外面的 backend 呼叫。
 */

import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { createContainmentMiddleware } from './containment.js';
import { SessionLog } from './session-log.js';
import {
  computeHunkDiffs,
  putToolResultMeta,
  recordToolResultMeta,
  runInToolMetaSlot,
} from './tool-result-meta.js';

describe('computeHunkDiffs（逐行照抄 dsh）', () => {
  it('一個 hunk：上下文加 `-` 行對上下文加 `+` 行', () => {
    expect(computeHunkDiffs('/a', 'a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { path: '/a', oldText: 'a\nb\nc', newText: 'a\nB\nc' },
    ]);
  });

  it('純新增：oldText 是 null', () => {
    expect(computeHunkDiffs('/a', '', 'x\ny\n')).toEqual([
      { path: '/a', oldText: null, newText: 'x\ny' },
    ]);
  });

  it('沒有結尾換行的記號不進內容', () => {
    expect(computeHunkDiffs('/a', 'a', 'b')).toEqual([{ path: '/a', oldText: 'a', newText: 'b' }]);
  });

  it('兩邊相同就是空陣列', () => {
    expect(computeHunkDiffs('/a', 'a\n', 'a\n')).toEqual([]);
  });
});

/** 一個假的 backend：記下 `readRaw` 被叫了幾次，`write` 永遠成功。 */
function fakeBackend(existing?: string) {
  const calls = { readRaw: 0, write: 0 };
  const backend = {
    async readRaw() {
      calls.readRaw += 1;
      return existing === undefined
        ? { error: 'not found' }
        : { data: { content: existing, mimeType: 'text/plain' } };
    },
    async write(path: string, _content: string) {
      calls.write += 1;
      return { path };
    },
    async read() {
      return { content: '' };
    },
  };
  return { calls, backend: recordToolResultMeta(backend, { search: true }) };
}

describe('槽', () => {
  it('只認自己那顆工具：別顆工具在自己的呼叫裡寫檔，不帶 write_file 的 meta', async () => {
    const { backend } = fakeBackend();
    const other = await runInToolMetaSlot('submit_record', {}, () => backend.write('/x', 'y'));
    expect(other.meta).toBeUndefined();
    const own = await runInToolMetaSlot('write_file', {}, () => backend.write('/x', 'y'));
    expect(own.meta).toEqual({ operation: 'create', diffs: [] });
  });

  it('只寫一次：同一次呼叫裡的第二次 backend 呼叫不是工具那一次', async () => {
    const { backend } = fakeBackend('a\n');
    const { meta } = await runInToolMetaSlot('write_file', {}, async () => {
      await backend.write('/x', 'b\n');
      putToolResultMeta('write_file', { diffs: [], operation: 'create' });
    });
    expect(meta).toMatchObject({ operation: 'update' });
  });

  it('圍堵外面（摘要器 offload、結果暫存）：不讀原檔、什麼都不放', async () => {
    const { backend, calls } = fakeBackend('a\n');
    await backend.write('/large_tool_results/x', 'b\n');
    expect(calls).toEqual({ readRaw: 0, write: 1 });
  });

  it('讀原檔拋的不是 ENOENT、或讀到的是位元組：不知道是新建還是覆寫，整格不給', async () => {
    for (const readRaw of [
      async () => {
        throw Object.assign(new Error('是目錄'), { code: 'EISDIR' });
      },
      async () => ({ data: { content: new Uint8Array([1, 2]), mimeType: 'image/png' } }),
    ]) {
      const backend = recordToolResultMeta(
        { readRaw, write: async (path: string, _content: string) => ({ path }) },
        { search: true },
      );
      const { meta } = await runInToolMetaSlot('write_file', {}, () => backend.write('/x', 'y'));
      expect(meta).toBeUndefined();
    }
  });

  it('落磁碟的缺檔直接拋 ENOENT：算新建', async () => {
    const backend = recordToolResultMeta(
      {
        readRaw: async () => {
          throw Object.assign(new Error('沒有'), { code: 'ENOENT' });
        },
        write: async (path: string, _content: string) => ({ path }),
      },
      { search: true },
    );
    const { meta } = await runInToolMetaSlot('write_file', {}, () => backend.write('/x', 'y'));
    expect(meta).toEqual({ operation: 'create', diffs: [] });
  });
});

describe('圍堵把槽裡的東西寫進 `tool/result`', () => {
  /** 一顆會把事件記進 `log` 的圍堵的 `wrapToolCall`。 */
  function recorder(log: SessionLog) {
    const middleware = createContainmentMiddleware({
      forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log }),
    }) as unknown as {
      wrapToolCall: (request: unknown, handler: () => Promise<unknown>) => Promise<unknown>;
    };
    return middleware.wrapToolCall;
  }

  const request = {
    toolCall: { name: 'probe', args: {}, id: 'call-1' },
    tool: { name: 'probe' },
    state: {},
    runtime: { configurable: { checkpoint_ns: 'tools:x' } },
  };

  function lastResult(log: SessionLog): Record<string, unknown> {
    const found = log.events.filter((event) => event.type === 'tool/result').at(-1);
    if (found === undefined) throw new Error('沒有 tool/result');
    return found.data as Record<string, unknown>;
  }

  it('成功：帶上產生者放的那一份', async () => {
    const log = new SessionLog('s');
    await recorder(log)(request, async () => {
      putToolResultMeta('probe', { shape: 'paths', paths: ['/a'], truncated: false, total: 1 });
      return new ToolMessage({ content: '/a', tool_call_id: 'call-1', name: 'probe' });
    });
    expect(lastResult(log).meta).toEqual({
      shape: 'paths',
      paths: ['/a'],
      truncated: false,
      total: 1,
    });
  });

  it('沒有產生者：整個不放這一格', async () => {
    const log = new SessionLog('s');
    await recorder(log)(
      request,
      async () => new ToolMessage({ content: '好了', tool_call_id: 'call-1', name: 'probe' }),
    );
    expect(lastResult(log)).not.toHaveProperty('meta');
  });

  it('**失敗的不帶**，即使產生者已經放了（內層在放完之後才把結果改判成失敗）', async () => {
    const log = new SessionLog('s');
    await recorder(log)(request, async () => {
      putToolResultMeta('probe', { diffs: [] });
      return new ToolMessage({
        content: 'Error: 被擋下',
        tool_call_id: 'call-1',
        name: 'probe',
        status: 'error',
      });
    });
    expect(lastResult(log)).toMatchObject({ isError: true });
    expect(lastResult(log)).not.toHaveProperty('meta');
  });

  it('拋錯的也不帶', async () => {
    const log = new SessionLog('s');
    await recorder(log)(request, async () => {
      putToolResultMeta('probe', { diffs: [] });
      throw new Error('炸了');
    });
    expect(lastResult(log)).toMatchObject({ isError: true });
    expect(lastResult(log)).not.toHaveProperty('meta');
  });
});
