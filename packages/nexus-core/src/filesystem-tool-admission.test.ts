/**
 * 檔案工具 `execute`、`delete` 的放行（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415) W3）：對著真的基座
 * `wrapModelCall` 比模型最後拿到的工具清單，另外直接看交給基座那一支之前已經拿掉了哪些（基座自己也會濾，只比最後的清單看不出
 * 這一格有沒有做事）。
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createFilesystemMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { filesystemModelCallWrap, filesystemToolAdmission } from './filesystem-tool-admission.js';

const files = {
  ls: async () => [],
  read: async () => '',
  readRaw: async () => ({ content: [], created_at: '', modified_at: '' }),
  glob: async () => [],
  grep: async () => [],
  edit: async () => ({}),
  write: async () => ({}),
};
const withDelete = { ...files, delete: async () => ({}) };
const sandbox = { ...files, id: 'box', execute: async () => ({ output: '', exitCode: 0 }) };
const sandboxWithDelete = { ...sandbox, delete: async () => ({}) };

type Request = {
  readonly tools: readonly { readonly name: string }[];
  readonly runtime: object;
  readonly state: object;
  readonly systemMessage: SystemMessage;
  readonly messages: readonly unknown[];
};

function requestWith(tools: readonly { readonly name: string }[]): Request {
  return {
    tools,
    runtime: {},
    state: { messages: [] },
    systemMessage: new SystemMessage('sys'),
    messages: [new HumanMessage('hi')],
  };
}

/** 基座自己建的工具（含 `execute`、`delete`）加一顆別的來源的工具。 */
function toolsOf(backend: object) {
  const base = createFilesystemMiddleware({ backend: backend as never });
  return [...(base.tools ?? []), { name: 'other' }] as readonly { readonly name: string }[];
}

const names = (tools: readonly { readonly name: string }[]) => tools.map((t) => t.name);

describe('filesystemModelCallWrap 對著基座的 wrapModelCall', () => {
  for (const [title, backend] of Object.entries({
    沒有執行也沒有刪除: files,
    能刪除: withDelete,
    能執行: sandbox,
    都能: sandboxWithDelete,
  })) {
    it(`${title}：模型拿到的工具清單與只掛基座時相同`, async () => {
      const base = createFilesystemMiddleware({ backend: backend as never });
      // 基座比的是 `delete` 的物件身分，所以工具要取同一顆建出來的。
      const tools = [...(base.tools ?? []), { name: 'other' }] as readonly {
        readonly name: string;
      }[];
      const inner = base.wrapModelCall as unknown as (
        r: Request,
        h: (r: Request) => Promise<Request>,
      ) => Promise<Request>;
      const seen = async (r: Request) => r;
      const fromBase = await inner(requestWith(tools), seen);
      const fromCore = await filesystemModelCallWrap(backend, inner)(requestWith(tools), seen);
      expect(names(fromCore.tools)).toEqual(names(fromBase.tools));
      expect(fromCore.systemMessage.content).toEqual(fromBase.systemMessage.content);
    });
  }
});

describe('交給基座那一支之前', () => {
  const recordInner = () => {
    const got: Request[] = [];
    const inner = async (r: Request) => {
      got.push(r);
      return r;
    };
    return { got, inner };
  };

  it('不能執行、不能刪除：execute 與 delete 已經拿掉，其餘照原順序', async () => {
    const { got, inner } = recordInner();
    const tools = toolsOf(files);
    await filesystemModelCallWrap(files, inner)(requestWith(tools), undefined);
    expect(names(got[0]!.tools)).toEqual(
      names(tools).filter((n) => n !== 'execute' && n !== 'delete'),
    );
  });

  it('都能：一顆都沒拿掉，交下原本的請求物件', async () => {
    const { got, inner } = recordInner();
    const request = requestWith(toolsOf(sandboxWithDelete));
    await filesystemModelCallWrap(sandboxWithDelete, inner)(request, undefined);
    expect(got[0]).toBe(request);
  });

  it('每次呼叫現讀 backend 的能力，不在建好時拍快照', async () => {
    const { got, inner } = recordInner();
    let current: object = files;
    const factory = () => current;
    const wrapped = filesystemModelCallWrap(factory, inner);
    const tools = toolsOf(sandboxWithDelete);
    await wrapped(requestWith(tools), undefined);
    current = sandboxWithDelete;
    await wrapped(requestWith(tools), undefined);
    current = files;
    await wrapped(requestWith(tools), undefined);
    expect(got.map((r) => names(r.tools).includes('execute'))).toEqual([false, true, false]);
    expect(got.map((r) => names(r.tools).includes('delete'))).toEqual([false, true, false]);
  });

  it('工廠 backend 收到的是請求上的 runtime 加 state', async () => {
    const calls: unknown[] = [];
    const factory = (runtime: unknown) => {
      calls.push(runtime);
      return files;
    };
    const request = { ...requestWith([]), runtime: { context: { a: 1 } }, state: { s: 1 } };
    await filesystemModelCallWrap(factory, async (r: Request) => r)(request, undefined);
    expect(calls).toEqual([{ context: { a: 1 }, state: { s: 1 } }]);
  });
});

describe('filesystemToolAdmission', () => {
  it('只管 execute 與 delete，比的是名字', () => {
    const none = filesystemToolAdmission(files);
    expect(none.admits('execute')).toBe(false);
    expect(none.admits('delete')).toBe(false);
    expect(none.admits('read_file')).toBe(true);
    expect(filesystemToolAdmission(sandbox).admits('execute')).toBe(true);
    expect(filesystemToolAdmission(withDelete).admits('delete')).toBe(true);
    // 有 execute 但沒有非空 id 的不算能執行，同基座的 isSandboxBackend。
    expect(filesystemToolAdmission({ ...sandbox, id: '' }).admits('execute')).toBe(false);
  });
});
