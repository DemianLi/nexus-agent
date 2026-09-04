/**
 * 「先讀後改」策略自己的邏輯——餵它一個假的 backend 與假的 `handler`，看它放行還是拒絕。
 *
 * 這一層問的是**決策**：三個狀態各自導向哪一格、版本 token 什麼時候算陳舊。
 * 「掛進真的 agent、跑在真的磁碟上會怎樣」在 `apps/harness/src/observation.test.ts`；
 * 「掛在哪、排第幾、幾份實例」在 [`fold.test.ts`](./fold.test.ts)。
 */

import { ToolMessage } from '@langchain/core/messages';
import type { AnyBackendProtocol } from 'deepagents';
import { describe, expect, it } from 'vitest';
import {
  createObservationPolicy,
  OBSERVATION_POLICY_NOTICE,
  OBSERVED_EDIT_TOOL,
  OBSERVED_READ_TOOL,
  OBSERVED_WRITE_TOOL,
} from './observation.js';

/** `wrapToolCall` 拿出來直接呼叫用的形狀。 */
type Wrapper = (
  request: unknown,
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

/** 一個只認得 `readRaw` 的假 backend，內容放在一張可以隨手改的 map 裡。 */
function fakeBackend(files: Map<string, string>): {
  backend: AnyBackendProtocol;
  /** 直接改內容，模擬「讀過之後被別人動了」。 */
  set: (path: string, content: string) => void;
  /** 直接刪掉，模擬「讀過之後不見了」。 */
  remove: (path: string) => void;
} {
  let clock = 0;
  const stamps = new Map<string, string>();
  const touch = (path: string): void => {
    clock += 1;
    stamps.set(path, `2026-01-01T00:00:${String(clock).padStart(2, '0')}.000Z`);
  };
  for (const path of files.keys()) touch(path);
  const backend = {
    readRaw(path: string) {
      const content = files.get(path);
      if (content === undefined) return { error: `File '${path}' not found` };
      return { data: { content, modified_at: stamps.get(path) } };
    },
  } as unknown as AnyBackendProtocol;
  return {
    backend,
    set: (path, content) => {
      files.set(path, content);
      touch(path);
    },
    remove: (path) => {
      files.delete(path);
      stamps.delete(path);
    },
  };
}

/** 從 middleware 上取出 `wrapToolCall`。 */
function wrapperOf(middleware: unknown): Wrapper {
  const wrap = (middleware as { wrapToolCall?: Wrapper }).wrapToolCall;
  if (wrap === undefined) throw new Error('這個 middleware 沒有 wrapToolCall');
  return wrap;
}

/** 一次工具呼叫的假請求。 */
function requestFor(toolName: string, path: string): unknown {
  return { toolCall: { name: toolName, args: { file_path: path }, id: 'call-1' }, tool: undefined };
}

/** 這次呼叫有沒有真的落到工具身上。 */
function probe(): { calls: string[]; handler: (request: unknown) => Promise<unknown> } {
  const calls: string[] = [];
  return {
    calls,
    handler: async (request) => {
      calls.push((request as { toolCall: { name: string } }).toolCall.name);
      return new ToolMessage({ content: '跑過了', tool_call_id: 'call-1' });
    },
  };
}

describe('三個狀態', () => {
  it('沒觀測過就 edit → FS_NOT_OBSERVED，工具沒被叫到', async () => {
    const { backend } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(result.status).toBe('error');
    expect(String(result.content)).toContain('FS_NOT_OBSERVED');
    expect(String(result.content)).toContain('/a.md');
    expect(calls).toEqual([]);
  });

  it('讀過就放行（上一條的對照組）', async () => {
    const { backend } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), handler);
    await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler);
    expect(calls).toEqual([OBSERVED_READ_TOOL, OBSERVED_EDIT_TOOL]);
  });

  it('**讀到不存在是「確認缺席」，不是「沒觀測過」**——edit 拿到的是 FS_NOT_FOUND', async () => {
    const { backend } = fakeBackend(new Map());
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/nope.md'), handler);
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/nope.md'), handler)) as ToolMessage;
    expect(String(result.content)).toContain('FS_NOT_FOUND');
    // 兩個碼分得開才有意義：一個是「你還沒看」，一個是「你看過，它不在」。
    expect(String(result.content)).not.toContain('FS_NOT_OBSERVED');
    expect(calls).toEqual([OBSERVED_READ_TOOL]);
  });

  it('確認缺席**授權**受防護的新建', async () => {
    const { backend } = fakeBackend(new Map());
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/nope.md'), handler);
    await wrap(requestFor(OBSERVED_WRITE_TOOL, '/nope.md'), handler);
    expect(calls).toEqual([OBSERVED_READ_TOOL, OBSERVED_WRITE_TOOL]);
  });
});

describe('write_file：新建可以，覆蓋沒讀過的不行', () => {
  it('路徑不存在 → 放行', async () => {
    const { backend } = fakeBackend(new Map());
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_WRITE_TOOL, '/fresh.md'), handler);
    expect(calls).toEqual([OBSERVED_WRITE_TOOL]);
  });

  it('路徑存在而且沒讀過 → FS_NOT_OBSERVED', async () => {
    const { backend } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    const result = (await wrap(requestFor(OBSERVED_WRITE_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(String(result.content)).toContain('FS_NOT_OBSERVED');
    expect(calls).toEqual([]);
  });

  it('**讀到缺席之後被別人搶先建了 → FS_STALE_VERSION**，不是無聲覆蓋', async () => {
    const { backend, set } = fakeBackend(new Map());
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/race.md'), handler);
    set('/race.md', '別人建的');
    const result = (await wrap(
      requestFor(OBSERVED_WRITE_TOOL, '/race.md'),
      handler,
    )) as ToolMessage;
    expect(String(result.content)).toContain('FS_STALE_VERSION');
    expect(calls).toEqual([OBSERVED_READ_TOOL]);
  });
});

describe('版本新鮮度', () => {
  it('讀過之後內容被改掉 → FS_STALE_VERSION', async () => {
    const { backend, set } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), handler);
    set('/a.md', '別人改的');
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(String(result.content)).toContain('FS_STALE_VERSION');
    expect(calls).toEqual([OBSERVED_READ_TOOL]);
  });

  it('讀過之後檔案不見了 → 一樣擋，訊息說的是不見了', async () => {
    const { backend, remove } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), handler);
    remove('/a.md');
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(String(result.content)).toContain('FS_STALE_VERSION');
    expect(String(result.content)).toContain('不見了');
    expect(calls).toEqual([OBSERVED_READ_TOOL]);
  });

  it('**改成功之後版本跟著更新**——同一輪連改兩次不會被自己的第一次擋掉', async () => {
    const files = new Map([['/a.md', '原本的']]);
    const { backend, set } = fakeBackend(files);
    const wrap = wrapperOf(createObservationPolicy(backend));
    const calls: string[] = [];
    // 工具真的改了東西，所以第二次呼叫面對的是一個新版本。
    const handler = async (request: unknown): Promise<unknown> => {
      const call = (request as { toolCall: { name: string } }).toolCall;
      calls.push(call.name);
      if (call.name !== OBSERVED_READ_TOOL) set('/a.md', `改過 ${calls.length} 次`);
      return new ToolMessage({ content: '跑過了', tool_call_id: 'call-1' });
    };

    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), handler);
    await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler);
    const second = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(second.status).not.toBe('error');
    expect(calls).toHaveLength(3);
  });

  it('**`modified_at` 動了、內容沒動 → 照樣算陳舊**（token 是複合的，不是只看內容）', async () => {
    const { backend, set } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), handler);
    // dsh 的 token 是複合的（`dev:ino:size:mtimeNs:ctimeNs`），所以「同一份內容原地寫
    // 回去」在它那邊也算變了——我們一樣。這條釘的是**它有在看 `modified_at`**。
    set('/a.md', '原本的');
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(String(result.content)).toContain('FS_STALE_VERSION');
    expect(calls).toEqual([OBSERVED_READ_TOOL]);
  });
});

describe('不歸它管的都原樣放行', () => {
  it('別的工具不碰', async () => {
    const { backend } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor('grep', '/a.md'), handler);
    expect(calls).toEqual(['grep']);
  });

  it('**參數沒有 file_path 也放行**——填壞了要讓工具自己講，不是這裡代言', async () => {
    const { backend } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap({ toolCall: { name: OBSERVED_EDIT_TOOL, args: {}, id: 'c' } }, handler);
    expect(calls).toEqual([OBSERVED_EDIT_TOOL]);
  });
});

describe('規則在模型動手之前就講給它聽', () => {
  it('往 systemMessage 追加那一句', async () => {
    const { backend } = fakeBackend(new Map());
    const middleware = createObservationPolicy(backend) as unknown as {
      wrapModelCall: (request: unknown, handler: (next: unknown) => unknown) => unknown;
    };
    let seen = '';
    middleware.wrapModelCall(
      { systemMessage: { concat: (text: string) => (seen = `原本的${text}`) } },
      (next) => next,
    );
    expect(seen).toContain(OBSERVATION_POLICY_NOTICE);
    // 兩顆工具名都要出現在那句話裡——模型是靠名字對上去的。
    expect(OBSERVATION_POLICY_NOTICE).toContain(OBSERVED_EDIT_TOOL);
    expect(OBSERVATION_POLICY_NOTICE).toContain(OBSERVED_WRITE_TOOL);
  });
});

describe('讀失敗不算讀過', () => {
  /**
   * **這一格是這個策略最容易無聲失效的地方。**
   *
   * 版本是從 backend 取的，所以「工具讀失敗」與「backend 讀得到」可以同時成立——內容被
   * token 上限截掉、`offset` 超過檔尾、解碼失敗都會走到這裡。照著 backend 記下去，模型
   * 就握有一份**它從來沒看過的內容**的觀測，下一次 `write_file` 覆蓋直接穿過去。
   *
   * dsh 沒有這個洞是因為 `fs/observed` 由 read 工具在權威成功時才發。
   */
  it('讀一個存在的檔失敗了 → 什麼都沒記，之後的 edit 還是 FS_NOT_OBSERVED', async () => {
    const { backend } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const failing = async (): Promise<unknown> =>
      new ToolMessage({ content: '讀不出來', tool_call_id: 'call-1', status: 'error' });

    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), failing);
    const { calls, handler } = probe();
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(String(result.content)).toContain('FS_NOT_OBSERVED');
    expect(calls).toEqual([]);
  });

  it('**同一次失敗照樣攔得住覆蓋**——write_file 那一半也沒被打開', async () => {
    const { backend } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const failing = async (): Promise<unknown> =>
      new ToolMessage({ content: '讀不出來', tool_call_id: 'call-1', status: 'error' });

    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), failing);
    const { calls, handler } = probe();
    const result = (await wrap(requestFor(OBSERVED_WRITE_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(String(result.content)).toContain('FS_NOT_OBSERVED');
    expect(calls).toEqual([]);
  });

  /**
   * **對照組，而且它擋著上一條的過度修正。**
   *
   * 讀一個**不存在**的檔也是「失敗」（工具回錯誤），但那一筆是權威的缺席觀測，dsh 明文
   * 要求記下來——不然模型讀了一個不存在的檔之後反而更不能建它。把上面那條寫成「錯誤
   * 就一律不記」，這一條會紅。
   */
  it('讀一個不存在的檔失敗了 → 照樣記成確認缺席，新建放行', async () => {
    const { backend } = fakeBackend(new Map());
    const wrap = wrapperOf(createObservationPolicy(backend));
    const failing = async (): Promise<unknown> =>
      new ToolMessage({ content: "File '/nope.md' not found", tool_call_id: 'c', status: 'error' });

    await wrap(requestFor(OBSERVED_READ_TOOL, '/nope.md'), failing);
    const { calls, handler } = probe();
    await wrap(requestFor(OBSERVED_WRITE_TOOL, '/nope.md'), handler);
    expect(calls).toEqual([OBSERVED_WRITE_TOOL]);
  });
});
