/**
 * **檔案工具失敗了，日誌上就是錯誤**——[#293](https://github.com/DemianLi/nexus-agent/issues/293)
 * 的驗收，量的是真的組裝、真的 fence 跑完之後會話日誌記下什麼、模型拿到什麼。
 *
 * 那一層自己的邏輯在 `@nexus/core` 的 `fs-tool-errors.test.ts`；這一份量的是掛進真的組裝之後：
 * 基座的檔案工具真的經過包過的 backend、fence 真的從 `apps/harness` 回報拒絕、碼真的跨過一整條
 * middleware 鏈讓圍堵記得到。
 *
 * 每一條都配一個反例（成功照舊是成功），否則一個把所有結果都標成錯誤的實作也全綠。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import type { SandboxMode } from '@nexus/core';
import { createFilesystemMiddleware } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { TextOnlyStateBackend } from './binary-read.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 一份日誌上每一顆 `tool/result` 的內容，依序。 */
function resultsOf(events: readonly SessionEvent[]): unknown[] {
  return events.flatMap((event) => {
    if (event.type !== 'tool/result') return [];
    // `message`（#305）是內容，這裡只比判別那幾格，逐 key 照舊。
    const { message: _message, ...verdict } = event.data;
    return [verdict];
  });
}

/** 一次工具呼叫的腳本：模型叫那一顆，拿到結果後收工。 */
interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

describe('檔案工具的失敗在日誌上記成錯誤', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-fs-tool-errors-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 在某一格模式下依序跑幾顆呼叫，回 root 那份日誌的 `tool/result` 與模型拿到的工具訊息。 */
  async function run(
    mode: SandboxMode,
    calls: readonly Call[],
    options: {
      readonly observationPolicy?: false;
      readonly backend?: Parameters<typeof createNexusAgent>[0]['backend'];
    } = {},
  ): Promise<{ results: unknown[]; messages: ToolMessage[] }> {
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          ...calls.map((call) => ({ content: '', toolCalls: [call] })),
          { content: '收工。' },
        ],
      }),
      backend: options.backend ?? new ContainedFilesystemBackend({ rootDir: root, mode }),
      checkpointer: new MemorySaver(),
      plugins: [],
      ...(options.observationPolicy === false && { observationPolicy: false }),
    });
    const sessions = new SessionRegistry('fs-tool-errors');
    const detach = attachSession(sessions);
    let state: { messages: BaseMessage[] };
    try {
      state = (await agent.invoke(toAgentInvocation('動手。'), {
        configurable: { thread_id: 'fs-tool-errors' },
      })) as { messages: BaseMessage[] };
    } finally {
      detach();
      await dispose();
    }
    const rootLog = sessions.list().find((entry) => entry.address.kind === 'root');
    return {
      results: resultsOf(rootLog?.log.events ?? []),
      messages: state.messages.filter((message): message is ToolMessage =>
        ToolMessage.isInstance(message),
      ),
    };
  }

  it('read-only 下 fence 擋下的 `write_file`：`isError` 帶 `FS_SANDBOX_DENIED`，模型看到的是 `Error: ` 加 fence 那句', async () => {
    const { results, messages } = await run('read-only', [
      { name: 'write_file', args: { file_path: '/a.txt', content: '一' } },
    ]);
    expect(results).toEqual([
      {
        callId: expect.any(String),
        isError: true,
        error: { name: 'FsError', code: 'FS_SANDBOX_DENIED' },
      },
    ]);
    expect(messages[0]?.status).toBe('error');
    // 仍是 fence 那句、前面是 `Error: `（#318），沒有被換成圍堵的措辭，也沒有兩個前綴。
    expect(String(messages[0]?.content)).toMatch(/^Error: \[containment\] .*這個 backend 是唯讀的/);
    expect(await readdir(root)).toEqual([]);
  }, 20000);

  it('反例：workspace-write 下同一顆寫得進去，日誌上是成功', async () => {
    const { results, messages } = await run('workspace-write', [
      { name: 'write_file', args: { file_path: '/a.txt', content: '一' } },
    ]);
    // 新建帶 `meta`（#617）：它讀原檔的那一次發生在失敗記錄的內側，不會把這次記成失敗。
    expect(results).toEqual([
      { callId: expect.any(String), isError: false, meta: { operation: 'create', diffs: [] } },
    ]);
    expect(messages[0]?.status).not.toBe('error');
    expect(await readdir(root)).toEqual(['a.txt']);
  }, 20000);

  it('讀一個不存在的檔是錯誤，帶 `FS_NOT_FOUND`（#1563）；空目錄的 `ls` 仍是成功', async () => {
    const { results, messages } = await run('workspace-write', [
      { name: 'read_file', args: { file_path: '/nope.txt' } },
      { name: 'ls', args: { path: '/' } },
    ]);
    expect(results).toEqual([
      {
        callId: expect.any(String),
        isError: true,
        error: { name: 'FsError', code: 'FS_NOT_FOUND' },
      },
      // `ls` 成功照帶 `meta`（#948）：這一格只在意它是成功，meta 的內容由 `tool-result-meta.test.ts` 管。
      {
        callId: expect.any(String),
        isError: false,
        meta: expect.objectContaining({ shape: 'paths' }),
      },
    ]);
    expect(messages[0]?.status).toBe('error');
    expect(messages[1]?.status).not.toBe('error');
  }, 20000);

  it('沒有原因碼可記的基座失敗（路徑跑出根）仍是錯誤，**不帶碼**', async () => {
    const { results, messages } = await run('workspace-write', [
      { name: 'read_file', args: { file_path: '/../x.txt' } },
    ]);
    expect(results).toEqual([{ callId: expect.any(String), isError: true }]);
    expect(messages[0]?.status).toBe('error');
  }, 20000);

  /**
   * 檔案工具失敗的原因碼（[#1563](https://github.com/DemianLi/nexus-agent/issues/1563) N0343／N0360）：backend 自己實作 `read`／`edit`／`write` 之後，
   * 失敗的原因在我們手上，不必解析基座的措辭。**斷言比對碼本身**，不是只看「有沒有錯」：拿掉 backend 裡那一行 `noteFsError` 就沒有碼，這些全紅。
   * 錯誤文字不變，由 `contained-backend.test.ts` 與 `contained-read-baseline.test.ts` 釘著。
   */
  describe('原因碼', () => {
    const failure = (code: string) => ({
      callId: expect.any(String),
      isError: true,
      error: { name: 'FsError', code },
    });

    it('讀一個目錄 → FS_NOT_REGULAR_FILE', async () => {
      await mkdir(join(root, 'dir'));
      const { results } = await run('workspace-write', [
        { name: 'read_file', args: { file_path: '/dir' } },
      ]);
      expect(results).toEqual([failure('FS_NOT_REGULAR_FILE')]);
    }, 20000);

    it('讀一個二進位檔、讀一個壞掉的 UTF-8 檔 → FS_NOT_TEXT', async () => {
      await writeFile(join(root, 'nul.bin'), Buffer.from([0x61, 0, 0x62]));
      await writeFile(join(root, 'bad.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
      const { results } = await run('workspace-write', [
        { name: 'read_file', args: { file_path: '/nul.bin' } },
        { name: 'read_file', args: { file_path: '/bad.txt' } },
      ]);
      expect(results).toEqual([failure('FS_NOT_TEXT'), failure('FS_NOT_TEXT')]);
    }, 20000);

    it('改檔時 old_string 命中兩處 → FS_AMBIGUOUS_EDIT；找不到、是空的 → FS_EDIT_NOT_FOUND', async () => {
      await writeFile(join(root, 'a.txt'), 'foo\nfoo\nbar\n', 'utf8');
      const { results } = await run('workspace-write', [
        { name: 'read_file', args: { file_path: '/a.txt' } },
        { name: 'edit_file', args: { file_path: '/a.txt', old_string: 'foo', new_string: 'X' } },
        { name: 'edit_file', args: { file_path: '/a.txt', old_string: 'nope', new_string: 'X' } },
        { name: 'edit_file', args: { file_path: '/a.txt', old_string: '', new_string: 'X' } },
      ]);
      expect(results.slice(1)).toEqual([
        failure('FS_AMBIGUOUS_EDIT'),
        failure('FS_EDIT_NOT_FOUND'),
        failure('FS_EDIT_NOT_FOUND'),
      ]);
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('foo\nfoo\nbar\n');
    }, 20000);

    // 沒掛工作區時的虛擬 FS（`TextOnlyStateBackend`）拒絕非文字的那一支也記碼；位元組只能由 `uploadFiles` 灌進 state，這裡直接餵一份。
    it('虛擬 FS 讀到位元組的檔 → FS_NOT_TEXT：binary-read 那一支也記碼', async () => {
      const at = '2026-10-23T00:00:00.000Z';
      const backend = new TextOnlyStateBackend({
        state: {
          files: {
            '/dot.png': {
              content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]),
              mimeType: 'image/png',
              created_at: at,
              modified_at: at,
            },
          },
        },
      } as never);
      const { results } = await run(
        'workspace-write',
        [{ name: 'read_file', args: { file_path: '/dot.png' } }],
        { backend },
      );
      expect(results).toEqual([failure('FS_NOT_TEXT')]);
    }, 20000);

    // 先讀後改關掉：策略的拒絕在工具跑之前，擋在 backend 前面；要走到 backend 自己的失敗得讓策略讓路。
    it('寫、改一個目錄 → FS_NOT_REGULAR_FILE', async () => {
      await mkdir(join(root, 'dir'));
      const { results } = await run(
        'workspace-write',
        [
          { name: 'write_file', args: { file_path: '/dir', content: 'x' } },
          { name: 'edit_file', args: { file_path: '/dir', old_string: 'a', new_string: 'b' } },
        ],
        { observationPolicy: false },
      );
      expect(results).toEqual([failure('FS_NOT_REGULAR_FILE'), failure('FS_NOT_REGULAR_FILE')]);
    }, 20000);

    it('改一個二進位檔、改一個壞掉的 UTF-8 檔 → FS_NOT_TEXT，檔案原封不動', async () => {
      const nul = Buffer.from([0x61, 0, 0x62]);
      const bad = Buffer.from([0x61, 0xff, 0xfe, 0x62]);
      await writeFile(join(root, 'nul.bin'), nul);
      await writeFile(join(root, 'bad.txt'), bad);
      const { results } = await run(
        'workspace-write',
        [
          { name: 'edit_file', args: { file_path: '/nul.bin', old_string: 'a', new_string: 'X' } },
          { name: 'edit_file', args: { file_path: '/bad.txt', old_string: 'a', new_string: 'X' } },
        ],
        { observationPolicy: false },
      );
      expect(results).toEqual([failure('FS_NOT_TEXT'), failure('FS_NOT_TEXT')]);
      expect(await readFile(join(root, 'nul.bin'))).toEqual(nul);
      expect(await readFile(join(root, 'bad.txt'))).toEqual(bad);
    }, 20000);

    it('沒讀過就改 → FS_NOT_OBSERVED：策略自己的碼，不是 backend 的原因碼', async () => {
      // 對照：`FS_NOT_FOUND` 等六個碼出在 backend 自己讀寫失敗的時候；策略的拒絕在工具跑之前，碼是它自己的。
      await writeFile(join(root, 'a.txt'), 'x\n', 'utf8');
      const { results } = await run('workspace-write', [
        { name: 'edit_file', args: { file_path: '/a.txt', old_string: 'x', new_string: 'y' } },
      ]);
      expect(results).toEqual([failure('FS_NOT_OBSERVED')]);
    }, 20000);

    it.skipIf(process.getuid?.() === 0)(
      '讀一個沒有權限的檔 → FS_PERMISSION_DENIED',
      async () => {
        await writeFile(join(root, 'locked.txt'), 'x\n', 'utf8');
        await chmod(join(root, 'locked.txt'), 0o000);
        try {
          const { results } = await run('workspace-write', [
            { name: 'read_file', args: { file_path: '/locked.txt' } },
          ]);
          expect(results).toEqual([failure('FS_PERMISSION_DENIED')]);
        } finally {
          await chmod(join(root, 'locked.txt'), 0o600);
        }
      },
      20000,
    );

    it('寫檔時空間用完 → FS_NO_SPACE（#2195）', async () => {
      const backend = new ContainedFilesystemBackend({
        rootDir: root,
        mode: 'workspace-write',
        atomicInternals: {
          afterWrite: () => {
            throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
              code: 'ENOSPC',
              errno: -28,
              syscall: 'write',
            });
          },
        },
      });
      const { results } = await run(
        'workspace-write',
        [{ name: 'write_file', args: { file_path: '/a.txt', content: 'x' } }],
        { backend },
      );
      expect(results).toEqual([failure('FS_NO_SPACE')]);
    }, 20000);

    it('反例：成功的讀與改不帶碼', async () => {
      await writeFile(join(root, 'a.txt'), 'foo\n', 'utf8');
      const { results } = await run('workspace-write', [
        { name: 'read_file', args: { file_path: '/a.txt' } },
        { name: 'edit_file', args: { file_path: '/a.txt', old_string: 'foo', new_string: 'bar' } },
      ]);
      for (const result of results) expect(result).toMatchObject({ isError: false });
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('bar\n');
    }, 20000);
  });

  /**
   * 「先讀後改」只認 `status === 'error'`，所以讀失敗從此真的是失敗。**缺檔的那一種不能因此掉了
   * 確認缺席**——那是之後受防護的新建所需要的授權（`observation.ts` 的 `observe`）。
   */
  it('讀一個缺檔之後新建它照樣過得去——確認缺席沒有因為讀變成錯誤而掉了', async () => {
    const { results } = await run('workspace-write', [
      { name: 'read_file', args: { file_path: '/new.txt' } },
      { name: 'write_file', args: { file_path: '/new.txt', content: '新' } },
    ]);
    expect(results).toEqual([
      {
        callId: expect.any(String),
        isError: true,
        error: { name: 'FsError', code: 'FS_NOT_FOUND' },
      },
      { callId: expect.any(String), isError: false, meta: { operation: 'create', diffs: [] } },
    ]);
    expect(await readdir(root)).toEqual(['new.txt']);
  }, 20000);

  /**
   * 反過來那一面：**存在的檔讀失敗（offset 超過檔尾）不再被記成「讀過」**。以前這次讀是狀態成功，
   * 策略記下「存在」，接著的覆蓋就是一次沒看過內容的盲改——`observation.ts` 的 `observe` 那段
   * 註解要擋的正是它。
   */
  it('存在的檔讀失敗之後，覆蓋它被「先讀後改」擋下', async () => {
    await writeFile(join(root, 'a.txt'), '舊\n', 'utf8');
    const { results } = await run('workspace-write', [
      { name: 'read_file', args: { file_path: '/a.txt', offset: 99 } },
      { name: 'write_file', args: { file_path: '/a.txt', content: '新' } },
    ]);
    expect(results).toEqual([
      { callId: expect.any(String), isError: true },
      {
        callId: expect.any(String),
        isError: true,
        error: { name: 'FsError', code: 'FS_NOT_OBSERVED' },
      },
    ]);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('舊\n');
  }, 20000);
});

describe('絆索：基座那幾處還是回裸字串', () => {
  /**
   * 這一層存在的唯一理由是 `deepagents` 的檔案工具把 backend 錯誤回成狀態成功的訊息。基座哪天改成
   * `toolError()`，這條會紅——那時 `@nexus/core` 的 `fs-tool-errors.ts` 可以拿掉（碼的那一半除外：
   * 基座不會知道 fence）。
   */
  it('沒有我們那一層時，`write_file` 的 backend 錯誤是狀態成功', async () => {
    const failing = {
      write: async () => ({ error: 'Failed to write' }),
    };
    const middleware = createFilesystemMiddleware({ backend: failing as never });
    const writeFile = (middleware.tools ?? []).find((tool) => tool.name === 'write_file');
    if (writeFile === undefined) throw new Error('基座的 filesystem middleware 沒有 write_file');
    const result: unknown = await writeFile.invoke({
      id: 'call-raw',
      name: 'write_file',
      args: { file_path: '/a.txt', content: '一' },
      type: 'tool_call',
    });
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect((result as ToolMessage).content).toBe('Failed to write');
    expect((result as ToolMessage).status).not.toBe('error');
  });
});
