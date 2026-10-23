/**
 * 「先讀後改」策略自己的邏輯——餵它一個假的 backend 與假的 `handler`，看它放行還是拒絕。
 *
 * 這一層問的是**決策**：三個狀態各自導向哪一格、版本 token 什麼時候算陳舊。
 * 「掛進真的 agent、跑在真的磁碟上會怎樣」在 `apps/harness/src/observation.test.ts`；
 * 「掛在哪、排第幾、幾份實例」在 [`fold.test.ts`](./fold.test.ts)。
 */

import { posix } from 'node:path';

import { ToolMessage } from '@langchain/core/messages';
import { CompositeBackend } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { describe, expect, it } from 'vitest';
import {
  createObservationPolicy,
  createVersionHasher,
  noteReadVersion,
  observationGuidance,
  observationKey,
  OBSERVED_EDIT_TOOL,
  OBSERVED_READ_TOOL,
  OBSERVED_WRITE_TOOL,
} from './observation.js';
import { toolErrorOf } from './tool-events.js';

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
    expect(String(result.content)).toMatch(/^Error: /);
    expect(String(result.content)).not.toContain('FS_');
    expect(toolErrorOf(result)?.code).toBe('FS_NOT_OBSERVED');
    expect(String(result.content)).toContain('/a.md');
    // 碼也標在訊息外面，會話日誌的 `tool/result` 讀得到（#264）。
    expect(toolErrorOf(result)).toEqual({ name: 'FsError', code: 'FS_NOT_OBSERVED' });
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
    expect(String(result.content)).toMatch(/^Error: /);
    expect(String(result.content)).not.toContain('FS_');
    expect(toolErrorOf(result)?.code).toBe('FS_NOT_FOUND');
    // 兩個碼分得開才有意義：一個是「你還沒看」，一個是「你看過，它不在」。
    expect(String(result.content)).not.toContain('FS_NOT_OBSERVED');
    expect(toolErrorOf(result)).toEqual({ name: 'FsError', code: 'FS_NOT_FOUND' });
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
    expect(String(result.content)).toMatch(/^Error: /);
    expect(String(result.content)).not.toContain('FS_');
    expect(toolErrorOf(result)?.code).toBe('FS_NOT_OBSERVED');
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
    expect(String(result.content)).toMatch(/^Error: /);
    expect(String(result.content)).not.toContain('FS_');
    expect(toolErrorOf(result)?.code).toBe('FS_STALE_VERSION');
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
    expect(String(result.content)).toMatch(/^Error: /);
    expect(String(result.content)).not.toContain('FS_');
    expect(toolErrorOf(result)?.code).toBe('FS_STALE_VERSION');
    expect(calls).toEqual([OBSERVED_READ_TOOL]);
  });

  it('讀過之後檔案不見了 → 一樣擋，訊息說的是不見了', async () => {
    const { backend, remove } = fakeBackend(new Map([['/a.md', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), handler);
    remove('/a.md');
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(String(result.content)).toMatch(/^Error: /);
    expect(String(result.content)).not.toContain('FS_');
    expect(toolErrorOf(result)?.code).toBe('FS_STALE_VERSION');
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
    expect(String(result.content)).toMatch(/^Error: /);
    expect(String(result.content)).not.toContain('FS_');
    expect(toolErrorOf(result)?.code).toBe('FS_STALE_VERSION');
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

describe('規則在模型動手之前就講給它聽（dsh 的 systemPrompt.section，write.ts:63-71、edit.ts:76-83）', () => {
  const WRITE_AND_EDIT =
    'Read an existing file before overwriting it with write_file (the default fs-observation-policy requires it) and prefer edit_file for targeted changes.';
  const WRITE_ONLY =
    'Read an existing file before overwriting it with write_file (the default fs-observation-policy requires it).';
  const EDIT =
    'Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session.';

  it('observationGuidance：工具在場才寫各自那一句，句子是 dsh 原句（工具名換成 write_file／edit_file）', () => {
    expect(observationGuidance(new Set([OBSERVED_WRITE_TOOL, OBSERVED_EDIT_TOOL]))).toBe(
      `${WRITE_AND_EDIT}\n\n${EDIT}`,
    );
    expect(observationGuidance(new Set([OBSERVED_WRITE_TOOL]))).toBe(WRITE_ONLY);
    expect(observationGuidance(new Set([OBSERVED_EDIT_TOOL]))).toBe(EDIT);
    expect(observationGuidance(new Set([OBSERVED_READ_TOOL, 'grep']))).toBe('');
  });

  it('wrapModelCall：看這一輪送給模型的工具清單，把那兩句接在系統提示後面', () => {
    const { backend } = fakeBackend(new Map());
    const middleware = createObservationPolicy(backend) as unknown as {
      wrapModelCall: (request: unknown, handler: (next: unknown) => unknown) => unknown;
    };
    const run = (tools: readonly { name: string }[]): string => {
      let system = '';
      middleware.wrapModelCall(
        { tools, systemMessage: { concat: (text: string) => (system = `原本的${text}`) } },
        (next) => next,
      );
      return system;
    };
    expect(
      run([
        { name: OBSERVED_READ_TOOL },
        { name: OBSERVED_WRITE_TOOL },
        { name: OBSERVED_EDIT_TOOL },
      ]),
    ).toBe(`原本的\n\n${WRITE_AND_EDIT}\n\n${EDIT}`);
    // 沒有 write_file／edit_file（例如唯讀模式把它們拿掉）→ 不追加，請求原樣交出去。
    expect(run([{ name: OBSERVED_READ_TOOL }])).toBe('');
  });
});

/**
 * 一個認得「同一個檔的不同寫法」的假 backend：跟 virtual mode 的 `resolvePath` 一樣，前面補 `/` 再 `normalize`。
 * `fakeBackend` 的鍵是原字串，`a.txt` 與 `/a.txt` 對它是兩個檔，量不到這一格。
 */
function resolvingBackend(files: Map<string, string>): {
  backend: AnyBackendProtocol;
  set: (path: string, content: string) => void;
} {
  const stamps = new Map<string, string>();
  let clock = 0;
  const keyOf = (path: string): string => posix.normalize(`/${path}`);
  const touch = (key: string): void => {
    clock += 1;
    stamps.set(key, `2026-01-01T00:00:${String(clock).padStart(2, '0')}.000Z`);
  };
  const store = new Map([...files].map(([path, content]) => [keyOf(path), content]));
  for (const key of store.keys()) touch(key);
  return {
    backend: {
      readRaw(path: string) {
        const key = keyOf(path);
        const content = store.get(key);
        if (content === undefined) return { error: `File '${path}' not found` };
        return { data: { content, modified_at: stamps.get(key) } };
      },
    } as unknown as AnyBackendProtocol,
    set: (path, content) => {
      store.set(keyOf(path), content);
      touch(keyOf(path));
    },
  };
}

describe('同一個檔的不同寫法是同一個檔（#1563 N0333）', () => {
  it('讀 `a.txt` 再 edit `/a.txt` → 放行（拿掉正規化就是 FS_NOT_OBSERVED）', async () => {
    const { backend } = resolvingBackend(new Map([['/a.txt', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, 'a.txt'), handler);
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.txt'), handler)) as ToolMessage;
    expect(toolErrorOf(result)).toBeUndefined();
    expect(calls).toEqual([OBSERVED_READ_TOOL, OBSERVED_EDIT_TOOL]);
  });

  it('讀 `./dir//a.txt` 再 write `/dir/a.txt` → 放行', async () => {
    const { backend } = resolvingBackend(new Map([['/dir/a.txt', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, './dir//a.txt'), handler);
    const result = (await wrap(
      requestFor(OBSERVED_WRITE_TOOL, '/dir/a.txt'),
      handler,
    )) as ToolMessage;
    expect(toolErrorOf(result)).toBeUndefined();
    expect(calls).toEqual([OBSERVED_READ_TOOL, OBSERVED_WRITE_TOOL]);
  });

  it('換寫法之後檔案被動過 → 仍然是 FS_STALE_VERSION（不是放行）', async () => {
    const { backend, set } = resolvingBackend(new Map([['/a.txt', '原本的']]));
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, 'a.txt'), handler);
    set('a.txt', '別人改過');
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.txt'), handler)) as ToolMessage;
    expect(toolErrorOf(result)?.code).toBe('FS_STALE_VERSION');
  });

  it('**路由那一格**：讀 `/tool-results/x.txt` 之後 write `tool-results/x.txt` → FS_NOT_OBSERVED（是兩個檔）', async () => {
    // 兩邊各放一個 x.txt。`/tool-results/` 走暫存路由，沒有前導斜線的 `tool-results/x.txt` 落到預設的工作區。
    const stash = resolvingBackend(new Map([['/x.txt', '暫存那份']]));
    const workspace = resolvingBackend(new Map([['/tool-results/x.txt', '工作區那份']]));
    const backend = new CompositeBackend(workspace.backend, {
      '/tool-results/': stash.backend,
    }) as unknown as AnyBackendProtocol;
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/tool-results/x.txt'), handler);
    const result = (await wrap(
      requestFor(OBSERVED_WRITE_TOOL, 'tool-results/x.txt'),
      handler,
    )) as ToolMessage;
    // 單純的 `'/' + raw` 會讓兩把鍵撞在一起，結果變成 FS_STALE_VERSION（兩份內容的版本不同）。
    expect(toolErrorOf(result)?.code).toBe('FS_NOT_OBSERVED');
    expect(calls).toEqual([OBSERVED_READ_TOOL]);
  });

  it('巢狀的 CompositeBackend 也認得內層的路由（組裝點的 composite 是一層包一層）', () => {
    const inner = new CompositeBackend(resolvingBackend(new Map()).backend, {
      '/tool-results/': resolvingBackend(new Map()).backend,
    });
    const outer = new CompositeBackend(inner as unknown as AnyBackendProtocol, {
      '/mounted/': resolvingBackend(new Map()).backend,
    }) as unknown as AnyBackendProtocol;

    expect(observationKey(outer, '/tool-results/x.txt')).not.toBe(
      observationKey(outer, 'tool-results/x.txt'),
    );
    expect(observationKey(outer, '/mounted/x.txt')).not.toBe(observationKey(outer, '/x.txt'));
    // 同一個 backend 裡的不同寫法是同一把。
    expect(observationKey(outer, '/tool-results/x.txt')).toBe(
      observationKey(outer, '/tool-results//./x.txt'),
    );
    expect(observationKey(outer, 'a.txt')).toBe(observationKey(outer, '/a.txt'));
  });

  it('含 `..` 的路徑不併進別的檔的鍵（後端會拒絕它，失敗的讀不能記到 `/x` 身上）', () => {
    const { backend } = resolvingBackend(new Map());
    expect(observationKey(backend, '../x')).not.toBe(observationKey(backend, '/x'));
    expect(observationKey(backend, 'a/../x')).not.toBe(observationKey(backend, '/x'));
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
    expect(String(result.content)).toMatch(/^Error: /);
    expect(String(result.content)).not.toContain('FS_');
    expect(toolErrorOf(result)?.code).toBe('FS_NOT_OBSERVED');
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
    expect(String(result.content)).toMatch(/^Error: /);
    expect(String(result.content)).not.toContain('FS_');
    expect(toolErrorOf(result)?.code).toBe('FS_NOT_OBSERVED');
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

describe('backend 回報讀檔版本（#1530）', () => {
  /** 與 `versionOf` 無關的獨立 djb2，驗 {@link createVersionHasher} 的算式。 */
  function djb2(text: string): string {
    let acc = 5381;
    for (let i = 0; i < text.length; i += 1) acc = ((acc << 5) + acc + text.charCodeAt(i)) | 0;
    return (acc >>> 0).toString(36);
  }

  const MODIFIED = '2026-01-01T00:00:01.000Z';

  it('分段餵與整份一次餵給出同一個 token，格式是 modified_at:UTF-16 長度:djb2', () => {
    const text = '你好\r\nworld🙂\n\uFEFFend';
    const whole = createVersionHasher();
    whole.update(text);
    for (let step = 1; step <= text.length; step += 1) {
      const parts = createVersionHasher();
      for (let at = 0; at < text.length; at += step) parts.update(text.slice(at, at + step));
      expect(parts.version(MODIFIED)).toBe(whole.version(MODIFIED));
    }
    expect(whole.version(MODIFIED)).toBe(`${MODIFIED}:${text.length}:${djb2(text)}`);
    expect(createVersionHasher().version(MODIFIED)).toBe(`${MODIFIED}:0:${djb2('')}`);
  });

  /** 讀的 handler 邊「讀」邊回報版本（模擬 contained backend）。 */
  function reportingRead(content: string, modifiedAt = MODIFIED) {
    return async (): Promise<ToolMessage> => {
      const hasher = createVersionHasher();
      hasher.update(content);
      noteReadVersion(hasher.version(modifiedAt));
      return new ToolMessage({ content: '讀到了', tool_call_id: 'call-1' });
    };
  }

  function countingBackend(content: string) {
    const files = new Map([['/a.md', content]]);
    const fake = fakeBackend(files);
    // fakeBackend 的 `modified_at` 是自己的時鐘：第一個檔是 00:00:01。
    let readRawCalls = 0;
    const inner = fake.backend as unknown as { readRaw(path: string): unknown };
    const original = inner.readRaw.bind(inner);
    inner.readRaw = (path: string) => {
      readRawCalls += 1;
      return original(path);
    };
    return { backend: fake.backend, set: fake.set, calls: () => readRawCalls };
  }

  it('回報的版本與 readRaw 的一樣 → 讀完不再 readRaw，之後 edit 放行', async () => {
    const { backend, calls } = countingBackend('原本的');
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls: ran, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), reportingRead('原本的'));
    expect(calls()).toBe(0);
    await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler);
    expect(ran).toEqual([OBSERVED_EDIT_TOOL]);
    // edit 前比對一次、edit 後重記一次。
    expect(calls()).toBe(2);
  });

  it('回報的版本與 readRaw 不同 → edit 被擋（版本真的在比，不是回報什麼都信）', async () => {
    const { backend } = countingBackend('原本的');
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { calls: ran, handler } = probe();

    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), reportingRead('另一份內容'));
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(toolErrorOf(result)?.code).toBe('FS_STALE_VERSION');
    expect(ran).toEqual([]);
  });

  // #1776：基座對非文字副檔名的 `readRaw` 回位元組。這一層只有假 backend，harness 的真磁碟測試之外要有自己的紅燈
  // （審查突變：拿掉 `contentText` 的 Uint8Array 分支，core 全套仍綠）。
  describe('readRaw 回位元組（#1776）', () => {
    /** `readRaw` 回固定位元組的假 backend。 */
    function bytesBackend(bytes: Uint8Array): AnyBackendProtocol {
      return {
        readRaw: () => ({ data: { content: bytes, modified_at: MODIFIED } }),
      } as unknown as AnyBackendProtocol;
    }

    async function editAfterReading(
      bytes: Uint8Array,
      reported: string,
    ): Promise<string[] | string> {
      const wrap = wrapperOf(createObservationPolicy(bytesBackend(bytes)));
      const { calls: ran, handler } = probe();
      await wrap(requestFor(OBSERVED_READ_TOOL, '/a.png'), reportingRead(reported));
      const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.png'), handler)) as ToolMessage;
      return ran.length > 0 ? ran : (toolErrorOf(result)?.code ?? 'no-error');
    }

    it('位元組是 UTF-8 文字：照文字算版本，讀完 edit 放行', async () => {
      const text = '你好\r\nworld🙂\n';
      expect(await editAfterReading(new TextEncoder().encode(text), text)).toEqual([
        OBSERVED_EDIT_TOOL,
      ]);
    });

    it('開頭的 BOM 留著：回報的版本含 BOM，解碼丟掉 BOM 就會對不上', async () => {
      const text = '\uFEFFfirst\r\nsecond\r\n';
      expect(await editAfterReading(new TextEncoder().encode(text), text)).toEqual([
        OBSERVED_EDIT_TOOL,
      ]);
      // 對照：回報的版本沒有 BOM，就是另一份內容，被擋。
      expect(await editAfterReading(new TextEncoder().encode(text), text.slice(1))).toBe(
        'FS_STALE_VERSION',
      );
    });

    it('解不開 UTF-8（真的二進位）：當空字串，版本只剩 modified_at；回報了內容的版本就對不上', async () => {
      const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
      expect(await editAfterReading(binary, '')).toEqual([OBSERVED_EDIT_TOOL]);
      expect(await editAfterReading(binary, '\uFFFD')).toBe('FS_STALE_VERSION');
    });
  });

  it('沒回報的 backend 照舊 readRaw 一次', async () => {
    const { backend, calls } = countingBackend('原本的');
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { handler } = probe();
    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), handler);
    expect(calls()).toBe(1);
  });

  it('讀失敗時回報的版本不算：之後的 edit 還是 FS_NOT_OBSERVED', async () => {
    const { backend } = countingBackend('原本的');
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { handler } = probe();
    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), async () => {
      noteReadVersion(`${MODIFIED}:3:abc`);
      return new ToolMessage({ content: 'Error: boom', tool_call_id: 'call-1', status: 'error' });
    });
    const result = (await wrap(requestFor(OBSERVED_EDIT_TOOL, '/a.md'), handler)) as ToolMessage;
    expect(toolErrorOf(result)?.code).toBe('FS_NOT_OBSERVED');
  });

  it('不在 read_file 裡叫 noteReadVersion：什麼都不做、不拋，也不污染下一次讀', async () => {
    expect(() => noteReadVersion('x')).not.toThrow();
    const { backend, calls } = countingBackend('原本的');
    const wrap = wrapperOf(createObservationPolicy(backend));
    const { handler } = probe();
    // 寫工具裡叫它：槽不存在，無效。
    await wrap(requestFor(OBSERVED_WRITE_TOOL, '/new.md'), async () => {
      noteReadVersion('x');
      return new ToolMessage({ content: 'ok', tool_call_id: 'call-1' });
    });
    const before = calls();
    await wrap(requestFor(OBSERVED_READ_TOOL, '/a.md'), handler);
    // 下一次讀沒回報，照舊 readRaw 一次——沒有拿到上一次殘留的版本。
    expect(calls() - before).toBe(1);
  });
});
