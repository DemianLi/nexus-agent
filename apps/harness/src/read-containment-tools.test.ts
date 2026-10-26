/**
 * **經往外指的符號連結讀，工具層與日誌上長什麼樣**——[#1982](https://github.com/DemianLi/nexus-agent/issues/1982) 的驗收：
 * 每一顆讀得到內容的工具都回錯誤、帶 `FS_SANDBOX_DENIED`，根外的內容不進會話日誌的任何一則事件。
 * backend 那一層的逐入口斷言在 `contained-backend.test.ts`〈讀取面的圍堵〉；這裡量的是真的組裝、真的工具、真的日誌。
 *
 * **走產品組裝**：`createCliAgent` ＋ 出貨清單，模型換成腳本提供者。**零憑證、零外部連線。**
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { SessionEvent } from '@nexus/core';
import { SUBMIT_RECORD_TOOL_NAME } from '@nexus/plugin-submit-record';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';

const shipped = await shippedPlugins();
const SECRET = 'NEXUS_API_KEY=sk-根外的假金鑰';

/** 一份日誌上每一顆 `tool/result` 的判別那幾格，依序。 */
function resultsOf(events: readonly SessionEvent[]): unknown[] {
  return events.flatMap((event) => {
    if (event.type !== 'tool/result') return [];
    const { message: _message, ...verdict } = event.data;
    return [verdict];
  });
}

/** 工具訊息的文字；`read_file` 回的是區塊陣列。 */
const textOf = (message: ToolMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .map((block) => ((block as { text?: unknown }).text as string | undefined) ?? '')
        .join('');

const DENIED = {
  callId: expect.any(String),
  isError: true,
  error: { name: 'FsError', code: 'FS_SANDBOX_DENIED' },
};

describe('經往外指的符號連結讀：工具回錯誤、內容不進日誌', () => {
  let base: string;
  let root: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'nexus-read-containment-'));
    root = join(base, 'workspace');
    const home = join(base, 'home');
    await mkdir(root);
    await mkdir(home);
    await writeFile(join(home, '.env'), `${SECRET}\n`);
    await writeFile(join(home, 'visitors.csv'), `${SECRET},日期\n`);
    // 工作區裡一條指向 harness home 的目錄連結，一條直接指向 `.env` 的檔案連結。
    await symlink(home, join(root, 'home'));
    await symlink(join(home, '.env'), join(root, 'env'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('read_file、ls、grep、glob 都帶 FS_SANDBOX_DENIED', async () => {
    const calls = [
      { name: 'read_file', args: { file_path: '/home/.env' } },
      { name: 'read_file', args: { file_path: '/env' } },
      { name: 'ls', args: { path: '/home' } },
      { name: 'grep', args: { pattern: 'sk-', path: '/home' } },
      { name: 'glob', args: { pattern: '*', path: '/home' } },
    ];
    const built = await createCliAgent(
      { live: false, workspace: root, sandbox: 'workspace-write' },
      withScriptedModel(shipped, [
        ...calls.map((call) => ({ content: '', toolCalls: [call] })),
        { content: '收工。' },
      ]),
      root,
    );
    const detach = built.attachSession(built.sessions);
    let state: { messages: BaseMessage[] };
    try {
      state = (await built.agent.invoke(toAgentInvocation('看看 home。'), {
        configurable: { thread_id: 'read-containment' },
      })) as { messages: BaseMessage[] };
    } finally {
      detach();
      await built.dispose();
    }

    expect(resultsOf(built.sessionLog.events)).toEqual(calls.map(() => DENIED));
    // 模型看到的是拒絕本身，不是「沒有檔案」這種會被當成答案的空結果。
    const seen = state.messages
      .filter((message): message is ToolMessage => ToolMessage.isInstance(message))
      .map((message) => [message.status, textOf(message).split('：')[0]]);
    expect(seen).toEqual([
      ['error', 'Error: [containment] 拒絕 read "/home/.env"'],
      ['error', 'Error: [containment] 拒絕 read "/env"'],
      ['error', 'Error listing files: [containment] 拒絕 ls "/home"'],
      ['error', 'Error: [containment] 拒絕 grep "/home"'],
      ['error', 'Error finding files: [containment] 拒絕 glob "/home"'],
    ]);
    expect(JSON.stringify(built.sessionLog.events)).not.toContain('sk-根外的假金鑰');
  }, 30000);

  it('submit_record 經連結讀表頭（readRaw）：表頭不進日誌', async () => {
    const config = { configurable: { thread_id: 'read-containment-submit' } };
    const built = await createCliAgent(
      { live: false, workspace: root, sandbox: 'workspace-write' },
      withScriptedModel(shipped, [
        {
          content: '',
          toolCalls: [
            {
              name: SUBMIT_RECORD_TOOL_NAME,
              // 欄名刻意對不上表頭：讀得到表頭的話工具會把整行表頭寫進拒絕理由，讀表頭就是唯一的關卡。
              args: { file_path: '/home/visitors.csv', record: { 姓名: '阿明' } },
            },
          ],
        },
        { content: '收工。' },
      ]),
      root,
    );
    const detach = built.attachSession(built.sessions);
    try {
      await built.agent.invoke(toAgentInvocation('登記一位訪客。'), config);
      await built.agent.invoke(
        new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never,
        config,
      );
    } finally {
      detach();
      await built.dispose();
    }

    expect(resultsOf(built.sessionLog.events)).toEqual([DENIED]);
    expect(JSON.stringify(built.sessionLog.events)).not.toContain('sk-根外的假金鑰');
  }, 30000);
});
