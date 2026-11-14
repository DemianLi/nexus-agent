/**
 * 提醒鏈在 `history-source=log` 下讀日誌沒套摘要的那一串（[#2362](https://github.com/DemianLi/nexus-agent/issues/2362)），
 * **在正式路徑上、兩種 loop 各跑一次**。
 *
 * 比的是同一支腳本在 `state` 與 `log` 下，模型每一輪收到的 prompt 逐字相同（LangChain 的 `id`、時間戳與摘要的歷史檔名除外）：`state` 那一邊讀 `state.messages`、
 * 不碰日誌，是對照基準。三個場景：
 *
 * - 摘要之前：不開摘要，鏈走到門檻。
 * - 摘要之後：摘要在第一則提醒之前發生，鏈跨過切點。
 * - 摘要之後又提醒：第一則提醒貼完才摘要，之後鏈長到下一道門檻。
 *
 * 這一檔量的組裝點明給 `historySource` 與 `agentLoop`，所以不吃 `history-source-state.setup.ts` 與 `native-loop.setup.ts`
 * 那兩個 mock 的補值；每個場景還斷言 `log` 那一邊**實際生效**：提醒真的記進了日誌。
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { REPEAT_REMINDER_MARKER, SessionRegistry } from '@nexus/core';
import type { HistorySource } from '@nexus/core';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('./assembly-root.js');

import { createNexusAgent } from './agent-factory.js';
import type { CreateNexusAgentOptions } from './agent-factory.js';
import { createEchoPlugin, ECHO_TOOL_NAME } from './echo.fixture.js';
import { LoopingChatModel } from './looping-model.js';
import { toAgentInvocation } from './messages.js';

type Loop = NonNullable<CreateNexusAgentOptions['agentLoop']>;

const isReminder = (message: BaseMessage): boolean =>
  HumanMessage.isInstance(message) && message.additional_kwargs[REPEAT_REMINDER_MARKER] != null;

/** 送上線的樣子：不比 LangChain 自己產的 `id` 與時間戳，其餘（類別、字、呼叫、記號）逐字比。 */
function project(message: BaseMessage): unknown {
  return {
    type: message.getType(),
    // 摘要附的歷史檔名帶每次隨機的會話代號，其餘逐字。
    content: JSON.parse(
      JSON.stringify(message.content).replace(/session_[0-9a-f]+\.md/g, 'session_X.md'),
    ) as unknown,
    toolCalls: 'tool_calls' in message ? message.tool_calls : undefined,
    toolCallId: 'tool_call_id' in message ? message.tool_call_id : undefined,
    kwargs: message.additional_kwargs,
  };
}

interface Run {
  /** 每一輪模型收到的 prompt，逐則投影過（{@link project}）。 */
  readonly prompts: readonly unknown[][];
  /** 每一輪 prompt 裡提醒的全文。 */
  readonly reminders: readonly (readonly string[])[];
  readonly summarized: boolean;
  /** 日誌上 `user/message`（插件來源）的條數；`state` 下沒接日誌是 `undefined`。 */
  readonly loggedReminders: number | undefined;
}

async function run(
  loop: Loop,
  historySource: HistorySource,
  summarization: CreateNexusAgentOptions['summarization'],
  recursionLimit: number,
): Promise<Run> {
  const model = new LoopingChatModel({ toolName: ECHO_TOOL_NAME });
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    plugins: [createEchoPlugin()],
    agentLoop: loop,
    historySource,
    recursionLimit,
    summarization,
  });
  const sessions = historySource === 'log' ? new SessionRegistry('repeat-reminder-log') : undefined;
  const detach = sessions === undefined ? undefined : attachSession(sessions);
  // `invoke` 自己不寫 `turn/start`（寫它的是 runRepl／pump），這裡照它的樣子先記人話。
  sessions?.root.append('turn/start', { kind: 'message', text: '一直跑' });
  try {
    await expect(agent.invoke(toAgentInvocation('一直跑'))).rejects.toThrow(/limit/i);
  } finally {
    detach?.();
    await dispose();
  }
  return {
    prompts: model.seen.map((prompt) => prompt.map(project)),
    reminders: model.seen.map((prompt) => prompt.filter(isReminder).map((m) => m.text)),
    summarized: model.seen.some((prompt) =>
      prompt.some(
        (m) => HumanMessage.isInstance(m) && m.additional_kwargs['lc_source'] === 'summarization',
      ),
    ),
    loggedReminders: sessions?.root.events.filter(
      (event) =>
        event.type === 'user/message' &&
        (event.data as { source?: { kind?: string } }).source?.kind === 'plugin',
    ).length,
  };
}

const SCENARIOS = [
  { name: '摘要之前', summarization: false as const, limit: 30, summary: false },
  {
    name: '摘要之後（摘要在第一則提醒之前）',
    summarization: { trigger: [{ type: 'messages' as const, value: 5 }], retainTokens: 36 },
    limit: 40,
    summary: true,
  },
  {
    name: '摘要之後又提醒（第一則提醒之後才摘要）',
    summarization: { trigger: [{ type: 'messages' as const, value: 10 }], retainTokens: 36 },
    limit: 40,
    summary: true,
  },
];

describe.each(['langgraph', 'native'] as const)('提醒鏈讀日誌：%s', (loop) => {
  it.each(SCENARIOS)('$name：log 下每一輪 prompt 與 state 逐字相同', async (scenario) => {
    const viaState = await run(loop, 'state', scenario.summarization, scenario.limit);
    const viaLog = await run(loop, 'log', scenario.summarization, scenario.limit);

    expect(viaLog.summarized).toBe(scenario.summary);
    expect(viaState.summarized).toBe(scenario.summary);
    // 門檻 3 之後一定有提醒，沒有的話這場根本沒量到鏈。
    expect(viaLog.reminders.flat().length).toBeGreaterThan(0);
    // `log` 下提醒真的記進了日誌：生效的來源是 `log`，不是無聲退回 `state`。
    expect(viaLog.loggedReminders).toBe(new Set(viaLog.reminders.flat()).size);
    expect(viaLog.prompts).toEqual(viaState.prompts);
  });
});
