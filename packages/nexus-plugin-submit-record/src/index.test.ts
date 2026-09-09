/**
 * `submit_record` 的單元面：**對欄名**、**未知欄名要拒絕**、**`filesUpdate` 那一支**，
 * 加上閘門的兩格（認得它 / 不認得別人）。
 *
 * backend 在這裡是假的，因為這一層驗的是「拿到什麼就寫出什麼」，不是磁碟。真的走線、
 * 真的核准卡、真的讀檔那一份在 `apps/harness/src/submit-record-wire.test.ts`。
 */

import type { StructuredTool } from '@langchain/core/tools';
import { loadPlugins, runApprovalGate } from '@nexus/core';
import type { AnyBackendProtocol, FileData, WriteResult } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { createSubmitRecordPlugin, SUBMIT_RECORD_TOOL_NAME } from './index.js';

/**
 * 一個記在物件裡的假 backend。
 *
 * `checkpoint` 開著時它學 `StateBackend`：`write` 回一份 `filesUpdate`，寫入要靠那份
 * state update 才算數。關著時學 `FilesystemBackend`：已經落盤了，`filesUpdate` 是 null。
 */
function fakeBackend(seed: Record<string, string> = {}, checkpoint = false) {
  const files = new Map(Object.entries(seed));
  const backend = {
    readRaw: (filePath: string) => {
      const content = files.get(filePath);
      if (content === undefined) return { error: `File '${filePath}' not found` };
      return { data: { content, mimeType: 'text/csv', created_at: '', modified_at: '' } };
    },
    write: (filePath: string, content: string): WriteResult => {
      files.set(filePath, content);
      return {
        path: filePath,
        filesUpdate: checkpoint
          ? ({
              [filePath]: { content, mimeType: 'text/csv', created_at: '', modified_at: '' },
            } as Record<string, FileData>)
          : null,
      };
    },
  };
  return { files, backend: backend as unknown as AnyBackendProtocol };
}

async function toolOf(backend: AnyBackendProtocol): Promise<StructuredTool> {
  const { registry } = await loadPlugins([createSubmitRecordPlugin({ backend })]);
  const entry = registry.tools.resolve(SUBMIT_RECORD_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒有註冊上去');
  return entry.value;
}

/** 工具實際回的東西。`Command` 那一支不是 ToolMessage，所以這裡不預設形狀。 */
async function call(tool: StructuredTool, args: unknown): Promise<unknown> {
  return tool.invoke(args as never);
}

/** 斷言這是一則 `status: 'error'` 的 ToolMessage，並回它的內容。 */
function errorTextOf(result: unknown): string {
  const message = result as { status?: string; content?: unknown };
  expect(message.status).toBe('error');
  return String(message.content);
}

describe('寫出一列', () => {
  it('檔案不存在時用這次的鍵當表頭建起來', async () => {
    const { files, backend } = fakeBackend();
    await call(await toolOf(backend), {
      file_path: '/visitors.csv',
      record: { 姓名: '阿明', 日期: '週二' },
    });
    expect(files.get('/visitors.csv')).toBe('姓名,日期\n阿明,週二\n');
  });

  it('**欄序由檔案的表頭決定，不由這次的鍵序決定**', async () => {
    const { files, backend } = fakeBackend({ '/v.csv': '姓名,日期\n小美,週一\n' });
    await call(await toolOf(backend), {
      // 故意把鍵序倒過來——照鍵序寫的話這一列會錯位，而且錯得沒有人會發現。
      file_path: '/v.csv',
      record: { 日期: '週二', 姓名: '阿明' },
    });
    expect(files.get('/v.csv')).toBe('姓名,日期\n小美,週一\n阿明,週二\n');
  });

  it('表頭有而這次沒給的欄位補空字串', async () => {
    const { files, backend } = fakeBackend({ '/v.csv': '姓名,日期,備註\n' });
    await call(await toolOf(backend), { file_path: '/v.csv', record: { 姓名: '阿明' } });
    expect(files.get('/v.csv')).toBe('姓名,日期,備註\n阿明,,\n');
  });

  it('值裡的逗號與引號寫出去讀得回來', async () => {
    const { files, backend } = fakeBackend();
    await call(await toolOf(backend), {
      file_path: '/v.csv',
      record: { 姓名: '甲,乙', 備註: '他說"好"' },
    });
    expect(files.get('/v.csv')).toBe('姓名,備註\n"甲,乙","他說""好"""\n');
  });
});

describe('拒絕的那幾條', () => {
  it('**表頭沒有的欄名是錯誤，不是靜靜丟掉**', async () => {
    const { files, backend } = fakeBackend({ '/v.csv': '姓名,日期\n' });
    const text = errorTextOf(
      await call(await toolOf(backend), {
        file_path: '/v.csv',
        record: { 姓名: '阿明', 電話: '0900' },
      }),
    );
    expect(text).toContain('電話');
    // 承重的是這一行：**沒有寫**。丟掉那一格的話，這裡會是一列寫成功而電話不見了。
    expect(files.get('/v.csv')).toBe('姓名,日期\n');
  });

  it('空的 `record` 不寫', async () => {
    const { files, backend } = fakeBackend();
    errorTextOf(await call(await toolOf(backend), { file_path: '/v.csv', record: {} }));
    expect(files.has('/v.csv')).toBe(false);
  });

  it('**`readRaw` 用拋的時候當作「還沒有這個檔案」**，不是讓它逃出去', async () => {
    // 基座的 `FilesystemBackend` 就是這樣：`read()` 回結構化錯誤，`readRaw()` 直接拋
    // ENOENT（實測，絆索在 `apps/harness/src/submit-record-wire.test.ts`）。而這個工具
    // 每一次執行都在 resume 那一輪——拋出去等於整場 run 死。
    const written: string[] = [];
    const backend = {
      readRaw: () => {
        throw new Error("ENOENT: no such file or directory, stat '/v.csv'");
      },
      write: (_path: string, content: string) => {
        written.push(content);
        return { path: '/v.csv', filesUpdate: null };
      },
    };
    const result = (await call(await toolOf(backend as unknown as AnyBackendProtocol), {
      file_path: '/v.csv',
      record: { 姓名: '阿明' },
    })) as { status?: string };
    expect(result.status).toBeUndefined();
    expect(written).toEqual(['姓名\n阿明\n']);
  });

  it('backend 寫不進去時回錯誤，而且帶著它說的理由', async () => {
    const backend = { write: () => ({ error: '沒有權限' }), readRaw: () => ({ error: 'nope' }) };
    const text = errorTextOf(
      await call(await toolOf(backend as unknown as AnyBackendProtocol), {
        file_path: '/v.csv',
        record: { 姓名: '阿明' },
      }),
    );
    expect(text).toContain('沒有權限');
  });
});

describe('checkpoint backend 那一支', () => {
  it('**`filesUpdate` 要包成 `Command`**——只回 ToolMessage 的話 state 裡什麼都沒有', async () => {
    const { backend } = fakeBackend({}, true);
    const result = (await call(await toolOf(backend), {
      file_path: '/v.csv',
      record: { 姓名: '阿明' },
    })) as { update?: { files?: Record<string, unknown>; messages?: unknown[] } };
    // 沒有 `--workspace` 的組裝走的就是這一支（`StateBackend`），漏掉它的樣子是
    // 「工具說寫好了、檔案系統裡沒有這個檔」。
    expect(Object.keys(result.update?.files ?? {})).toEqual(['/v.csv']);
    expect(result.update?.messages).toHaveLength(1);
  });

  it('外部 backend 回 null 時就回 ToolMessage', async () => {
    const { backend } = fakeBackend();
    const result = (await call(await toolOf(backend), {
      file_path: '/v.csv',
      record: { 姓名: '阿明' },
    })) as { status?: string; content?: unknown; update?: unknown };
    expect(result.update).toBeUndefined();
    expect(result.status).toBeUndefined();
    expect(String(result.content)).toContain('/v.csv');
  });
});

describe('閘門只認 submit_record', () => {
  it('認得它 → `ask`；別人 → 走到鏈底 `allow`', async () => {
    const { backend } = fakeBackend();
    const { registry } = await loadPlugins([createSubmitRecordPlugin({ backend })]);
    const listeners = registry.approvals.listeners();

    const mine = await runApprovalGate(listeners, {
      name: SUBMIT_RECORD_TOOL_NAME,
      args: {},
      callId: 'c1',
    });
    expect(mine.kind).toBe('ask');

    // **這一格是「只認它」的否定面。** 少了它，`() => ({ kind: 'ask' })` 這種把所有工具
    // 都攔下來的寫法一條測試都不會紅。
    const other = await runApprovalGate(listeners, { name: 'write_file', args: {}, callId: 'c2' });
    expect(other.kind).toBe('allow');
  });
});
