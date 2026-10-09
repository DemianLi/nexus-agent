/**
 * `present` 這顆工具：**它檢查什麼、回什麼，以及什麼時候寫交付**。
 *
 * 這一檔只走 registry 這一層，backend 是真的磁碟（基座的 `FilesystemBackend`，虛擬路徑模式，同
 * `apps/harness` 的圍堵 backend）。`tool/call`、`tools/result` 的派發與 `tool/result` 由測試自己照圍堵的順序做
 * （`tool/call` → 本體 → 派發 `tools/result` → 同步記 `tool/result`，見 {@link settle}）——圍堵、真的圖與
 * pump 那一半在 `apps/harness/src/present-tool.test.ts`。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import {
  createRegistry,
  FS_SERVICE,
  loadPlugins,
  SessionRegistry,
  toolCallSessionAddress,
  toolErrorOf,
  WORKSPACE_CAPABILITY,
} from '@nexus/core';
import type { InternalPluginRegistry, SessionEvent, SessionLog } from '@nexus/core';
import { FilesystemBackend, StateBackend } from 'deepagents';

import {
  createPresentPlugin,
  DEFAULT_MAX_FILES,
  presentConfigSchema,
  PRESENT_EMPTY_PATH_MESSAGE,
  PRESENT_NO_SESSION_MESSAGE,
  PRESENT_NO_WORKSPACE_MESSAGE,
  PRESENT_TOOL_NAME,
  presentCountMessage,
  presentNotFileMessage,
  presentNotFoundMessage,
  presentOffWorkspaceMessage,
} from './index.js';

const roots: string[] = [];
/** `tools/result` 的監聽者失敗（派發面把它們吞掉回報）：每個案例結束時必須是空的。 */
const observerFailures: unknown[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  expect(observerFailures.splice(0)).toEqual([]);
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
  readonly registry: InternalPluginRegistry;
  readonly backend: FilesystemBackend | undefined;
}

/**
 * 掛一次。`root` 給了就經 `fs` 服務交出 backend（組裝點提供、fold 填值的那一格），`workspace` 決定
 * 有沒有人宣告工作區（組裝點的 sandbox-policy 做的那一步）。`fs` 是 `'empty'` 時服務在、但裡面沒有
 * backend（fold 過、這次組裝一個 backend 都沒有）。
 */
function mount(
  options: {
    root?: string;
    workspace?: boolean;
    maxFiles?: number;
    fs?: 'empty';
    /** 組裝點明著交的、不在磁碟上的路由前綴（`fs` 服務那一格）。 */
    offWorkspace?: readonly string[];
    /** plugin 用 `backend.mount()` 掛的路由。 */
    mounts?: readonly string[];
  } = {},
): Mounted {
  const registry = createRegistry();
  const backend =
    options.root === undefined
      ? undefined
      : new FilesystemBackend({ rootDir: options.root, virtualMode: true });
  if (backend !== undefined || options.fs === 'empty') {
    const leave = registry.enter({ id: 'host-services#0', name: 'host-services' });
    registry.services.provide(FS_SERVICE, {
      backend: () => backend,
      offWorkspacePrefixes: () => options.offWorkspace ?? [],
    });
    leave();
  }
  for (const prefix of options.mounts ?? []) {
    const leave = registry.enter({ id: 'mounter#0', name: 'mounter' });
    registry.backend.mount(prefix, new StateBackend());
    leave();
  }
  const plugin = createPresentPlugin(
    options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles },
  );
  const exit = registry.enter({ id: 'present#0', name: plugin.plugin.name });
  void plugin.plugin.apply(registry, presentConfigSchema.parse(plugin.config));
  exit();
  if (options.workspace ?? true) {
    const leave = registry.enter({ id: 'sandbox-policy#0', name: 'sandbox-policy' });
    registry.capabilities.provide(WORKSPACE_CAPABILITY);
    leave();
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
 * 照圍堵落定的順序做：先派發 `tools/result`（宿主端的隔離派發），再**同步**記 `tool/result`。兩步之間沒有任何 `await`
 * ——`containment.ts` 的 `notifyToolResult` 與 `settle` 就是這樣接著的，下面測的「交付排在下一個 microtask」靠它。
 * @param mounted - 掛好的組裝。
 * @param log - 呼叫者那一份日誌。
 * @param config - 這次呼叫的 config（位址從它算，同圍堵的 `exec.agent`）。
 * @param callId - 這顆結果是哪個呼叫的。
 * @param isError - 圍堵最後把這次判成錯誤與否。
 * @param options.skipRecord - 只派發、不記 `tool/result`（模擬圍堵記日誌失敗被吞掉）。
 */
function settle(
  mounted: Mounted,
  log: SessionLog,
  config: { toolCall: { id: string } },
  callId: string,
  isError: boolean,
  options: { skipRecord?: boolean } = {},
): void {
  mounted.registry.dispatch.observe(
    'tools/result',
    (error: unknown) => void observerFailures.push(error),
    {
      callId,
      name: PRESENT_TOOL_NAME,
      args: {},
      agent: toolCallSessionAddress(config),
    },
    { kind: 'message', content: '', isError },
  );
  if (options.skipRecord !== true) log.append('tool/result', { callId, isError });
}

/**
 * 照圍堵的順序叫一次：先 `tool/call`，再進工具，最後落定（{@link settle}）。回工具回的東西。
 * @param verdict - 圍堵最後把這次判成什麼。`'pending'` 就不落定（本體跑完、結果還沒落定）。
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
  if (verdict !== 'pending') settle(mounted, log, config, callId, verdict === 'error');
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

/**
 * **模型看到的字**，量在送出去的形狀上（`convertToOpenAITool`，同 `@nexus/core` 的 token 估算）。
 * 期望值是 dsh `477b4f4` 的原文，**寫成字面字串、不 import 常數**：拿常數比的話常數被改回去也是自己
 * 跟自己比，不會紅。
 */
describe('模型看到的描述', () => {
  it('工具描述與 files 的說明逐字等於 dsh', () => {
    const { tool } = mount();
    const { function: sent } = convertToOpenAITool(tool);
    expect(sent.description).toBe(
      'Declare existing files as final deliverables for the user. ' +
        'Use it when the user needs a separate file, especially Office documents, spreadsheets, and slide decks; ' +
        'prefer your final response when that suffices. The user opens the current files; their contents are not copied.',
    );
    const parameters = sent.parameters as {
      properties: { files: { description?: string } };
    };
    expect(parameters.properties.files.description).toBe(
      'Usually the 1-2 most important deliverables; at most 4 per call.',
    );
  });
});

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

    settle(mounted, log, rootConfig('c1'), 'c1', false);
    // 派發與記 `tool/result` 同步做完，交付還排在下一個 microtask。
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
    settle(mounted, log, rootConfig('someone-else'), 'someone-else', false);
    await Promise.resolve();
    expect(deliveries(log)).toEqual([]);
    settle(mounted, log, rootConfig('mine'), 'mine', false);
    await Promise.resolve();
    // 同一個 callId 再來一顆也不重寫：表上那一筆在第一顆就取走了。
    settle(mounted, log, rootConfig('mine'), 'mine', false);
    await Promise.resolve();
    expect(deliveries(log).map((event) => event.data.callId)).toEqual(['mine']);
  });

  it('同一個 callId 在結果落定前又進來一次（中斷後 resume）：只交付一次', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root });
    const log = mounted.sessions.root;
    // 第一次本體跑完、外層拋了中斷所以沒有結果；resume 之後同一個 callId 再跑一次。
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('again'), 'pending');
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('again'), 'pending');
    settle(mounted, log, rootConfig('again'), 'again', false);
    await Promise.resolve();
    expect(deliveries(log).map((event) => event.data.callId)).toEqual(['again']);
  });

  it('組裝收掉之後才落定的結果不交付，等著的那張表清空', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root });
    const log = mounted.sessions.root;
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('late'), 'pending');
    for (const entry of mounted.registry.lifecycle.disposers()) await entry.value();
    settle(mounted, log, rootConfig('late'), 'late', false);
    await Promise.resolve();
    expect(deliveries(log)).toEqual([]);
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

  it('root 與子代理同一個 callId、都在等結果：各落定各的，不取走對方那一筆', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    await writeFile(join(root, 'b'), 'b');
    const mounted = mount({ root });
    const rootLog = mounted.sessions.root;
    const subConfig = subagentConfig('same');
    const found = mounted.registry.sessions.forCall(subConfig);
    if (found.kind !== 'ok') throw new Error(`認不出子代理：${found.kind}`);
    await callThrough(mounted, rootLog, [{ path: 'a' }], rootConfig('same'), 'pending');
    await callThrough(mounted, found.log, [{ path: 'b' }], subConfig, 'pending');
    settle(mounted, found.log, subConfig, 'same', false);
    await Promise.resolve();
    expect(deliveries(rootLog)).toEqual([]);
    expect(deliveries(found.log).map((event) => event.data.files[0]?.path)).toEqual(['b']);
    settle(mounted, rootLog, rootConfig('same'), 'same', false);
    await Promise.resolve();
    expect(deliveries(rootLog).map((event) => event.data.files[0]?.path)).toEqual(['a']);
    expect(deliveries(found.log)).toHaveLength(1);
  });

  it('每次落定都把表上那一筆取走：先錯一次、同 callId 再成功一次，要再叫一次本體才有交付', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root });
    const log = mounted.sessions.root;
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('retry'), 'error');
    expect(deliveries(log)).toEqual([]);
    // 沒有再進本體就落定一顆成功的：表上沒有東西可寫。
    settle(mounted, log, rootConfig('retry'), 'retry', false);
    await Promise.resolve();
    expect(deliveries(log)).toEqual([]);
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('retry'));
    expect(deliveries(log).map((event) => event.data.callId)).toEqual(['retry']);
  });

  it('派發說成功、但日誌上沒有配對的 tool/result（圍堵記失敗被吞掉）：不留孤兒交付', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root });
    const log = mounted.sessions.root;
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('orphan'), 'pending');
    settle(mounted, log, rootConfig('orphan'), 'orphan', false, { skipRecord: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(deliveries(log)).toEqual([]);
  });

  it('只有一位 tools/result 監聽者', () => {
    const mounted = mount();
    expect(
      mounted.registry.events.listeners().filter((listener) => listener.name === 'tools/result'),
    ).toHaveLength(1);
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

  describe('不在工作區磁碟上的路由（#951）', () => {
    /**
     * 兩個來源各一格：組裝點交的（`fs` 服務）、plugin 掛的（`backend.mounts()`）。**檔案在 backend 上是看得到的**
     * ——裸的 `FilesystemBackend` 底下真的有那個檔，所以拒絕的理由只可能是前綴，不是「找不到」。
     */
    it('落在前綴底下就拒，不帶 FS_NOT_FOUND，一筆交付都不寫', async () => {
      const root = await workspace();
      await mkdir(join(root, 'stash'));
      await writeFile(join(root, 'stash', 'a.md'), 'a');
      await mkdir(join(root, 'mounted'));
      await writeFile(join(root, 'mounted', 'a.md'), 'a');
      const mounted = mount({ root, offWorkspace: ['/stash'], mounts: ['/mounted/'] });
      const log = mounted.sessions.root;
      const paths = [
        '/stash/a.md', // 組裝點交的（沒結尾斜線）
        'stash/a.md', // 相對路徑補成以根為起點
        '/stash/../stash/a.md', // `..` 在 virtualPathOf 那一步就夾掉
        '/mounted/a.md', // plugin 掛的（有結尾斜線）
        '/stash', // 前綴本身
      ];
      for (const [index, path] of paths.entries()) {
        const refusal = refusalOf(
          await callThrough(mounted, log, [{ path }], rootConfig(`c${index}`), 'error'),
        );
        expect(refusal.text, path).toBe(`Error: ${presentOffWorkspaceMessage(path)}`);
        expect(refusal.code, path).toBeUndefined();
      }
      expect(deliveries(log)).toEqual([]);
    });

    it('名字只是以前綴開頭的目錄不算：整段比，不是字串前綴', async () => {
      const root = await workspace();
      await mkdir(join(root, 'stash_x'));
      await writeFile(join(root, 'stash_x', 'a.md'), 'a');
      await writeFile(join(root, 'mounted.md'), 'a');
      const mounted = mount({ root, offWorkspace: ['/stash/'], mounts: ['/mounted/'] });
      const log = mounted.sessions.root;
      expect(
        textOf(await callThrough(mounted, log, [{ path: '/stash_x/a.md' }], rootConfig('a'))),
      ).toBe('Presented /stash_x/a.md');
      expect(
        textOf(await callThrough(mounted, log, [{ path: 'mounted.md' }], rootConfig('b'))),
      ).toBe('Presented mounted.md');
    });

    it('一次交幾個，有一個在路由上整批都拒', async () => {
      const root = await workspace();
      await writeFile(join(root, 'ok.md'), 'a');
      const mounted = mount({ root, offWorkspace: ['/stash/'] });
      const log = mounted.sessions.root;
      const refusal = refusalOf(
        await callThrough(
          mounted,
          log,
          [{ path: 'ok.md' }, { path: '/stash/a.md' }],
          rootConfig('c'),
          'error',
        ),
      );
      expect(refusal.text).toBe(`Error: ${presentOffWorkspaceMessage('/stash/a.md')}`);
      expect(deliveries(log)).toEqual([]);
    });
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

  it('預設設定下一次交 5 個照樣成功：說明裡的「at most 4」是建議，不是上限', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root });
    const files = Array.from({ length: 5 }, () => ({ path: 'a' }));
    expect(
      textOf(await callThrough(mounted, mounted.sessions.root, files, rootConfig('five'))),
    ).toBe(Array.from({ length: 5 }, () => 'Presented a').join('\n'));
  });

  /**
   * **這兩條同時是 `apps/harness` 那條交付讀檔路由的正確性前提**
   * （[#519](https://github.com/DemianLi/nexus-agent/issues/519)）：那條路由「日誌 header 記著
   * 工作區根 ⟹ 線以下每一顆交付都錨在它」的推理，靠的就是「沒有工作區的那一段生不出交付」。
   * 這裡改成「沒有工作區就錨在 cwd」的那天，那條路由會開始靜默錯檔，而 `apps/harness` 不會有
   * 任何東西紅——所以要從這裡紅。
   */
  it('沒有人宣告工作區就拒絕——即使 backend 在（沒有工作區時組裝點照樣墊一顆 StateBackend）', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = mount({ root, workspace: false });
    const refusal = refusalOf(
      await callThrough(mounted, mounted.sessions.root, [{ path: 'a' }], rootConfig('c'), 'error'),
    );
    expect(refusal.text).toBe(`Error: ${PRESENT_NO_WORKSPACE_MESSAGE}`);
  });

  it.each([
    ['沒有人提供 `fs` 服務', {}],
    ['`fs` 服務在、裡面沒有 backend', { fs: 'empty' as const }],
  ])('backend 從沒交進來也拒絕成沒有工作區：%s', async (_label, options) => {
    const mounted = mount(options);
    const refusal = refusalOf(
      await callThrough(mounted, mounted.sessions.root, [{ path: 'a' }], rootConfig('c'), 'error'),
    );
    expect(refusal.text).toBe(`Error: ${PRESENT_NO_WORKSPACE_MESSAGE}`);
  });

  /**
   * **不借 middleware 拿 backend**（#694）：以前掛一顆沒有鉤子的空殼 middleware，只為了接住 fold 交給
   * `useWithBackend` 工廠的那一個，每個 agent 的 stack 裡都多一顆空殼。dsh 的 present 是注入 `fs` 的工具。
   */
  it('present 不註冊任何 middleware', () => {
    const { registry } = mount({ fs: 'empty' });
    expect(registry.middleware.list()).toEqual([]);
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
  // **翻面過的絆索**（#453）：原本是工廠當場拋，現在驗在載入的時候，訊息因此指得出條目。
  it('maxFiles 不是正的安全整數就讓載入失敗', async () => {
    for (const maxFiles of [0, 1.5, Number.POSITIVE_INFINITY, -1]) {
      const bad = [createPresentPlugin({ maxFiles })];
      await expect(loadPlugins(bad)).rejects.toThrow('present#0 (present)');
      await expect(loadPlugins(bad)).rejects.toThrow('positive integer maxFiles');
    }
  });

  it('省略時由 schema 補上預設值', () => {
    expect(presentConfigSchema.parse({})).toEqual({ maxFiles: DEFAULT_MAX_FILES });
  });
});
