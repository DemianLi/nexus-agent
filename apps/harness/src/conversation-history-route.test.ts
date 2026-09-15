/**
 * 摘要器的會話歷史不落進 `--workspace` —— [#348](https://github.com/DemianLi/nexus-agent/issues/348)。
 *
 * `/conversation_history` 有兩個寫入者：摘要器的 offload，與檔案 middleware 把超大 human
 * message 搬走的 eviction（後者寫死路徑，不吃 `historyPathPrefix`，見
 * [`summarization.test.ts`](./summarization.test.ts) 的「另一個寫入者」那組）。兩個都經過組裝點
 * 的 default backend，所以修在同一個地方：{@link ./agent-factory.ts} 把這個前綴跟工具結果暫存一樣
 * 路由到獨立的 `StateBackend`。
 *
 * **判準一律是兩件事一起：工作區裡沒有那個目錄，而且下一輪讀得回來。** 只看前一件會把
 * 「搬走了而且留得住」與「整個丟了」讀成同一件事——後者也會讓工作區是空的。讀回用的是
 * **同一個 checkpointer、同一個 thread、另一個 agent**：腳本模型的回合是寫死的，而摘要會吃掉
 * 其中一回合，同一個 agent 對不準哪一回合在摘要之後。
 */

import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import type { SessionEventMap } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import type { SandboxMode } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

type CompactionSummary = SessionEventMap['compaction/summary'];

const THREAD = 'history';

/** 工作區根底下的東西；目錄不存在就是空的。 */
async function entries(root: string, dir = '.'): Promise<string[]> {
  try {
    return await readdir(join(root, dir));
  } catch {
    return [];
  }
}

/** 最後一則工具結果的文字。 */
function lastToolText(prompt: readonly BaseMessage[]): string {
  const tool = prompt.filter((message) => message.getType() === 'tool').at(-1) as
    ToolMessage | undefined;
  const content = tool?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

interface Assembly {
  readonly root: string;
  readonly backend: ContainedFilesystemBackend;
  readonly saver: MemorySaver;
}

async function assembly(mode: SandboxMode): Promise<Assembly> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-history-'));
  return {
    root,
    backend: new ContainedFilesystemBackend({ rootDir: root, mode }),
    saver: new MemorySaver(),
  };
}

/**
 * 用 fold 自己建的摘要器跑到壓縮發生。**不是 plugin 同名換掉的那一顆**：那一顆自帶 backend，
 * 歷史去哪是它自己選的，不經過組裝點。
 */
async function summarize(
  target: Assembly,
  historyPathPrefix?: string,
): Promise<CompactionSummary[]> {
  const model = new ScriptedChatModel({
    turns: Array.from({ length: 12 }, (_, index) => ({ content: `第 ${index + 1} 次回話。` })),
  });
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    backend: target.backend,
    checkpointer: target.saver,
    plugins: [],
    summarization: {
      trigger: [{ type: 'messages', value: 3 }],
      keep: { type: 'messages', value: 1 },
      ...(historyPathPrefix !== undefined && { historyPathPrefix }),
    },
  });
  const sessions = new SessionRegistry(THREAD);
  const detach = attachSession(sessions);
  try {
    for (const line of ['第一句。', '第二句。', '第三句。', '第四句。']) {
      await agent.invoke(toAgentInvocation(line), { configurable: { thread_id: THREAD } });
    }
  } finally {
    detach();
    await dispose();
  }
  return sessions.root.events
    .filter((event) => event.type === 'compaction/summary')
    .map((event) => event.data as CompactionSummary);
}

/**
 * 另一個 agent 接同一個 thread，用 `grep` 在 `path` 底下找 `pattern`，回它拿到的工具結果。
 *
 * `summarization: false`：這一輪不能再壓一次，否則摘要那次模型呼叫會吃掉 `grep` 那一回合。
 */
async function grepFromNextTurn(target: Assembly, pattern: string, path: string): Promise<string> {
  const model = new ScriptedChatModel({
    turns: [
      { content: '', toolCalls: [{ name: 'grep', args: { pattern, path } }] },
      { content: '看完了。' },
    ],
  });
  const { agent, dispose } = await createNexusAgent({
    model,
    backend: target.backend,
    checkpointer: target.saver,
    plugins: [],
    summarization: false,
  });
  try {
    await agent.invoke(toAgentInvocation('找一下之前的歷史。'), {
      configurable: { thread_id: THREAD },
    });
  } finally {
    await dispose();
  }
  return lastToolText(model.lastPrompt);
}

describe.each(['workspace-write', 'read-only'] as const)('摘要器的歷史（%s）', (mode) => {
  it('不落進工作區，下一輪讀得回來', async () => {
    const target = await assembly(mode);
    const summaries = await summarize(target);

    // 先證明壓縮真的發生了，而且記下的路徑就是那個前綴——少了這一句，沒觸發摘要也會讓
    // 下面兩條通過。
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) expect(summary.filePath).toMatch(/^\/conversation_history\//);

    expect(await entries(target.root)).not.toContain('conversation_history');
    // **斷言的是命中的那一行，不是字串本身**：找不到時 `grep` 回的是
    // `No matches found for pattern 'Summarized at'`，那句話也含著模式，`toContain` 會假綠。
    expect(await grepFromNextTurn(target, 'Summarized at', '/conversation_history')).toMatch(
      /\d+: ## Summarized at/,
    );
  });
});

describe.each(['workspace-write', 'read-only'] as const)('超大 human message（%s）', (mode) => {
  /** 暗號放最前面；剛好越過 `4 * 5e4` 那條線。 */
  const MARK = 'AOI-SAMA-5820';
  const HUGE = `${MARK}${'長'.repeat(200001)}`;

  it('搬去的地方不在工作區，模型只收到佔位，原話下一輪讀得回來', async () => {
    const target = await assembly(mode);
    const model = new ScriptedChatModel({ turns: [{ content: '收到。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: target.backend,
      checkpointer: target.saver,
      plugins: [],
    });
    try {
      await agent.invoke(toAgentInvocation(HUGE), { configurable: { thread_id: THREAD } });
    } finally {
      await dispose();
    }
    const sentToModel = model.lastPrompt
      .filter((message) => message.getType() === 'human')
      .map((message) => message.text)
      .join('');

    expect(await entries(target.root)).not.toContain('conversation_history');
    // `read-only` 底下原本是寫不進去、20 萬字元原封不動進 context（fail-open 的反方向）。
    expect(sentToModel).toContain('Message content too large');
    expect(sentToModel).not.toContain(HUGE);
    // 暗號後面接著的那個字只在原話裡：找不到時的 `No matches found for pattern '<暗號>'` 不含它。
    expect(await grepFromNextTurn(target, MARK, '/conversation_history')).toContain(`${MARK}長`);
  });
});

/**
 * **自訂前綴不路由，照舊落在它自己的 backend 上。** 只路由基座的那個常數：那是兩個寫入者
 * 共用、而且 eviction 寫死的那一個。明著換掉前綴等於明著選了去向，這條逃生口留著。
 */
it('自訂的 historyPathPrefix 照舊落在工作區', async () => {
  const target = await assembly('workspace-write');
  const summaries = await summarize(target, '/ours');

  expect(summaries.length).toBeGreaterThan(0);
  expect((await entries(target.root, 'ours')).length).toBeGreaterThan(0);
  expect(await entries(target.root)).not.toContain('conversation_history');
});
