/**
 * **`submit_record` 與 `present` 拿到的 backend，要是工具實際讀寫的那一個**（[#694](https://github.com/DemianLi/nexus-agent/issues/694)）。
 *
 * `apps/harness/src/cli.ts` 把 backend 建成一個 const，一份給 `createNexusAgent`、一份給
 * `createSubmitRecordPlugin`。但那兩份**不是同一層**：`fold.ts` 交給 `createDeepAgent`
 * 的是**折後**的那一個，`agent-factory.ts` 在 fold 之前已經包了兩層路由
 * （`/conversation_history/` 與 `/large_tool_results/`，各送到一顆 `TextOnlyStateBackend`），
 * 只要有 plugin 呼叫 `registry.backend.mount()` 還會再包一層。所以這裡量的不是「同一個物件」，
 * 是**行為**：同一條被路由的路徑，`submit_record` 寫進去的那一列，`read_file` 讀得到。
 * **`present` 那一半在 [#951](https://github.com/DemianLi/nexus-agent/issues/951) 翻面了**：它以前也判得出
 * 路由上的檔在，現在明著拒絕——交付的讀端只認工作區磁碟，路由上的檔記了也下載不了。`present` 仍走同一個 `fs` 服務，
 * 只是對這兩個前綴多一道前綴判斷（`present-tool.test.ts` 在產品組裝上量）。
 *
 * 載體是 `@nexus/core` 的 `fs` 服務（`FS_SERVICE`）：組裝點提供一格，fold 折完把折出來的那一個
 * 填進去，兩顆工具被叫時才讀。
 *
 * **失敗的樣子**：`submit_record` 寫到工作區的磁碟、`read_file` 讀的是路由到 state 的那一格，
 * 兩個工具各自都回成功——**而且兩邊都會寫成功**。沒有這一條的話，第一個發現的人是看著檔案的那個人。
 *
 * **它守不到的那一半，明講**：數的是出貨清單。`submit_record` 在 #669 之後也在清單裡
 * （`id: submit-record`，backend 走服務注入），但哪天有 plugin 只掛在 `createCliAgent` 裡
 * （沙箱圍堵那一類）、而且掛了路由，這一條會保持綠。要守到那一
 * 半得先讓那條組裝路徑有一個拿得到 registry 的觀察點，那是另一件事——這裡守的是「預設清單
 * 開始掛路由」，那是今天真的會發生的那一種。
 *
 * **走產品組裝**（`createCliAgent`），模型換成清單上的腳本提供者（`withScriptedModel`，#670）。腳本先叫 `write_file` 建表頭、
 * 再叫 `submit_record` 追加一列、最後 `read_file`：**兩顆寫入工具共用同一個 backend**（`write_file` 走基座、`submit_record` 走 `fs` 服務），
 * 兩邊寫的是同一份檔，`read_file` 才讀得到追加的那一列。突變：把 `agent-factory.ts` 提供給 `fs` 服務的值換成另一個 backend，
 * 追加的那一列寫到別處，這裡讀不到而紅。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，工作區是暫存目錄。
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { presentOffWorkspaceMessage } from '@nexus/plugin-present';
import { SUBMIT_RECORD_TOOL_NAME } from '@nexus/plugin-submit-record';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONVERSATION_HISTORY_PREFIX, TOOL_RESULT_STASH_PREFIX } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';

const shipped = await shippedPlugins();

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-submit-record-backend-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 模型拿到的那幾則工具訊息，依工具名。 */
function toolMessagesOf(messages: readonly BaseMessage[]): Map<string, ToolMessage> {
  const found = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (ToolMessage.isInstance(message) && message.name !== undefined) {
      found.set(message.name, message);
    }
  }
  return found;
}

/** 工具訊息的文字。內容可能是一串區塊，`text` 把它們接起來。 */
function textOf(message: ToolMessage | undefined): string {
  return message?.text ?? '';
}

/**
 * 在產品組裝上先 `write_file` 建 `path` 的表頭、再叫一次 `submit_record` 追加一列、核准它，下一輪再用 `read_file`（與可選的 `present`）
 * 讀同一條路徑。回模型拿到的工具訊息。
 */
async function submitThenRead(
  path: string,
  { workspace, present }: { workspace: boolean; present: boolean },
): Promise<Map<string, ToolMessage>> {
  const turns = [
    {
      content: '',
      toolCalls: [{ name: 'write_file', args: { file_path: path, content: '姓名\n' } }],
    },
    {
      content: '',
      toolCalls: [
        { name: SUBMIT_RECORD_TOOL_NAME, args: { file_path: path, record: { 姓名: '阿明' } } },
      ],
    },
    {
      content: '',
      toolCalls: [
        { name: 'read_file', args: { file_path: path } },
        ...(present ? [{ name: 'present', args: { files: [{ path }] } }] : []),
      ],
    },
    { content: '收工。' },
  ];
  const built = await createCliAgent(
    { live: false, ...(workspace && { workspace: root }) },
    withScriptedModel(shipped, turns),
    root,
  );
  const detach = built.attachSession(built.sessions);
  const config = { configurable: { thread_id: 'submit-record-backend' } };
  try {
    await built.agent.invoke(toAgentInvocation('登記一位訪客。'), config);
    const state = (await built.agent.invoke(
      new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never,
      config,
    )) as { messages: BaseMessage[] };
    return toolMessagesOf(state.messages);
  } finally {
    detach();
    await built.dispose();
  }
}

describe('submit_record 寫進去的，就是 read_file 與 present 看得到的', () => {
  const historyPath = `${CONVERSATION_HISTORY_PREFIX}/a.csv`;

  it('給了 --workspace：路由到 state 的那一格，三顆工具看到的是同一個地方', async () => {
    const seen = await submitThenRead(historyPath, { workspace: true, present: true });
    // 前提：送出真的成功了，不是被拒。
    expect(seen.get(SUBMIT_RECORD_TOOL_NAME)?.status).not.toBe('error');
    expect(textOf(seen.get('read_file'))).toContain('阿明');
    // `present` 拒絕路由上的檔（#951）：檔在（上面 `read_file` 讀得到），但不在工作區磁碟上，交付的讀端讀不到。
    expect(seen.get('present')?.status).toBe('error');
    expect(textOf(seen.get('present'))).toBe(`Error: ${presentOffWorkspaceMessage(historyPath)}`);
    // 磁碟上沒有它：那一列沒有繞過路由寫進工作區。
    expect(await readdir(root)).toEqual([]);
  }, 20000);

  it('沒給 --workspace：同一條路徑，read_file 讀得到那一列', async () => {
    const seen = await submitThenRead(historyPath, { workspace: false, present: false });
    expect(seen.get(SUBMIT_RECORD_TOOL_NAME)?.status).not.toBe('error');
    expect(textOf(seen.get('read_file'))).toContain('阿明');
  }, 20000);

  it('另一個路由前綴（工具結果暫存）也一樣', async () => {
    const stashPath = `${TOOL_RESULT_STASH_PREFIX}/a.csv`;
    const seen = await submitThenRead(stashPath, { workspace: true, present: true });
    expect(seen.get(SUBMIT_RECORD_TOOL_NAME)?.status).not.toBe('error');
    expect(textOf(seen.get('read_file'))).toContain('阿明');
    expect(textOf(seen.get('present'))).toBe(`Error: ${presentOffWorkspaceMessage(stashPath)}`);
    expect(await readdir(root)).toEqual([]);
  }, 20000);

  it('對照：沒被路由的路徑，給了 --workspace 就落在磁碟上', async () => {
    const seen = await submitThenRead('/a.csv', { workspace: true, present: true });
    expect(textOf(seen.get('read_file'))).toContain('阿明');
    expect(textOf(seen.get('present'))).toBe('Presented /a.csv');
    expect(await readdir(root)).toEqual(['a.csv']);
  }, 20000);
});
