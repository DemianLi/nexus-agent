/**
 * 記錄器在真的 registry、真的 session runner 上：日誌事件怎麼推動它，middleware 的兩個鉤子什麼時候擷取、什麼時候記。
 *
 * 走真的圖、真的 wire 的那一條在 `@nexus/harness` 的 `workspace-changes.test.ts`；這裡驗那條路製造不出來的時序：
 * 停在核准點、中止之後補記、下一輪已經開始、子代理的呼叫、上限與收尾。
 *
 * 工具本體由測試自己扮演：`wrapToolCall` 的 `handler` 就是那次改檔。
 */

import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRegistry, createSessionRunner, SessionRegistry } from '@nexus/core';
import type { SessionEvent, SessionLog } from '@nexus/core';

import { createWorkspaceChanges, WORKSPACE_CHANGES_LIMITS } from './index.js';
import type { WorkspaceChangesLimits } from './index.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

/** root 的工具呼叫長這樣；子代理的多一段父圖那次 `task`。 */
const ROOT_TOOL = { checkpoint_ns: 'tools:root-1' };
const SUBAGENT_TOOL = { checkpoint_ns: 'tools:task-1|tools:sub-1' };
const ROOT_AFTER = { checkpoint_ns: 'afterAgent:root-1' };
const SUBAGENT_AFTER = { checkpoint_ns: 'tools:task-1|afterAgent:sub-1' };

interface Mounted {
  readonly root: string;
  readonly tempRoot: string;
  readonly log: SessionLog;
  readonly warnings: string[];
  readonly service: ReturnType<typeof createWorkspaceChanges>['service'];
  /** 扮演一顆檔案工具：擷取、等排著的工作，然後跑 `body`（那次改檔）。 */
  tool(
    name: string,
    args: Record<string, unknown>,
    body: () => Promise<void>,
    configurable?: unknown,
  ): Promise<void>;
  /** 正常收尾那一步。 */
  afterAgent(configurable?: unknown): Promise<void>;
  /** 收掉這次組裝：跑 lifecycle 的每一個收尾。 */
  dispose(): Promise<void>;
  /** 這份日誌上的改動紀錄。 */
  changes(): SessionEvent[];
  /**
   * 等記錄器排著的工作全部落定。**走產品路徑上的那一條**：任何一顆工具經過 `wrapToolCall` 都會等它
   * （照 dsh 的 `tools/pre-execute`），這裡叫一顆不改檔的。繞事件迴圈幾圈等不到——擷取與比較是檔案 I/O。
   */
  settle(): Promise<void>;
}

async function mount(
  files: Record<string, string | Buffer> = {},
  limits: Partial<WorkspaceChangesLimits> = {},
): Promise<Mounted> {
  const root = await directory('nexus-wc-root-');
  const tempRoot = await directory('nexus-wc-temp-');
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  const warnings: string[] = [];
  const { plugin, service } = createWorkspaceChanges({
    root,
    tempRoot,
    limits,
    warn: (message) => void warnings.push(message),
  });
  const registry = createRegistry();
  const exit = registry.enter({ id: 'workspace-changes#0', name: plugin.name });
  void plugin.apply(registry);
  exit();
  const sessions = new SessionRegistry('wc');
  registry.sessions.bind(sessions);
  const log = sessions.root;
  createSessionRunner({
    address: { kind: 'root' },
    log,
    installers: registry.sessions.installers(),
  });
  const [entry] = registry.middleware.list();
  const middleware = entry!.value.middleware as unknown as {
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
    afterAgent: (state: unknown, runtime: unknown) => Promise<unknown>;
  };
  return {
    root,
    tempRoot,
    log,
    warnings,
    service,
    async tool(name, args, body, configurable = ROOT_TOOL) {
      await middleware.wrapToolCall(
        { toolCall: { id: `call-${name}`, name, args }, runtime: { configurable } },
        async () => {
          await body();
          return 'ok';
        },
      );
    },
    async afterAgent(configurable = ROOT_AFTER) {
      await middleware.afterAgent({}, { configurable });
    },
    async dispose() {
      for (const { value } of registry.lifecycle.disposers()) await value();
    },
    changes: () => log.events.filter((event) => event.type === 'workspace/changes'),
    async settle() {
      await middleware.wrapToolCall(
        {
          toolCall: { id: 'settle', name: 'read_file', args: {} },
          runtime: { configurable: ROOT_TOOL },
        },
        async () => 'ok',
      );
    },
  };
}

/** 一顆 `tool/result`：記錄器靠它知道這一輪跑過工具。 */
function result(log: SessionLog, callId = 'c'): void {
  log.append('tool/result', { callId, isError: false });
}

/** 繞事件迴圈幾圈。**只用在什麼都不該排的情境**；有排工作時用 `settle()`，檔案 I/O 繞幾圈等不到。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('一輪', () => {
  it('正常收尾：在輪內記、摘要照顯示路徑排序、行數與比較對得上', async () => {
    const m = await mount({ 'a.md': 'one\ntwo\nthree\n', 'gone.md': 'bye\n' });
    m.log.append('turn/start', { kind: 'message', text: '改。' });
    await m.tool('edit_file', { file_path: '/a.md', old_string: 'two', new_string: '2' }, () =>
      writeFile(join(m.root, 'a.md'), 'one\n2\nthree\n'),
    );
    await m.tool('write_file', { file_path: 'new.md', content: 'hi\n' }, () =>
      writeFile(join(m.root, 'new.md'), 'hi\n'),
    );
    await m.tool('delete', { file_path: '/gone.md' }, () => unlink(join(m.root, 'gone.md')));
    result(m.log);
    await m.afterAgent();
    m.log.append('turn/end', {});
    await m.settle();

    const [event] = m.changes();
    expect(m.changes()).toHaveLength(1);
    expect(event!.data).toEqual({});
    // 在輪內：落在 `turn/end` 之前。
    expect(m.log.events.at(-1)?.type).toBe('turn/end');
    expect(m.service.summary(event!.seq)).toEqual({
      files: [
        { path: 'a.md', display: 'a.md', added: 1, deleted: 1 },
        { path: 'gone.md', display: 'gone.md', added: 0, deleted: 1 },
        { path: 'new.md', display: 'new.md', added: 1, deleted: 0 },
      ],
      total: 3,
      added: 2,
      deleted: 2,
    });
    const signal = new AbortController().signal;
    expect(await m.service.diff(event!.seq, 0, signal)).toEqual({
      kind: 'text',
      path: 'a.md',
      display: 'a.md',
      before: true,
      after: true,
      coarse: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [' one', '-two', '+2', ' three'],
        },
      ],
    });
    expect(await m.service.diff(event!.seq, 1, signal)).toMatchObject({
      before: true,
      after: false,
    });
    expect(await m.service.diff(event!.seq, 2, signal)).toMatchObject({
      before: false,
      after: true,
    });
    expect(await m.service.diff(event!.seq, 3, signal)).toBeUndefined();
    expect(m.service.summary(event!.seq + 1)).toBeUndefined();
    expect(m.warnings).toEqual([]);
  });

  it('收尾之後的 `turn/end` 不再記一次', async () => {
    const m = await mount({ 'a.md': 'a\n' });
    m.log.append('turn/start', { kind: 'message', text: '改。' });
    await m.tool('edit_file', { file_path: 'a.md', old_string: 'a', new_string: 'b' }, () =>
      writeFile(join(m.root, 'a.md'), 'b\n'),
    );
    result(m.log);
    await m.afterAgent();
    m.log.append('turn/end', {});
    await m.settle();
    expect(m.changes()).toHaveLength(1);
  });

  it('沒有工具結果的一輪、改回原樣的檔：都不記', async () => {
    const m = await mount({ 'a.md': 'a\n' });
    m.log.append('turn/start', { kind: 'message', text: '聊天。' });
    await m.afterAgent();
    m.log.append('turn/end', {});
    m.log.append('turn/start', { kind: 'message', text: '改了又改回來。' });
    await m.tool('edit_file', { file_path: 'a.md', old_string: 'a', new_string: 'b' }, () =>
      writeFile(join(m.root, 'a.md'), 'b\n'),
    );
    await m.tool('edit_file', { file_path: 'a.md', old_string: 'b', new_string: 'a' }, () =>
      writeFile(join(m.root, 'a.md'), 'a\n'),
    );
    result(m.log);
    await m.afterAgent();
    m.log.append('turn/end', {});
    await m.settle();
    expect(m.changes()).toEqual([]);
  });

  it('一輪裡同一個路徑只擷取第一次：比較的是這一輪開始時的內容', async () => {
    const m = await mount({ 'a.md': 'v1\n' });
    m.log.append('turn/start', { kind: 'message', text: '改兩次。' });
    for (const next of ['v2\n', 'v3\n']) {
      await m.tool('write_file', { file_path: 'a.md', content: next }, () =>
        writeFile(join(m.root, 'a.md'), next),
      );
    }
    result(m.log);
    await m.afterAgent();
    const [event] = m.changes();
    const diff = await m.service.diff(event!.seq, 0, new AbortController().signal);
    expect(diff).toMatchObject({ hunks: [{ lines: ['-v1', '+v3'] }] });
  });
});

describe('輪的邊界', () => {
  it('停在核准點不是收尾：那顆 `turn/end` 不記，resume 之後整輪記一次', async () => {
    const m = await mount({ 'a.md': 'a\n', 'b.md': 'b\n' });
    m.log.append('turn/start', { kind: 'message', text: '改兩個。' });
    await m.tool('edit_file', { file_path: 'a.md', old_string: 'a', new_string: 'A' }, () =>
      writeFile(join(m.root, 'a.md'), 'A\n'),
    );
    result(m.log, 'c1');
    m.log.append('interrupt/raised', { interruptId: 'i1' });
    m.log.append('turn/end', {});
    await m.settle();
    expect(m.changes()).toEqual([]);

    m.log.append('turn/start', { kind: 'resume' });
    await m.tool('edit_file', { file_path: 'b.md', old_string: 'b', new_string: 'B' }, () =>
      writeFile(join(m.root, 'b.md'), 'B\n'),
    );
    result(m.log, 'c2');
    await m.afterAgent();
    m.log.append('turn/end', {});
    await m.settle();
    const [event] = m.changes();
    expect(m.changes()).toHaveLength(1);
    expect(m.service.summary(event!.seq)?.files.map((file) => file.path)).toEqual(['a.md', 'b.md']);
  });

  it('中止、失敗：`turn/end`／`turn/failed` 之後補記', async () => {
    for (const end of ['aborted', 'failed'] as const) {
      const m = await mount({ 'a.md': 'a\n' });
      m.log.append('turn/start', { kind: 'message', text: '改。' });
      await m.tool('edit_file', { file_path: 'a.md', old_string: 'a', new_string: 'b' }, () =>
        writeFile(join(m.root, 'a.md'), 'b\n'),
      );
      result(m.log);
      if (end === 'aborted') {
        m.log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });
      } else {
        m.log.append('turn/failed', { message: '炸了' });
      }
      await m.settle();
      expect(m.changes(), end).toHaveLength(1);
      expect(m.log.events.at(-1)?.type, end).toBe('workspace/changes');
    }
  });

  it('補記之前下一輪已經開始：不記，留一行 warn——記下去會被 web 算進下一輪', async () => {
    const m = await mount({ 'a.md': 'a\n' });
    m.log.append('turn/start', { kind: 'message', text: '改。' });
    await m.tool('edit_file', { file_path: 'a.md', old_string: 'a', new_string: 'b' }, () =>
      writeFile(join(m.root, 'a.md'), 'b\n'),
    );
    result(m.log);
    m.log.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });
    // 排著的那一輪（例如停止時已經排隊的下一句）緊接著開跑。
    m.log.append('turn/start', { kind: 'message', text: '下一句。' });
    await m.settle();
    expect(m.changes()).toEqual([]);
    expect(m.warnings).toEqual(['workspace-changes: 下一輪已經開始，上一輪的改動紀錄不記']);
  });

  it('子代理的擷取算進 root 這一輪；子代理自己收尾不記', async () => {
    const m = await mount({ 'a.md': 'a\n' });
    m.log.append('turn/start', { kind: 'message', text: '委派。' });
    await m.tool(
      'edit_file',
      { file_path: 'a.md', old_string: 'a', new_string: 'b' },
      () => writeFile(join(m.root, 'a.md'), 'b\n'),
      SUBAGENT_TOOL,
    );
    await m.afterAgent(SUBAGENT_AFTER);
    // 子代理收工時 root 那一份還沒有這一輪的結果；`task` 的結果回到 root 才有。
    expect(m.changes()).toEqual([]);
    result(m.log, 'task');
    await m.afterAgent();
    const [event] = m.changes();
    expect(m.service.summary(event!.seq)?.files.map((file) => file.path)).toEqual(['a.md']);
  });

  it('續接：接上時已經在的舊輪重播過去，不會補記、也不建暫存目錄', async () => {
    const root = await directory('nexus-wc-seed-');
    const tempRoot = await directory('nexus-wc-temp-');
    const { plugin } = createWorkspaceChanges({ root, tempRoot });
    const registry = createRegistry();
    const exit = registry.enter({ id: 'workspace-changes#0', name: plugin.name });
    void plugin.apply(registry);
    exit();
    const sessions = new SessionRegistry('seeded');
    const log = sessions.root;
    log.append('turn/start', { kind: 'message', text: '以前那一輪。' });
    log.append('tool/result', { callId: 'old', isError: false });
    createSessionRunner({
      address: { kind: 'root' },
      log,
      installers: registry.sessions.installers(),
    });
    log.append('turn/end', {});
    await drain();
    expect(log.events.some((event) => event.type === 'workspace/changes')).toBe(false);
    // 沒開過任何一輪，暫存目錄也不會建。
    expect(await readdir(tempRoot)).toEqual([]);
  });
});

describe('上限與內容', () => {
  it('過大的檔列出來但沒有行數、拒絕比較；二進位同樣；`maxFiles` 切清單不切總數', async () => {
    const m = await mount(
      { 'big.txt': 'x'.repeat(16), 'bin.dat': Buffer.from([0, 1, 2]), 'c.md': 'c\n' },
      { maxFileBytes: 8, maxFiles: 2 },
    );
    m.log.append('turn/start', { kind: 'message', text: '改。' });
    await m.tool('write_file', { file_path: 'big.txt', content: 'y' }, () =>
      writeFile(join(m.root, 'big.txt'), 'y'),
    );
    await m.tool('write_file', { file_path: 'bin.dat', content: '' }, () =>
      writeFile(join(m.root, 'bin.dat'), Buffer.from([0, 9])),
    );
    await m.tool('edit_file', { file_path: 'c.md', old_string: 'c', new_string: 'd' }, () =>
      writeFile(join(m.root, 'c.md'), 'd\n'),
    );
    result(m.log);
    await m.afterAgent();
    const [event] = m.changes();
    const summary = m.service.summary(event!.seq);
    expect(summary).toEqual({
      files: [
        { path: 'big.txt', display: 'big.txt', added: 0, deleted: 0, oversized: true },
        { path: 'bin.dat', display: 'bin.dat', added: 0, deleted: 0, binary: true },
      ],
      total: 3,
      added: 1,
      deleted: 1,
    });
    const signal = new AbortController().signal;
    expect(await m.service.diff(event!.seq, 0, signal)).toEqual({
      kind: 'oversized',
      path: 'big.txt',
      display: 'big.txt',
    });
    expect(await m.service.diff(event!.seq, 1, signal)).toEqual({
      kind: 'binary',
      path: 'bin.dat',
      display: 'bin.dat',
    });
  });

  it('上限要是正的安全整數，照 dsh 在建立時就驗', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createWorkspaceChanges({ root: tmpdir(), limits: { maxFiles: bad } })).toThrow(
        'workspace-changes requires a positive integer maxFiles',
      );
    }
    expect(WORKSPACE_CHANGES_LIMITS).toEqual({
      maxFiles: 500,
      maxFileBytes: 2 * 1024 * 1024,
      diffTimeoutMs: 100,
    });
  });

  it('一份只能掛一次組裝', () => {
    const { plugin } = createWorkspaceChanges({ root: tmpdir() });
    const apply = () => {
      const registry = createRegistry();
      const exit = registry.enter({ id: 'workspace-changes#0', name: plugin.name });
      try {
        void plugin.apply(registry);
      } finally {
        exit();
      }
    };
    apply();
    expect(apply).toThrow('只能掛一次組裝');
  });
});

describe('暫存目錄', () => {
  it('建出來是 0700（多人共用主機上別人讀不到副本），收掉時整個刪掉、摘要也不再服務', async () => {
    const m = await mount({ 'a.md': 'secret\n' });
    m.log.append('turn/start', { kind: 'message', text: '改。' });
    await m.tool('edit_file', { file_path: 'a.md', old_string: 'secret', new_string: 'x' }, () =>
      writeFile(join(m.root, 'a.md'), 'x\n'),
    );
    result(m.log);
    await m.afterAgent();
    const [scratch] = await readdir(m.tempRoot);
    expect(scratch).toMatch(/^nexus-workspace-changes-/);
    const path = join(m.tempRoot, scratch!);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    // 副本真的在裡面——所以權限擋的是真的東西。
    const copies = await readdir(join(path, 'captures'));
    const contents = await Promise.all(
      copies.map((copy) => readFile(join(path, 'captures', copy), 'utf8')),
    );
    expect(contents).toContain('secret\n');
    const [event] = m.changes();
    await m.dispose();
    expect(await readdir(m.tempRoot)).toEqual([]);
    expect(m.service.summary(event!.seq)).toBeUndefined();
    expect(await m.service.diff(event!.seq, 0, new AbortController().signal)).toBeUndefined();
  });
});
