/**
 * 檔案工具失敗標成錯誤的那一層自己的邏輯——直接餵 middleware 一個假 `handler`，`handler` 照基座
 * 檔案工具的樣子叫包過的 backend、把結果包成狀態成功的 ToolMessage。「fold 有沒有把它打底進去、
 * 排在哪」在 `fold.test.ts`；「掛進真的 agent、真的 fence 之後」在 `apps/harness/src/fs-tool-errors.test.ts`。
 */

import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  createFsToolErrorsMiddleware,
  FS_SANDBOX_DENIED,
  noteSandboxDenial,
  recordBackendOutcomes,
} from './fs-tool-errors.js';
import { toolErrorOf } from './tool-events.js';

/** middleware 的 `wrapToolCall` 拿出來直接呼叫用的形狀。 */
type Wrapper = (
  request: unknown,
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

function wrapperOf(middleware: unknown): Wrapper {
  const wrap = (middleware as { wrapToolCall?: Wrapper }).wrapToolCall;
  if (wrap === undefined) throw new Error('這個 middleware 沒有 wrapToolCall');
  return wrap;
}

function requestFor(name: string, id = 'call-1'): unknown {
  return { toolCall: { name, args: {}, id }, state: {}, runtime: {} };
}

/** 基座把工具回的東西包成的那則訊息——**狀態成功**，就算內容是錯誤。 */
function asToolMessage(content: ToolMessage['content'], name: string, id = 'call-1'): ToolMessage {
  return new ToolMessage({ content, tool_call_id: id, name });
}

/**
 * 一個假 backend。`#files` 是私有欄位：包過之後方法要以原物件為 `this` 才讀得到它。
 * `/deny/` 底下的變更照 fence 的樣子回報拒絕，`/broken` 照基座的樣子回一個一般錯誤。
 */
class FakeBackend {
  readonly routePrefixes = ['/memories/'];
  #files = new Map<string, string>();

  async write(path: string, content: string): Promise<{ path?: string; error?: string }> {
    if (path.startsWith('/deny/')) {
      noteSandboxDenial();
      return { error: `[containment] 拒絕 write "${path}"` };
    }
    if (path === '/broken') return { error: `Failed to write to ${path}` };
    this.#files.set(path, content);
    return { path };
  }

  async read(path: string): Promise<{ content?: string; error?: string }> {
    const content = this.#files.get(path);
    return content === undefined ? { error: `File '${path}' not found` } : { content };
  }

  async ls(path: string): Promise<{ files?: string[]; error?: string }> {
    return path === '/a-file' ? { error: 'not a directory' } : { files: [] };
  }

  async delete(path: string): Promise<{ path?: string; error?: string }> {
    if (path.startsWith('/deny/')) {
      noteSandboxDenial();
      return { error: `[containment] 拒絕 delete "${path}"` };
    }
    return { path };
  }

  size(): number {
    return this.#files.size;
  }
}

describe('檔案工具的失敗標成錯誤', () => {
  const wrap = wrapperOf(createFsToolErrorsMiddleware());

  it('主要方法回錯：換成錯誤，**模型看到的字一字不變**、不帶碼', async () => {
    const backend = recordBackendOutcomes(new FakeBackend());
    const result = (await wrap(requestFor('write_file'), async () => {
      const out = await backend.write('/broken', 'x');
      return asToolMessage(out.error ?? 'ok', 'write_file');
    })) as ToolMessage;
    expect(result.status).toBe('error');
    expect(result.content).toBe('Failed to write to /broken');
    expect(result.tool_call_id).toBe('call-1');
    expect(result.name).toBe('write_file');
    expect(toolErrorOf(result)).toBeUndefined();
  });

  it('fence 擋下：帶 `FS_SANDBOX_DENIED`', async () => {
    const backend = recordBackendOutcomes(new FakeBackend());
    const result = (await wrap(requestFor('write_file'), async () => {
      const out = await backend.write('/deny/x', 'x');
      return asToolMessage(out.error ?? 'ok', 'write_file');
    })) as ToolMessage;
    expect(result.status).toBe('error');
    expect(result.content).toBe('[containment] 拒絕 write "/deny/x"');
    expect(toolErrorOf(result)).toEqual({ name: 'FsError', code: FS_SANDBOX_DENIED });
  });

  it('`read_file` 那種文字塊的內容原樣保留', async () => {
    const backend = recordBackendOutcomes(new FakeBackend());
    const blocks = [{ type: 'text' as const, text: "Error: File '/nope' not found" }];
    const result = (await wrap(requestFor('read_file'), async () => {
      await backend.read('/nope');
      return asToolMessage(blocks, 'read_file');
    })) as ToolMessage;
    expect(result.status).toBe('error');
    expect(result.content).toEqual(blocks);
  });

  it('成功的原樣放行——連「一個都沒找到」那種成功也是', async () => {
    const backend = recordBackendOutcomes(new FakeBackend());
    const written = asToolMessage("Successfully wrote to '/a'", 'write_file');
    expect(
      await wrap(requestFor('write_file'), async () => {
        await backend.write('/a', 'x');
        return written;
      }),
    ).toBe(written);
    const empty = asToolMessage('No files found in /', 'ls');
    expect(
      await wrap(requestFor('ls'), async () => {
        await backend.ls('/');
        return empty;
      }),
    ).toBe(empty);
  });

  it('**只看主要那個方法**：`delete` 先 `ls` 探一下回的錯是它的判斷依據，不是失敗', async () => {
    const backend = recordBackendOutcomes(new FakeBackend());
    const deleted = asToolMessage('Deleted /a-file', 'delete');
    const result = await wrap(requestFor('delete'), async () => {
      await backend.ls('/a-file');
      await backend.delete('/a-file');
      return deleted;
    });
    expect(result).toBe(deleted);
  });

  it('已經是錯誤的：沒有碼要補就原樣交出，fence 擋的換一則帶碼的、字不變', async () => {
    const backend = recordBackendOutcomes(new FakeBackend());
    const baseError = new ToolMessage({
      content: 'Error deleting',
      tool_call_id: 'call-1',
      name: 'delete',
      status: 'error',
    });
    // 一般失敗（這裡用一個假的 backend 錯誤撐起「主要方法失敗」）。
    const failing = recordBackendOutcomes({
      delete: async () => ({ error: 'Error deleting' }),
    });
    expect(
      await wrap(requestFor('delete'), async () => {
        await failing.delete();
        return baseError;
      }),
    ).toBe(baseError);

    const denied = (await wrap(requestFor('delete'), async () => {
      const out = await backend.delete('/deny/x');
      return new ToolMessage({
        content: out.error ?? '',
        tool_call_id: 'call-1',
        name: 'delete',
        status: 'error',
      });
    })) as ToolMessage;
    expect(denied.status).toBe('error');
    expect(denied.content).toBe('[containment] 拒絕 delete "/deny/x"');
    expect(toolErrorOf(denied)?.code).toBe(FS_SANDBOX_DENIED);
  });

  it('平行的兩次呼叫各記各的：一顆失敗不會把另一顆標成錯誤', async () => {
    const backend = recordBackendOutcomes(new FakeBackend());
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failing = wrap(requestFor('write_file', 'call-f'), async () => {
      const out = await backend.write('/deny/x', 'x');
      await gate;
      return asToolMessage(out.error ?? 'ok', 'write_file', 'call-f');
    });
    const succeeding = wrap(requestFor('write_file', 'call-s'), async () => {
      await gate;
      await backend.write('/fine', 'x');
      return asToolMessage("Successfully wrote to '/fine'", 'write_file', 'call-s');
    });
    release();
    const [bad, good] = (await Promise.all([failing, succeeding])) as ToolMessage[];
    expect(bad?.status).toBe('error');
    expect(toolErrorOf(bad)?.code).toBe(FS_SANDBOX_DENIED);
    expect(good?.status).not.toBe('error');
    expect(toolErrorOf(good)).toBeUndefined();
  });

  it('不是檔案工具的呼叫不動——就算它在底下碰了 backend、fence 也喊了拒絕', async () => {
    const backend = recordBackendOutcomes(new FakeBackend());
    const message = asToolMessage('done', 'task');
    expect(
      await wrap(requestFor('task'), async () => {
        await backend.write('/deny/x', 'x');
        return message;
      }),
    ).toBe(message);
  });
});

describe('包過的 backend', () => {
  it('轉交的是同一個實例：私有欄位讀得到、非方法的屬性照讀、不在任何呼叫裡也照常運作', async () => {
    const inner = new FakeBackend();
    const backend = recordBackendOutcomes(inner);
    await backend.write('/a', 'x');
    expect(inner.size()).toBe(1);
    expect(backend.size()).toBe(1);
    expect(backend.routePrefixes).toEqual(['/memories/']);
    expect(backend).toBeInstanceOf(FakeBackend);
    // 不在任何一次檔案工具呼叫裡：fence 喊拒絕也不拋。
    expect(await backend.write('/deny/x', 'x')).toEqual({
      error: '[containment] 拒絕 write "/deny/x"',
    });
  });
});
