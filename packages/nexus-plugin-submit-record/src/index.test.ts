/**
 * `submit_record` 的單元面：**對欄名**、**未知欄名要拒絕**、**`filesUpdate` 那一支**，
 * 加上閘門的兩格（認得它 / 不認得別人），以及（#1466 起）它在 Cordis 樹上的那一列。
 *
 * backend 在這裡是假的，因為這一層驗的是「拿到什麼就寫出什麼」，不是磁碟。真的走線、
 * 真的核准卡、真的讀檔那一份在 `apps/harness/src/submit-record-wire.test.ts`；樹上兩條 thread 同時活著的每一種呼叫形狀在
 * `apps/harness/src/submit-record-on-tree.test.ts`。
 *
 * **測試檔不受 SDK lint 管**（`PLUGIN_LINT_IGNORES`），所以這裡可以 import `@nexus/core` 的 `runApprovalGate`；`src/index.ts` 不行。
 */

import type { StructuredTool } from '@langchain/core/tools';
import { runApprovalGate } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { fsToken } from '@nexus/fs';
import type { FsLookup, FsService } from '@nexus/fs';
import { createFsLookupProvider } from '@nexus/fs/provider';
import { checkConformance, ContractService, defineToken, FIBER_STATE } from '@nexus/sdk';
import type { ToolRegistry } from '@nexus/tools';
import { createToolsProvider } from '@nexus/tools/provider';
import type { AnyBackendProtocol, FileData, WriteResult } from 'deepagents';
import { afterEach, describe, expect, it } from 'vitest';

import * as submitRecord from './index.js';
import { SUBMIT_RECORD_NO_BACKEND_MESSAGE, SUBMIT_RECORD_TOOL_NAME } from './index.js';

const opened: Context[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
});

/** 一格 fs 把手：`backend()` 在呼叫當下才讀（同 core 的 `createFsService`）。 */
function fsHandle(backend: AnyBackendProtocol | undefined): FsService {
  return { backend: () => backend, offWorkspacePrefixes: () => [], hasWorkspace: () => true };
}

/** 一個永遠認得這次呼叫的 fs 查找（單元面不驗挑法，挑法在 core 與宿主那邊量）。 */
function alwaysOk(handle: FsService): (config: unknown) => FsLookup {
  return () => ({
    kind: 'ok',
    fs: handle,
    address: { kind: 'root' } as never,
  });
}

/** 掛一棵小樹：工具登記處、fs 查找（`lookup` 是宿主的挑法）與 `submit-record` 那一列。 */
async function mount(lookup: (config: unknown) => FsLookup): Promise<{
  root: Context;
  tools: ReturnType<typeof createToolsProvider>;
  tool: StructuredTool;
}> {
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
  const entry = tools.entries().find((item) => item.tool.name === SUBMIT_RECORD_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒有註冊上去');
  return { root, tools, tool: entry.tool as StructuredTool };
}

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
  return (await mount(alwaysOk(fsHandle(backend)))).tool;
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

/**
 * **拿不到 backend 就響亮地拒絕，不退回自建的 `StateBackend`**（[#687](https://github.com/DemianLi/nexus-agent/issues/687)）。
 *
 * 以前的退路寫進 state 也照樣回「已經寫進」，而那時 `write_file` 可能正寫在磁碟上——兩邊都成功、一條測試都不紅。
 * 載體在工具被叫時才讀，所以拒絕的時刻是那一次呼叫，載入照樣成功。
 */
describe('拿不到 backend', () => {
  it.each([
    [
      '沒有任何一條 thread 登記（`fs` 查找回 not-attached）',
      () => ({ kind: 'not-attached' }) as FsLookup,
    ],
    ['認不出這次呼叫（unknown-caller）', () => ({ kind: 'unknown-caller' }) as FsLookup],
    ['多條 thread 挑不出（ambiguous）', () => ({ kind: 'ambiguous', count: 2 }) as FsLookup],
    ['`fs` 把手在、裡面沒有 backend', alwaysOk(fsHandle(undefined))],
  ])('%s：那一次呼叫拒絕，訊息指名 submit-record 與 backend', async (_label, lookup) => {
    const { tool } = await mount(lookup);
    const result = await call(tool, { file_path: '/v.csv', record: { 姓名: '阿明' } });
    // 回的是一則錯誤訊息，不是 `Command`：沒有任何 state update 帶著這一列出去。
    expect((result as { update?: unknown }).update).toBeUndefined();
    const text = errorTextOf(result);
    expect(text).toBe(`Error: ${SUBMIT_RECORD_NO_BACKEND_MESSAGE}`);
    expect(text).toContain('submit-record');
    expect(text).toContain('backend');
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
    const { tools } = await mount(alwaysOk(fsHandle(backend)));
    // 樹上的閘門住在 tools 提供者的 `gates()`（來源是登記它的那一列）；折進 thread 的 `registry.approvals` 是宿主的事
    // （`apps/harness/src/submit-record-on-tree.test.ts` 與 `approval-gate-order.test.ts` 量）。
    const gates = tools.gates();
    expect(gates.map((gate) => gate.source)).toEqual(['submit-record']);
    const listeners = gates.map((gate) => ({ value: gate.listener, origin: {} as never }));

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

describe('樹上這一列（#1466）', () => {
  it('一致性套件全格通過：manifest、匯出形式、卸載後登記處與閘門回到空的、缺提供者停在 PENDING', async () => {
    let latest = createToolsProvider();
    const failures = await checkConformance({
      row: 'submit-record',
      module: submitRecord,
      config: {},
      providers: {
        tools: () => {
          latest = createToolsProvider();
          return latest.Provider;
        },
        fs: () => createFsLookupProvider(() => ({ kind: 'not-attached' })).Provider,
      },
      residue: () => latest.entries().length + latest.gates().length,
    });
    expect(failures).toEqual([]);
  });

  it('manifest 宣告兩個必要依賴：tools（^1.2.0，要有 gate）與 fs（^1.0.0）；沒有 default 匯出', () => {
    expect(submitRecord.manifest.consumes).toEqual([
      { token: 'tools', range: '^1.2.0' },
      { token: fsToken.name, range: '^1.0.0' },
    ]);
    expect(submitRecord.manifest.provides).toEqual([]);
    expect(submitRecord.inject).toEqual({ tools: { range: '^1.2.0' }, fs: { range: '^1.0.0' } });
    expect('default' in submitRecord).toBe(false);
  });

  it('列卸載之後，抓進閉包的 fs 查找仍可問：已登記的那一份工具照樣寫得出去', async () => {
    const { backend, files } = fakeBackend();
    const { root, tool } = await mount(alwaysOk(fsHandle(backend)));
    await root.loader.resolve('fs').fiber?.ctx.fiber.dispose();
    expect(root.get('fs', false)).toBeUndefined();
    const result = await call(tool, { file_path: '/v.csv', record: { 姓名: '阿明' } });
    expect((result as { status?: string }).status).toBeUndefined();
    expect(files.get('/v.csv')).toBe('姓名\n阿明\n');
  });

  it('**tools 提供者比 1.2.0 舊時這一列不會起來**：不讓一個沒有閘門的 submit_record 掛上去', async () => {
    // 老範圍的提供者：契約版本 1.1.0、服務上沒有 `gate`。這一列宣告 `^1.2.0`，requires 階段就停在 PENDING，工具不會被註冊。
    const oldToken = defineToken<ToolRegistry>('tools', '1.1.0');
    const registered: string[] = [];
    class OldTools extends ContractService<ToolRegistry> implements ToolRegistry {
      constructor(ctx: Context) {
        super(ctx, oldToken);
      }
      register(tool: { name: string }): () => void {
        registered.push(tool.name);
        return () => undefined;
      }
      list(): readonly never[] {
        return [];
      }
    }
    const root = new Context();
    opened.push(root);
    await root.plugin(Loader);
    Object.assign(root.loader.builtins, {
      tools: OldTools,
      fs: createFsLookupProvider(() => ({ kind: 'not-attached' })).Provider,
      'submit-record': submitRecord,
    });
    const create = (options: { id: string; name: string; config?: unknown }) =>
      root.loader.create(options as never, null);
    await create({ id: 'tools', name: 'cordis:tools' });
    await create({ id: 'fs', name: 'cordis:fs' });
    await create({ id: 'submit-record', name: 'cordis:submit-record', config: {} });
    await root.loader.await();
    const state = root.loader.resolve('submit-record').fiber?.ctx.fiber.state;
    expect(state).not.toBe(FIBER_STATE.ACTIVE);
    expect(registered).toEqual([]);
  });
});
