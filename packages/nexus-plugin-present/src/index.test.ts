/**
 * `present` 這顆工具：**它檢查什麼、回什麼，以及什麼時候寫交付**。
 *
 * 這一檔走樹的這一層（[#1469](https://github.com/DemianLi/nexus-agent/issues/1469) 起 present 掛在 Cordis 樹上）：tools 提供者、
 * 會話查找與 fs 查找三位提供者加 `present` 那一列，backend 是真的磁碟（基座的 `FilesystemBackend`，虛擬路徑模式，同
 * `apps/harness` 的圍堵 backend）。`tool/call`、`tools/result` 的派發與 `tool/result` 由測試自己照圍堵的順序做
 * （`tool/call` → 本體 → 派發 `tools/result` → 同步記 `tool/result`，見 {@link settle}）；派發給的是提供者登記簿裡**每一位**
 * `tools/result` 觀察者，就是宿主折進 thread 的那一批。圍堵、真的圖與 pump 那一半在 `apps/harness/src/present-tool.test.ts`。
 *
 * **測試檔不受 SDK lint 管**（`PLUGIN_LINT_IGNORES`），所以這裡可以 import `@nexus/core`；`src/index.ts` 不行。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import {
  callThreadId,
  pickSessionForCall,
  SessionRegistry,
  toolCallSessionAddress,
  toolErrorOf,
} from '@nexus/core';
import type { FsService, SessionEvent, SessionLog } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { FsLookup } from '@nexus/fs';
import { createFsLookupProvider } from '@nexus/fs/provider';
import { checkConformance } from '@nexus/sdk';
import { createSessionLookupProvider } from '@nexus/session/provider';
import { createToolsProvider } from '@nexus/tools/provider';
import { FilesystemBackend } from 'deepagents';

import * as present from './index.js';
import {
  Config,
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
const opened: Context[] = [];
/** `tools/result` 的監聽者失敗（派發面把它們吞掉回報）：每個案例結束時必須是空的。 */
const observerFailures: unknown[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) await root.fiber.dispose();
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
  readonly tool: StructuredToolInterface;
  readonly sessions: SessionRegistry;
  readonly root: Context;
  readonly tools: ReturnType<typeof createToolsProvider>;
  readonly backend: FilesystemBackend | undefined;
}

/**
 * 掛一次：tools 提供者、會話查找、fs 查找與 `present` 那一列。`root` 給了就經 fs 把手交出 backend（fold 填值的那一格），
 * `workspace` 決定把手的 `hasWorkspace()` 答什麼（fold 時算的事實，這裡直接給）。`fs` 是 `'empty'` 時把手在、但裡面沒有
 * backend（fold 過、這次組裝一個 backend 都沒有），`'none'` 是行程裡沒有任何 thread 登記 fs（查找答 `not-attached`）。
 */
async function mount(
  options: {
    root?: string;
    workspace?: boolean;
    maxFiles?: number;
    fs?: 'empty' | 'none';
    /** 組裝點明著交的、不在磁碟上的路由前綴。 */
    offWorkspace?: readonly string[];
    /** plugin 用 `backend.mount()` 掛的路由（fold 併進 `offWorkspacePrefixes()`）。 */
    mounts?: readonly string[];
  } = {},
): Promise<Mounted> {
  const backend =
    options.root === undefined
      ? undefined
      : new FilesystemBackend({ rootDir: options.root, virtualMode: true });
  const prefixes = [...(options.offWorkspace ?? []), ...(options.mounts ?? [])];
  const handle: FsService = {
    backend: () => backend,
    offWorkspacePrefixes: () => prefixes,
    hasWorkspace: () => options.workspace ?? true,
    workspaceRoot: () => undefined,
    sharedWorkspacePrefix: () => undefined,
    skillSources: () => [],
  };
  const sessions = new SessionRegistry('unit');
  const tools = createToolsProvider();
  const root = new Context();
  opened.push(root);
  await root.plugin(Loader);
  const lookupFs = (config: unknown): FsLookup => {
    if (options.fs === 'none') return { kind: 'not-attached' };
    const address = toolCallSessionAddress(config);
    if (address === undefined) return { kind: 'unknown-caller' };
    return { kind: 'ok', fs: handle, address };
  };
  Object.assign(root.loader.builtins, {
    tools: tools.Provider,
    'session-lookup': createSessionLookupProvider((config) =>
      pickSessionForCall([sessions], config),
    ).Provider,
    fs: createFsLookupProvider(lookupFs).Provider,
    present,
  });
  const create = (entry: { id: string; name: string; config?: unknown }) =>
    root.loader.create(entry as never, null);
  await create({ id: 'tools', name: 'cordis:tools' });
  await create({ id: 'session-lookup', name: 'cordis:session-lookup' });
  await create({ id: 'fs', name: 'cordis:fs' });
  await create({
    id: 'present',
    name: 'cordis:present',
    config: options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles },
  });
  await root.loader.await();
  const entry = tools.entries().find((item) => item.tool.name === PRESENT_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒註冊上');
  return { tool: entry.tool, sessions, root, tools, backend };
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
 * ——`containment.ts` 的 `notifyToolResult` 與 `settle` 就是這樣接著的。交付在派發當下同步寫，所以落在 `tool/result` 之前（#1286，同 dsh）。
 * @param mounted - 掛好的組裝。
 * @param log - 呼叫者那一份日誌。
 * @param config - 這次呼叫的 config（位址從它算，同圍堵的 `exec.agent`）。
 * @param callId - 這顆結果是哪個呼叫的。
 * @param isError - 圍堵最後把這次判成錯誤與否。
 */
function notifyResult(
  listeners: readonly present.PresentDelivery['onResult'][],
  config: { toolCall: { id: string } },
  callId: string,
  isError: boolean,
): void {
  for (const listener of listeners) {
    try {
      void listener(
        {
          callId,
          name: PRESENT_TOOL_NAME,
          args: {},
          agent: toolCallSessionAddress(config),
          thread: callThreadId(config),
        },
        { isError },
      );
    } catch (error) {
      // 同宿主的隔離派發：一位觀察者拋了不擋別人，回報給測試收尾去驗。
      observerFailures.push(error);
    }
  }
}

function settle(
  mounted: Mounted,
  log: SessionLog,
  config: { toolCall: { id: string } },
  callId: string,
  isError: boolean,
): void {
  notifyResult(
    mounted.tools.resultListeners().map((entry) => entry.listener),
    config,
    callId,
    isError,
  );
  log.append('tool/result', { callId, isError });
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
  it('工具描述與 files 的說明逐字等於 dsh', async () => {
    const { tool } = await mount();
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
  it('回 dsh 的 `Presented <path>`，而且 `tools/result` 說成功的當下同步寫一筆交付（在 `tool/result` 之前）', async () => {
    const root = await workspace();
    await writeFile(join(root, '報告.docx'), Uint8Array.of(80, 75, 0, 255));
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out', 'a.csv'), 'a');
    const mounted = await mount({ root });
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
    // 派發與記 `tool/result` 同步做完，交付也在裡面：不需要讓出任何 microtask。
    const [delivery] = deliveries(log);
    // `description` 沒給的那一個整個不放 key。
    expect(delivery?.data).toEqual({ callId: 'c1', files });
    expect(delivery?.data.files[1]).not.toHaveProperty('description');
    // 落在配對的 `tool/call` 之後、`tool/result` 之前（dsh 的次序）。
    const callSeq = log.events.find((event) => event.type === 'tool/call')?.seq ?? Infinity;
    const resultSeq = log.events.find((event) => event.type === 'tool/result')?.seq ?? -Infinity;
    expect(delivery!.seq).toBeGreaterThan(callSeq);
    expect(delivery!.seq).toBeLessThan(resultSeq);
    // 只看目錄，不讀內容。
    expect(read).not.toHaveBeenCalled();
    expect(readRaw).not.toHaveBeenCalled();
  });

  it('結果被判成錯誤就不交付——照 dsh 被 post-execute 擋下的那一條', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = await mount({ root });
    const log = mounted.sessions.root;
    const result = await callThrough(mounted, log, [{ path: 'a' }], rootConfig('c1'), 'error');
    expect(textOf(result)).toBe('Presented a');
    expect(deliveries(log)).toEqual([]);
  });

  it('別的呼叫的結果不算數，等到自己那一顆才寫，而且只寫一次', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = await mount({ root });
    const log = mounted.sessions.root;
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('mine'), 'pending');
    settle(mounted, log, rootConfig('someone-else'), 'someone-else', false);
    expect(deliveries(log)).toEqual([]);
    settle(mounted, log, rootConfig('mine'), 'mine', false);
    // 同一個 callId 再來一顆也不重寫：表上那一筆在第一顆就取走了。
    settle(mounted, log, rootConfig('mine'), 'mine', false);
    expect(deliveries(log).map((event) => event.data.callId)).toEqual(['mine']);
  });

  it('同一個 callId 在結果落定前又進來一次（中斷後 resume）：只交付一次', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = await mount({ root });
    const log = mounted.sessions.root;
    // 第一次本體跑完、外層拋了中斷所以沒有結果；resume 之後同一個 callId 再跑一次。
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('again'), 'pending');
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('again'), 'pending');
    settle(mounted, log, rootConfig('again'), 'again', false);
    expect(deliveries(log).map((event) => event.data.callId)).toEqual(['again']);
  });

  /**
   * **#1469 Q3 (a)：交付表是行程級，不在列卸載時清。** 以前組裝收掉時整張清空（落定的結果不交付）；上樹後工具與 listener 一起被快照進
   * 開著的 thread，兩者共用同一個閉包，列被停用或重載就清表的話，懸著的那一次交付會寫不進日誌。這一條釘的是反過來的行為：
   * 本體跑完、`present` 那一列卸載、**之後**才落定——快照裡的那一對仍然把交付寫進日誌。
   */
  it('本體跑完之後那一列才卸載，落定時快照裡的那一對照樣交付（Q3 (a)：表不在卸載時清）', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = await mount({ root });
    const log = mounted.sessions.root;
    // 宿主折進 thread 的快照：工具與 listener 都在卸載之前握在手上。
    const [snapshotListener] = mounted.tools.resultListeners().map((entry) => entry.listener);
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('late'), 'pending');
    await mounted.root.loader.resolve('present').fiber?.ctx.fiber.dispose();
    // 提供者那一側的登記撤乾淨（新 thread 看不到它），但快照裡的 listener 還在。
    expect(mounted.tools.resultListeners()).toEqual([]);
    expect(mounted.tools.entries()).toEqual([]);
    notifyResult([snapshotListener!], rootConfig('late'), 'late', false);
    log.append('tool/result', { callId: 'late', isError: false });
    expect(deliveries(log).map((event) => event.data.callId)).toEqual(['late']);
  });

  it('子代理叫的寫進子代理那一份，root 那一份沒有', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = await mount({ root });
    const config = subagentConfig('sub-1');
    const found = pickSessionForCall([mounted.sessions], config);
    if (found.kind !== 'ok') throw new Error(`認不出子代理：${found.kind}`);
    await callThrough(mounted, found.log, [{ path: 'a' }], config);
    expect(deliveries(found.log).map((event) => event.data.callId)).toEqual(['sub-1']);
    expect(deliveries(mounted.sessions.root)).toEqual([]);
  });

  it('root 與子代理同一個 callId、都在等結果：各落定各的，不取走對方那一筆', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    await writeFile(join(root, 'b'), 'b');
    const mounted = await mount({ root });
    const rootLog = mounted.sessions.root;
    const subConfig = subagentConfig('same');
    const found = pickSessionForCall([mounted.sessions], subConfig);
    if (found.kind !== 'ok') throw new Error(`認不出子代理：${found.kind}`);
    await callThrough(mounted, rootLog, [{ path: 'a' }], rootConfig('same'), 'pending');
    await callThrough(mounted, found.log, [{ path: 'b' }], subConfig, 'pending');
    settle(mounted, found.log, subConfig, 'same', false);
    expect(deliveries(rootLog)).toEqual([]);
    expect(deliveries(found.log).map((event) => event.data.files[0]?.path)).toEqual(['b']);
    settle(mounted, rootLog, rootConfig('same'), 'same', false);
    expect(deliveries(rootLog).map((event) => event.data.files[0]?.path)).toEqual(['a']);
    expect(deliveries(found.log)).toHaveLength(1);
  });

  it('每次落定都把表上那一筆取走：先錯一次、同 callId 再成功一次，要再叫一次本體才有交付', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = await mount({ root });
    const log = mounted.sessions.root;
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('retry'), 'error');
    expect(deliveries(log)).toEqual([]);
    // 沒有再進本體就落定一顆成功的：表上沒有東西可寫。
    settle(mounted, log, rootConfig('retry'), 'retry', false);
    expect(deliveries(log)).toEqual([]);
    await callThrough(mounted, log, [{ path: 'a' }], rootConfig('retry'));
    expect(deliveries(log).map((event) => event.data.callId)).toEqual(['retry']);
  });

  it('只有一位 tools/result 監聽者，登記者就是 present 那一列', async () => {
    const mounted = await mount();
    expect(mounted.tools.resultListeners().map((entry) => entry.source)).toEqual(['present']);
  });
});

describe('拒絕', () => {
  it('找不到、目錄、工作區根、空路徑都拒絕，而且一筆交付都不寫', async () => {
    const root = await workspace();
    await mkdir(join(root, 'dir'));
    const mounted = await mount({ root });
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
      const mounted = await mount({ root, offWorkspace: ['/stash'], mounts: ['/mounted/'] });
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
      const mounted = await mount({ root, offWorkspace: ['/stash/'], mounts: ['/mounted/'] });
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
      const mounted = await mount({ root, offWorkspace: ['/stash/'] });
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
    const mounted = await mount({ root, maxFiles: 2 });
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
    const mounted = await mount({ root });
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
    const mounted = await mount({ root, workspace: false });
    const refusal = refusalOf(
      await callThrough(mounted, mounted.sessions.root, [{ path: 'a' }], rootConfig('c'), 'error'),
    );
    expect(refusal.text).toBe(`Error: ${PRESENT_NO_WORKSPACE_MESSAGE}`);
  });

  it.each([
    ['行程裡沒有任何 thread 登記 fs 把手', { fs: 'none' as const }],
    ['fs 把手在、裡面沒有 backend', { fs: 'empty' as const }],
  ])('backend 從沒交進來也拒絕成沒有工作區：%s', async (_label, options) => {
    const mounted = await mount(options);
    const refusal = refusalOf(
      await callThrough(mounted, mounted.sessions.root, [{ path: 'a' }], rootConfig('c'), 'error'),
    );
    expect(refusal.text).toBe(`Error: ${PRESENT_NO_WORKSPACE_MESSAGE}`);
  });

  it('查找認不出呼叫者（沒有 configurable）也是同一句沒有工作區', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = await mount({ root });
    const log = mounted.sessions.root;
    // 日誌認得、fs 認不得的組合不存在於同一次呼叫；這裡直接叫工具，位址算不出時兩邊都先拒。
    const answer = await mounted.tool.invoke({ files: [{ path: 'a' }] }, {
      toolCall: { id: 'c' },
    } as never);
    expect(refusalOf(answer).text).toBe(`Error: ${PRESENT_NO_SESSION_MESSAGE}`);
    expect(deliveries(log)).toEqual([]);
  });

  it('拿不到呼叫者那一份日誌、或沒有 callId，就拒絕', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a'), 'a');
    const mounted = await mount({ root });
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
    const mounted = await mount();
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
    const mounted = await mount({ root });
    expect(
      textOf(
        await callThrough(mounted, mounted.sessions.root, [{ path: 'link' }], rootConfig('c')),
      ),
    ).toBe('Presented link');
  });
});

describe('設定（#453）', () => {
  // **翻面過的絆索**：原本是工廠當場拋，現在驗在載入的時候（Loader 用 manifest 的 `config` 驗），訊息因此指得出條目。
  it('maxFiles 不是正的安全整數就讓載入失敗', () => {
    for (const maxFiles of [0, 1.5, Number.POSITIVE_INFINITY, -1]) {
      const result = Config.safeParse({ maxFiles });
      expect(result.success, String(maxFiles)).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('positive integer maxFiles');
    }
  });

  it('未知欄位讓載入失敗（登記的偏離：dsh 放行）', () => {
    expect(Config.safeParse({ maxFiles: 2, extra: 1 }).success).toBe(false);
  });

  it('省略時由 schema 補上預設值', () => {
    expect(presentConfigSchema.parse({})).toEqual({ maxFiles: DEFAULT_MAX_FILES });
  });
});

describe('樹上這一列（#1469）', () => {
  it('一致性套件全格通過：manifest、匯出形式、卸載後登記處回到空的、缺提供者停在 PENDING', async () => {
    let latest = createToolsProvider();
    const failures = await checkConformance({
      row: 'present',
      module: present,
      config: {},
      providers: {
        tools: () => {
          latest = createToolsProvider();
          return latest.Provider;
        },
        sessionLookup: () => createSessionLookupProvider(() => ({ kind: 'not-attached' })).Provider,
        fs: () => createFsLookupProvider(() => ({ kind: 'not-attached' })).Provider,
      },
      residue: () => latest.entries().length + latest.resultListeners().length,
    });
    expect(failures).toEqual([]);
  });

  it('manifest 宣告三個必要依賴：tools（^1.3.0）、sessionLookup（^1.0.0）、fs（^2.0.0）；沒有 default 匯出', () => {
    expect(present.manifest.consumes).toEqual([
      { token: 'tools', range: '^1.3.0' },
      { token: 'sessionLookup', range: '^1.0.0' },
      { token: 'fs', range: '^2.0.0' },
    ]);
    expect(present.manifest.provides).toEqual([]);
    expect(present.inject).toEqual({
      tools: { range: '^1.3.0' },
      sessionLookup: { range: '^1.0.0' },
      fs: { range: '^2.0.0' },
    });
    expect('default' in present).toBe(false);
  });

  it('提供者沒有 onResult（tools 契約低於 1.3.0 的形狀）就拒絕掛載：工具沒登記，不讓它靜靜不交付', async () => {
    const tools = createToolsProvider();
    // 同一個提供者，只是把 `onResult` 遮掉：宣告的版本仍是 1.3.0，所以擋下它的是 `apply` 裡的守衛，不是版本範圍。
    class WithoutOnResult extends tools.Provider {
      constructor(ctx: Context) {
        super(ctx);
        Object.defineProperty(this, 'onResult', { value: undefined });
      }
    }
    const root = new Context();
    opened.push(root);
    await root.plugin(Loader);
    const sessions = new SessionRegistry('unit');
    Object.assign(root.loader.builtins, {
      tools: WithoutOnResult,
      'session-lookup': createSessionLookupProvider((config) =>
        pickSessionForCall([sessions], config),
      ).Provider,
      fs: createFsLookupProvider(() => ({ kind: 'not-attached' })).Provider,
      present,
    });
    const create = (entry: { id: string; name: string; config?: unknown }) =>
      root.loader.create(entry as never, null);
    await create({ id: 'tools', name: 'cordis:tools' });
    await create({ id: 'session-lookup', name: 'cordis:session-lookup' });
    await create({ id: 'fs', name: 'cordis:fs' });
    await create({ id: 'present', name: 'cordis:present', config: {} });
    await root.loader.await();
    expect(tools.entries()).toEqual([]);
    expect(tools.resultListeners()).toEqual([]);
  });
});
