/**
 * **`submit_record` 被 fence 擋下，日誌上帶 `FS_SANDBOX_DENIED`**——[#316](https://github.com/DemianLi/nexus-agent/issues/316)
 * 的驗收，量的是真的組裝、真的 fence、核准之後 resume 的那一趟。
 *
 * 基座的檔案工具被同一道 fence 擋下時帶這個碼（#293，`fs-tool-errors.test.ts`）。`submit_record` 走的
 * 是同一個 backend 物件，所以同一條政策的拒絕在日誌上該是同一個形狀；數 `FS_SANDBOX_DENIED` 的離線
 * 掃描才不會漏掉它。
 *
 * **一定要走核准之後的那一趟**：這顆工具的本體只在 resume 之後跑，碼要跨得過那一次重跑。
 *
 * 每一條都配對照：同一個模式、同一顆工具的另一種失敗**不帶碼**（否則「凡失敗都掛碼」也全綠），
 * 寫得進去時是成功。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { createHostServicesPlugin, SessionRegistry } from '@nexus/core';
import type { SandboxMode, SessionEvent } from '@nexus/core';
import { createSubmitRecordPlugin, SUBMIT_RECORD_TOOL_NAME } from '@nexus/plugin-submit-record';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const CSV_PATH = '/visitors.csv';
const RECORD = { 姓名: '阿明', 日期: '週二' };

/** 一份日誌上每一顆 `tool/result` 的判別那幾格，依序。 */
function resultsOf(events: readonly SessionEvent[]): unknown[] {
  return events.flatMap((event) => {
    if (event.type !== 'tool/result') return [];
    const { message: _message, ...verdict } = event.data;
    return [verdict];
  });
}

describe('submit_record 被 fence 擋下', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-submit-record-sandbox-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * 在某一格模式下叫一次 `submit_record`、核准它，回 root 那份日誌的 `tool/result` 與模型拿到的
   * 那則工具訊息。backend 給同一個物件，同 `cli.ts`。
   */
  async function submitAndApprove(
    mode: SandboxMode,
  ): Promise<{ results: unknown[]; message: ToolMessage | undefined }> {
    const backend = new ContainedFilesystemBackend({ rootDir: root, mode });
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '',
            toolCalls: [
              { name: SUBMIT_RECORD_TOOL_NAME, args: { file_path: CSV_PATH, record: RECORD } },
            ],
          },
          { content: '收工。' },
        ],
      }),
      backend,
      checkpointer: new MemorySaver(),
      plugins: [createHostServicesPlugin({ backend }), createSubmitRecordPlugin()],
    });
    const sessions = new SessionRegistry('submit-record-sandbox');
    const detach = attachSession(sessions);
    const config = { configurable: { thread_id: 'submit-record-sandbox' } };
    let state: { messages: BaseMessage[] };
    try {
      await agent.invoke(toAgentInvocation('登記一位訪客。'), config);
      state = (await agent.invoke(
        new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never,
        config,
      )) as { messages: BaseMessage[] };
    } finally {
      detach();
      await dispose();
    }
    const rootLog = sessions.list().find((entry) => entry.address.kind === 'root');
    return {
      results: resultsOf(rootLog?.log.events ?? []),
      message: state.messages.find(
        (message): message is ToolMessage =>
          ToolMessage.isInstance(message) && message.name === SUBMIT_RECORD_TOOL_NAME,
      ),
    };
  }

  it('read-only 下核准之後被擋：`isError` 帶 `FS_SANDBOX_DENIED`，模型看到的字不變', async () => {
    const { results, message } = await submitAndApprove('read-only');
    expect(results).toEqual([
      {
        callId: expect.any(String),
        isError: true,
        error: { name: 'FsError', code: 'FS_SANDBOX_DENIED' },
      },
    ]);
    expect(message?.status).toBe('error');
    // 仍是工具自己那句接 fence 那句，前面一個 `Error: `（#318）。
    expect(String(message?.content)).toMatch(
      /^Error: 寫不進 "\/visitors\.csv"：\[containment\] .*這個 backend 是唯讀的/,
    );
    expect(await readdir(root)).toEqual([]);
  }, 20000);

  it('對照：同一個 read-only、同一顆工具的另一種失敗（欄名對不上表頭）是錯誤但**不帶碼**', async () => {
    // 讀不歸 fence 管，所以表頭讀得到；拒絕發生在寫之前，fence 一次都沒被問到。
    await writeFile(join(root, 'visitors.csv'), '甲,乙\n', 'utf8');
    const { results, message } = await submitAndApprove('read-only');
    expect(results).toEqual([{ callId: expect.any(String), isError: true }]);
    expect(message?.status).toBe('error');
    expect(String(message?.content)).toMatch(/^Error: 這幾個欄名不在/);
    expect(await readFile(join(root, 'visitors.csv'), 'utf8')).toBe('甲,乙\n');
  }, 20000);

  it('對照：workspace-write 下同一顆寫得進去，日誌上是成功', async () => {
    const { results, message } = await submitAndApprove('workspace-write');
    expect(results).toEqual([{ callId: expect.any(String), isError: false }]);
    expect(message?.status).not.toBe('error');
    expect(await readFile(join(root, 'visitors.csv'), 'utf8')).toBe('姓名,日期\n阿明,週二\n');
  }, 20000);
});
