/**
 * `present` 這顆工具：**它檢查什麼、回什麼，以及什麼時候寫交付**。
 *
 * 這一檔只走 registry 這一層，backend 是真的磁碟（基座的 `FilesystemBackend`，虛擬路徑模式，同
 * `apps/harness` 的圍堵 backend）。`tool/call`／`tool/result` 由測試自己照圍堵的順序寫——圍堵、真的圖與
 * pump 那一半在 `apps/harness/src/present-tool.test.ts`。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import { createRegistry, SessionRegistry, toolErrorOf, WORKSPACE_CAPABILITY } from '@nexus/core';
import type { PluginRegistry, SessionEvent, SessionLog } from '@nexus/core';
import { FilesystemBackend } from 'deepagents';

import {
  createPresentPlugin,
  PRESENT_BACKEND_MIDDLEWARE_NAME,
  PRESENT_EMPTY_PATH_MESSAGE,
  PRESENT_NO_SESSION_MESSAGE,
  PRESENT_NO_WORKSPACE_MESSAGE,
  PRESENT_TOOL_NAME,
  presentCountMessage,
  presentNotFileMessage,
  presentNotFoundMessage,
} from './index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 一個真的工作區目錄。 */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-present-'));
  roots.push(root);
  return root;
}

interface Mounted {
  readonly tool: StructuredTool;
  readonly sessions: SessionRegistry;
  readonly registry: PluginRegistry;
  readonly backend: FilesystemBackend | undefined;
}

/**
 * 掛一次。`root` 給了就把 backend 交給 `useWithBackend` 的工廠（fold 做的那一步），`workspace` 決定
 * 有沒有人宣告工作區（組裝點的 sandbox-policy 做的那一步）。
 */
function mount(options: { root?: string; workspace?: boolean; maxFiles?: number } = {}): Mounted {
  const registry = createRegistry();
  const plugin = createPresentPlugin(
    options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles },
  );
  const exit = registry.enter({ id: 'present#0', name: plugin.name });
  void plugin.apply(registry);
  exit();
  if (options.workspace ?? true) {
    const leave = registry.enter({ id: 'sandbox-policy#0', name: 'sandbox-policy' });
    registry.capabilities.provide(WORKSPACE_CAPABILITY);
    leave();
  }
  const backend =
    options.root === undefined
      ? undefined
      : new FilesystemBackend({ rootDir: options.root, virtualMode: true });
  if (backend !== undefined) {
    const built = registry.middleware
      .list()
      .map((entry) => entry.value.build?.(backend))
      .filter((middleware) => middleware !== undefined);
    expect(built).toEqual([{ name: PRESENT_BACKEND_MIDDLEWARE_NAME }]);
  }
  const entry = registry.tools.resolve(PRESENT_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒註冊上');
  const sessions = new SessionRegistry('unit');
  registry.sessions.bind(sessions);
  return { tool: entry.value, sessions, registry, backend };
}

/** root 的一次呼叫。`toolCall.id` 就是 `callId`。 */
function rootConfig(callId: string) {
  return { configurable: { checkpoint_ns: 'tools:root-call' }, toolCall: { id: callId } };
}

/** subagent 的一次呼叫：兩段 `checkpoint_ns`。 */
function subagentConfig(callId: string) {
  return {
    configurable: { checkpoint_ns: 'tools:spawn-1|tools:its-call' },
    toolCall: { id: callId },
  };
}

/**
 * 照圍堵的順序叫一次：先 `tool/call`，再進工具，最後 `tool/result`。回工具回的東西。
 * @param verdict - 圍堵最後把這次判成什麼。`'pending'` 就不寫結果（本體跑完、結果還沒落定）。
 */
async function callThrough(
  mounted: Mounted,
  log: SessionLog,
  files: unknown,
  config: { toolCall: { id: string } },
  verdict: 'success' | 'error' | 'pending' = 'success',
): Promise<unknown> {
  const callId = config.toolCall.id;
  log.append('tool/call', {
    callId,
    name: PRESENT_TOOL_NAME,
    arguments: JSON.stringify({ files }),
  });
  const result = await mounted.tool.invoke({ files } as never, config as never);
  if (verdict !== 'pending') log.append('tool/result', { callId, isError: verdict === 'error' });
  // 交付排在下一個 microtask。
  await Promise.resolve();
  await Promise.resolve();
  return result;
}

function deliveries(log: SessionLog): SessionEvent<'deliverables/presented'>[] {
  return log.events.filter(
    (event): event is SessionEvent<'deliverables/presented'> =>
      event.type === 'deliverables/presented',
  );
}

/** 成功的那一次模型看到的字。帶 `toolCall` 叫的話 LangChain 會把字串包成一則 ToolMessage。 */
function textOf(result: unknown): string {
  if (!ToolMessage.isInstance(result)) throw new Error(`回的不是一則工具訊息：${String(result)}`);
  expect(result.status).toBe('success');
  return String(result.content);
}

/** 一次拒絕：模型看到的字與它的碼。 */
function refusalOf(result: unknown): { text: string; code: string | undefined } {
  if (!ToolMessage.isInstance(result)) throw new Error(`回的不是一則工具訊息：${String(result)}`);
  expect(result.status).toBe('error');
  return { text: String(result.content), code: toolErrorOf(result)?.code };
}

describe('成功的那一次', () => {
  it('回 dsh 的 `Presented <path>`，而且結果落定成功之後才寫一筆交付', async () => {
    const root = await workspace();
    await writeFile(join(root, '報告.docx'), Uint8Array.of(80, 75, 0, 255));
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out', 'a.csv'), 'a');
    const mounted = mount({ root });
    const log = mounted.sessions.root;
    const read = vi.spyOn(mounted.backend!, 'read');
    const readRaw = vi.spyOn(mounted.backend!, 'readRaw');

    const files = [{ path: '報告.docx', description: 'Report' }, { path: '/out/a.csv' }];
    log.append('tool/call', { callId: 'c1', name: PRESENT_TOOL_NAME, arguments: '{}' });
    const result = await mounted.tool.invoke({ files }, rootConfig('c1') as never);
    expect(textOf(result)).toBe('Presented 報告.docx\nPresented /out/a.csv');
    await Promise.resolve();
    // 本體跑完、結果還沒落定：一筆都不寫。
    expect(deliveries(log)).toEqual([]);

    log.append('tool/result', { callId: 'c1', isError: false });
    expect(deliveries(log)).toEqual([]);
    await Promise.resolve();
    const [delivery] = deliveries(log);
    // `description` 沒給的那一個整個不放 key。
    expect(delivery?.data).toEqual({ callId: 'c1', files });
    expect(delivery?.data.files[1]).not.toHaveProperty('description');
    // 落在配對的 `tool/result` 之後。
    const resultSeq = log.events.find((event) => event.type === 'tool/result')?.seq ?? Infinity;
    expect(delivery!.seq).toBeGreaterThan(resultSeq);
    // 只看目錄，不讀內容。
    expect(read).not.toHaveBeenCalled();
    expect(readRaw).not.toHaveBeenCalled();
  });

  it('結果被判成錯誤就不交付——照 dsh 被 post-execute 擋下的那一條', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root });
    const log = mounted.sessions.root;
    const result = await callThrough(mounted, log, [{ path: 'a' }], rootConfig('c1'), 'error');
    expect(textOf(result)).toBe('Presented a');
    expect(deliveries(log)).toEqual([]);
  });

  it('別的呼叫的結果不算數，等到自己那一顆才寫，而且只寫一次', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root });
    const log = mounted.sessions.root;
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('mine'), 'pending');
    log.append('tool/result', { callId: 'someone-else', isError: false });
    await Promise.resolve();
    expect(deliveries(log)).toEqual([]);
    log.append('tool/result', { callId: 'mine', isError: false });
    await Promise.resolve();
    // 同一個 callId 再來一顆也不重寫：訂閱在第一顆就退了。
    log.append('tool/result', { callId: 'mine', isError: false });
    await Promise.resolve();
    expect(deliveries(log).map((event) => event.data.callId)).toEqual(['mine']);
  });

  it('子代理叫的寫進子代理那一份，root 那一份沒有', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root });
    const config = subagentConfig('sub-1');
    const found = mounted.registry.sessions.forCall(config);
    if (found.kind !== 'ok') throw new Error(`認不出子代理：${found.kind}`);
    await callThrough(mounted, found.log, [{ path: 'a' }], config);
    expect(deliveries(found.log).map((event) => event.data.callId)).toEqual(['sub-1']);
    expect(deliveries(mounted.sessions.root)).toEqual([]);
  });
});

describe('拒絕', () => {
  it('找不到、目錄、工作區根、空路徑都拒絕，而且一筆交付都不寫', async () => {
    const root = await workspace();
    await mkdir(join(root, 'dir'));
    const mounted = mount({ root });
    const log = mounted.sessions.root;
    const cases: [unknown, string, string | undefined][] = [
      [[{ path: 'missing' }], presentNotFoundMessage('missing'), 'FS_NOT_FOUND'],
      [[{ path: 'dir' }], presentNotFileMessage('dir'), undefined],
      [[{ path: '.' }], presentNotFileMessage('.'), undefined],
      [[{ path: '   ' }], PRESENT_EMPTY_PATH_MESSAGE, undefined],
      [[{ path: '../outside' }], presentNotFoundMessage('../outside'), 'FS_NOT_FOUND'],
    ];
    for (const [index, [files, text, code]] of cases.entries()) {
      const refusal = refusalOf(
        await callThrough(mounted, log, files, rootConfig(`c${index}`), 'error'),
      );
      expect(refusal.text, JSON.stringify(files)).toBe(`Error: ${text}`);
      expect(refusal.code, JSON.stringify(files)).toBe(code);
    }
    expect(deliveries(log)).toEqual([]);
  });

  it('檔數要在 1 到 maxFiles 之間', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root, maxFiles: 2 });
    const log = mounted.sessions.root;
    for (const files of [[], [{ path: 'a' }, { path: 'a' }, { path: 'a' }]]) {
      const refusal = refusalOf(await callThrough(mounted, log, files, rootConfig('c'), 'error'));
      expect(refusal.text).toBe(`Error: ${presentCountMessage(2)}`);
    }
    expect(
      textOf(await callThrough(mounted, log, [{ path: 'a' }, { path: 'a' }], rootConfig('ok'))),
    ).toBe('Presented a\nPresented a');
  });

  it('沒有人宣告工作區就拒絕——即使 backend 在（沒有工作區時組裝點照樣墊一顆 StateBackend）', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root, workspace: false });
    const refusal = refusalOf(
      await callThrough(mounted, mounted.sessions.root, [{ path: 'a' }], rootConfig('c'), 'error'),
    );
    expect(refusal.text).toBe(`Error: ${PRESENT_NO_WORKSPACE_MESSAGE}`);
  });

  it('backend 從沒交進來也拒絕成沒有工作區', async () => {
    const mounted = mount();
    const refusal = refusalOf(
      await callThrough(mounted, mounted.sessions.root, [{ path: 'a' }], rootConfig('c'), 'error'),
    );
    expect(refusal.text).toBe(`Error: ${PRESENT_NO_WORKSPACE_MESSAGE}`);
  });

  it('拿不到呼叫者那一份日誌、或沒有 callId，就拒絕', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root });
    const noCaller = await mounted.tool.invoke({ files: [{ path: 'a' }] }, {
      toolCall: { id: 'c' },
    } as never);
    expect(refusalOf(noCaller).text).toBe(`Error: ${PRESENT_NO_SESSION_MESSAGE}`);
    const noCallId = await mounted.tool.invoke({ files: [{ path: 'a' }] }, {
      configurable: { checkpoint_ns: 'tools:root-call' },
    } as never);
    expect(refusalOf(noCallId).text).toBe(`Error: ${PRESENT_NO_SESSION_MESSAGE}`);
  });

  it('多一個鍵就是參數不合（照 dsh 的 additionalProperties: false）', async () => {
    const mounted = mount();
    await expect(
      mounted.tool.invoke({ files: [{ path: 'a', extra: 1 }] }, rootConfig('c') as never),
    ).rejects.toThrow();
  });
});

describe('已知的偏離', () => {
  it('**最後一段是符號連結擋不下來**：backend 沒有 lstat，這一格照 dsh 會拒、我們放行', async () => {
    // 翻面的絆索：哪天 backend 協定有了 lstat、這裡改成拒絕，這一條會紅，偏離註解要一起收回。
    const root = await workspace();
    await writeFile(join(root, 'source'), 'source');
    await symlink(join(root, 'source'), join(root, 'link'));
    const mounted = mount({ root });
    expect(
      textOf(
        await callThrough(mounted, mounted.sessions.root, [{ path: 'link' }], rootConfig('c')),
      ),
    ).toBe('Presented link');
  });
});

describe('掛載', () => {
  it('maxFiles 不是正的安全整數就在掛載時拋', () => {
    for (const maxFiles of [0, 1.5, Number.POSITIVE_INFINITY, -1]) {
      expect(() => createPresentPlugin({ maxFiles })).toThrow('positive integer maxFiles');
    }
  });
});
