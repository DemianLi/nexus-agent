/**
 * 摘要器的會話歷史不落進 `--workspace` —— [#348](https://github.com/DemianLi/nexus-agent/issues/348)。
 *
 * `/conversation_history` 有兩個寫入者：摘要器的 offload，與檔案 middleware 把超大 human
 * message 搬走的 eviction（後者寫死路徑，不吃 `historyPathPrefix`，見
 * [`summarization.test.ts`](./summarization.test.ts) 的「另一個寫入者」那組）。兩個都經過組裝點
 * 的 default backend，所以修在同一個地方：{@link ./agent-factory.ts} 把這個前綴跟工具結果暫存一樣
 * 路由到獨立的 `StateBackend`。
 *
 * 摘要器只在查不到會話日誌的呼叫寫歷史檔：接了日誌時被摘掉的原文從日誌讀回（`history_read`／`history_search`），
 * 不另存一份。所以量路由的組裝不接日誌；接了日誌的那一組另外量「沒有歷史檔、原文從日誌讀得回來」。
 *
 * **判準一律是兩件事一起：工作區裡沒有那個目錄，而且下一輪讀得回來。** 只看前一件會把
 * 「搬走了而且留得住」與「整個丟了」讀成同一件事——後者也會讓工作區是空的。
 *
 * 讀回的路兩種 loop 不一樣。langgraph 用**同一個 checkpointer、同一個 thread、另一個 agent**，讓模型
 * 呼叫 `grep`：腳本模型的回合是寫死的，而摘要會吃掉其中一回合，同一個 agent 對不準哪一回合在摘要之後。
 * native 沒有 checkpointer，thread 的 state 只在那個 agent 的行程內快取裡，另一個 agent 看不到；
 * 所以讀同一個 agent 那條 thread 的 `files`，那正是下一輪 `grep` 讀的地方。
 */

import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { AgentLoopKind } from '@nexus/core';
import { MemorySaver } from '@langchain/langgraph';
import { recallHistory, SessionRegistry } from '@nexus/core';
import type { SessionEvent, SessionEventMap } from '@nexus/core';
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

/** 墊料：框好的摘要要比被取代那段小才會提交（#1396），一句「第一句。」連框架文字都比不過。 */
const PAD = '內容'.repeat(60);

interface Assembly {
  readonly root: string;
  readonly backend: ContainedFilesystemBackend;
  readonly saver: MemorySaver;
  readonly loop: AgentLoopKind;
}

async function assembly(mode: SandboxMode, loop: AgentLoopKind): Promise<Assembly> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-history-'));
  return {
    root,
    backend: new ContainedFilesystemBackend({ rootDir: root, mode }),
    saver: new MemorySaver(),
    loop,
  };
}

/** 那條 thread 的 `files` 裡每一份的路徑與內容，一份一行接起來。 */
async function threadFiles(agent: object): Promise<string> {
  const snapshot = await (
    agent as { getState(config: unknown): Promise<{ readonly values: unknown }> }
  ).getState({ configurable: { thread_id: THREAD } });
  const files = ((snapshot.values as { files?: unknown }).files ?? {}) as Record<
    string,
    { readonly content?: unknown }
  >;
  return Object.entries(files)
    .map(([path, file]) => {
      const content = Array.isArray(file.content) ? file.content.join('\n') : String(file.content);
      return `${path}\n${content}`;
    })
    .join('\n');
}

/** 摘要前言裡歷史檔的路徑：`The full conversation history has been saved to <路徑> should you need …`。 */
const SAVED_TO = /has been saved to (\S+) should you need/;

interface Summarized {
  /** 模型收到的每一則摘要訊息前言裡的歷史檔路徑；前言沒有路徑的記 `undefined`。 */
  readonly savedTo: (string | undefined)[];
  /** 日誌上的 `compaction/summary`；沒接日誌是空的。 */
  readonly summaries: CompactionSummary[];
  /** 日誌的全部事件；沒接日誌是空的。 */
  readonly events: readonly SessionEvent[];
  /** 那條 thread 的 `files`（{@link threadFiles}）。 */
  readonly files: string;
}

/**
 * 用 fold 自己建的摘要器跑到壓縮發生。**不是 plugin 同名換掉的那一顆**：那一顆自帶 backend，
 * 歷史去哪是它自己選的，不經過組裝點。
 *
 * @param options.log - 接不接會話日誌。接了的話每一句先照回合驅動層的樣子記一筆 `turn/start`（`invoke` 自己不寫它），
 *   日誌才推得出被摘掉的那幾段。
 */
async function summarize(
  target: Assembly,
  options: { readonly log: boolean; readonly historyPathPrefix?: string },
): Promise<Summarized> {
  const model = new ScriptedChatModel({
    turns: Array.from({ length: 12 }, (_, index) => ({
      content: `第 ${index + 1} 次回話。${PAD}`,
    })),
  });
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    backend: target.backend,
    checkpointer: target.saver,
    agentLoop: target.loop,
    plugins: [],
    summarization: {
      trigger: [{ type: 'messages', value: 3 }],
      retainTokens: 1,
      ...(options.historyPathPrefix !== undefined && {
        historyPathPrefix: options.historyPathPrefix,
      }),
    },
  });
  const sessions = options.log ? new SessionRegistry(THREAD) : undefined;
  const detach = sessions === undefined ? undefined : attachSession(sessions);
  let files = '';
  try {
    for (const line of ['第一句。', '第二句。', '第三句。', '第四句。']) {
      const text = `${line}${PAD}`;
      sessions?.root.append('turn/start', { kind: 'message', text });
      await agent.invoke(toAgentInvocation(text), { configurable: { thread_id: THREAD } });
    }
    files = await threadFiles(agent);
  } finally {
    detach?.();
    await dispose();
  }
  const savedTo = model.prompts.flatMap((prompt) =>
    prompt
      .filter((message) => message.additional_kwargs.lc_source === 'summarization')
      .map((message) => SAVED_TO.exec(message.text)?.[1]),
  );
  const events = sessions?.root.events ?? [];
  const summaries = events
    .filter((event) => event.type === 'compaction/summary')
    .map((event) => event.data as CompactionSummary);
  return { savedTo, summaries, events, files };
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
    agentLoop: 'langgraph',
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

const MODES = ['workspace-write', 'read-only'] as const;
const LOOPS = ['langgraph', 'native'] as const;
const CELLS = MODES.flatMap((mode) => LOOPS.map((loop) => [mode, loop] as const));

describe.each(CELLS)('摘要器的歷史（%s，%s）', (mode, loop) => {
  it('沒接日誌：不落進工作區，下一輪讀得回來', async () => {
    const target = await assembly(mode, loop);
    const { savedTo, files } = await summarize(target, { log: false });

    // 先證明壓縮真的發生了，而且模型收到的摘要指向的就是那個前綴——少了這一句，沒觸發摘要也會讓
    // 下面兩條通過。
    expect(savedTo.length).toBeGreaterThan(0);
    for (const path of savedTo)
      expect(path).toMatch(/^\/conversation_history\/session_[0-9a-f]+\.md$/);

    expect(await entries(target.root)).not.toContain('conversation_history');
    // **斷言的是命中的那一行，不是字串本身**：找不到時 `grep` 回的是
    // `No matches found for pattern 'Summarized at'`，那句話也含著模式，`toContain` 會假綠。
    if (loop === 'native') {
      expect(files).toContain('## Summarized at');
      return;
    }
    expect(await grepFromNextTurn(target, 'Summarized at', '/conversation_history')).toMatch(
      /\d+: ## Summarized at/,
    );
  });

  it('接了日誌：不寫歷史檔，工作區也沒有，原文從日誌讀得回來', async () => {
    const target = await assembly(mode, loop);
    const { savedTo, summaries, events, files } = await summarize(target, { log: true });

    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) expect(summary.filePath).toBeNull();
    // 模型收到的摘要前言不指向任何路徑。
    expect(savedTo.length).toBeGreaterThan(0);
    expect(savedTo.every((path) => path === undefined)).toBe(true);
    expect(await entries(target.root)).not.toContain('conversation_history');
    expect(files).not.toContain('Summarized at');
    // 不是整個丟了：第一句在日誌推出來的第一段裡逐字讀得回來。
    const { segments, failure } = recallHistory(events);
    expect(failure).toBeUndefined();
    expect(segments).toHaveLength(summaries.length);
    expect(segments[0]!.text.startsWith(`User: 第一句。${PAD}`)).toBe(true);
  });
});

/**
 * 只有 langgraph：native 不在圖裡搬人話，太大的在收下之前就拒（#2415，`@nexus/core` 的 `human-message-admission.ts`），
 * 那一邊在 `human-message-admission-wire.test.ts`。
 */
describe.each(MODES)('超大 human message（%s，langgraph）', (mode) => {
  /** 暗號放最前面；剛好越過 `4 * 5e4` 那條線。 */
  const MARK = 'AOI-SAMA-5820';
  const HUGE = `${MARK}${'長'.repeat(200001)}`;

  it('搬去的地方不在工作區，模型只收到佔位，原話下一輪讀得回來', async () => {
    const target = await assembly(mode, 'langgraph');
    const model = new ScriptedChatModel({ turns: [{ content: '收到。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: target.backend,
      checkpointer: target.saver,
      agentLoop: 'langgraph',
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
 * **沒接日誌時，自訂前綴不路由，落在它自己的 backend 上。** 只路由基座的那個常數：那是兩個寫入者
 * 共用、而且 eviction 寫死的那一個。明著換掉前綴等於明著選了去向，這條逃生口留著。
 */
it('自訂的 historyPathPrefix 照舊落在工作區', async () => {
  const target = await assembly('workspace-write', 'langgraph');
  const { savedTo } = await summarize(target, { log: false, historyPathPrefix: '/ours' });

  expect(savedTo.length).toBeGreaterThan(0);
  for (const path of savedTo) expect(path).toMatch(/^\/ours\//);
  expect((await entries(target.root, 'ours')).length).toBeGreaterThan(0);
  expect(await entries(target.root)).not.toContain('conversation_history');
});

/**
 * 預設前綴路由到 thread state，工作區本來就看不到它；自訂前綴落在工作區，接了日誌時沒寫歷史檔才看得出來。
 */
it('接了日誌：自訂的 historyPathPrefix 底下也沒有歷史檔', async () => {
  const target = await assembly('workspace-write', 'langgraph');
  const { savedTo, summaries } = await summarize(target, { log: true, historyPathPrefix: '/ours' });

  expect(summaries.length).toBeGreaterThan(0);
  for (const summary of summaries) expect(summary.filePath).toBeNull();
  expect(savedTo.length).toBeGreaterThan(0);
  expect(savedTo.every((path) => path === undefined)).toBe(true);
  expect(await entries(target.root, 'ours')).toEqual([]);
});
