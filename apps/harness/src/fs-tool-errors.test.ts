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

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 一份日誌上每一顆 `tool/result` 的內容，依序。 */
function resultsOf(events: readonly SessionEvent[]): unknown[] {
  return events.flatMap((event) => (event.type === 'tool/result' ? [event.data] : []));
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
  ): Promise<{ results: unknown[]; messages: ToolMessage[] }> {
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          ...calls.map((call) => ({ content: '', toolCalls: [call] })),
          { content: '收工。' },
        ],
      }),
      backend: new ContainedFilesystemBackend({ rootDir: root, mode }),
      checkpointer: new MemorySaver(),
      plugins: [],
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

  it('read-only 下 fence 擋下的 `write_file`：`isError` 帶 `FS_SANDBOX_DENIED`，模型看到的字不變', async () => {
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
    // 字不變：仍是 fence 那句，開頭是 `[containment]`，沒有被換成圍堵的措辭或多一個前綴。
    expect(String(messages[0]?.content)).toMatch(/^\[containment\] .*這個 backend 是唯讀的/);
    expect(await readdir(root)).toEqual([]);
  }, 20000);

  it('反例：workspace-write 下同一顆寫得進去，日誌上是成功', async () => {
    const { results, messages } = await run('workspace-write', [
      { name: 'write_file', args: { file_path: '/a.txt', content: '一' } },
    ]);
    expect(results).toEqual([{ callId: expect.any(String), isError: false }]);
    expect(messages[0]?.status).not.toBe('error');
    expect(await readdir(root)).toEqual(['a.txt']);
  }, 20000);

  it('基座自己的失敗（讀一個不存在的檔）也是錯誤，**不帶碼**；空目錄的 `ls` 仍是成功', async () => {
    const { results, messages } = await run('workspace-write', [
      { name: 'read_file', args: { file_path: '/nope.txt' } },
      { name: 'ls', args: { path: '/' } },
    ]);
    expect(results).toEqual([
      { callId: expect.any(String), isError: true },
      { callId: expect.any(String), isError: false },
    ]);
    expect(messages[0]?.status).toBe('error');
    expect(messages[1]?.status).not.toBe('error');
  }, 20000);

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
      { callId: expect.any(String), isError: true },
      { callId: expect.any(String), isError: false },
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
