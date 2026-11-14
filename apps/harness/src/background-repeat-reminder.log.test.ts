/**
 * 背景子代理的提醒鏈在 `history-source=log` 下讀它自己的日誌（[#2751](https://github.com/DemianLi/nexus-agent/issues/2751)），
 * **真的派背景子代理、兩種 loop 各跑一次**。前景的對應測試在 `subagent-repeat-reminder.log.test.ts`；背景的形狀不同：
 * 子日誌從 `turn/start` 開始、一個子代理可以有好幾輪（人再對它說話會開新的一輪）。
 *
 * - 逐字相同：兩個背景子代理各反覆叫同一顆工具，`state` 與 `log` 下每一輪 prompt（含提醒）逐字相同；提醒記進**各自的**子日誌，不串。
 * - 第二輪：人對它再說一句話，鏈清零，第二輪的提醒從頭數；`state` 與 `log` 逐字相同。
 * - 分得出退回 state：每步往 graph state 加一則真使用者訊息的 middleware 讓 `state` 讀法的鏈每步清零；`log` 讀日誌，提醒照出。
 *
 * 明給 `historySource` 與 `agentLoop`；每個場景斷言組裝回報的 `historySource`。
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createHookStepMiddleware, REPEAT_REMINDER_MARKER, subagentLinks } from '@nexus/core';
import type { AgentLoopKind, HistorySource, PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ROOT,
  boot,
  delegateBoth,
  setupWorld,
  teardownWorld,
  until,
  world,
} from './background-cold.fixture.js';
import type { ScriptedTurn } from './scripted-model.js';

beforeEach(setupWorld);
afterEach(teardownWorld);

const NOISE = '每一步都只加進 graph state 的真使用者訊息';

/** 每次叫模型之前，往這個 agent 的 graph state 加一則新的真使用者訊息、不記進日誌。 */
const STATE_NOISE: PluginEntry = {
  plugin: {
    name: 'state-noise',
    apply(registry) {
      let n = 0;
      registry.middleware.use(
        createHookStepMiddleware({
          name: 'stateNoise',
          beforeModel: () => {
            n += 1;
            return { messages: [new HumanMessage(`${NOISE} ${n}`)] };
          },
        }),
      );
    },
  },
};

const note = (): ScriptedTurn => ({ content: '', toolCalls: [{ name: 'note', args: {} }] });

/** 第一輪：叫三次 `note`（第三次之後一則提醒），收工；worker-a 第二輪（人再說一句之後）再叫三次、收工。 */
const turnsFor = (name: 'worker-a' | 'worker-b'): ScriptedTurn[] => [
  note(),
  note(),
  note(),
  { content: `${name} 第一輪收工` },
  ...(name === 'worker-a' ? [note(), note(), note(), { content: `${name} 第二輪收工` }] : []),
];

const isReminder = (message: BaseMessage): boolean =>
  HumanMessage.isInstance(message) && message.additional_kwargs[REPEAT_REMINDER_MARKER] != null;

/** 只比型別、內容、tool_calls 與提醒標記。 */
function project(message: BaseMessage): unknown {
  return {
    type: message.getType(),
    content: message.content,
    toolCalls: 'tool_calls' in message ? message.tool_calls : undefined,
    reminder: isReminder(message) ? message.additional_kwargs[REPEAT_REMINDER_MARKER] : undefined,
  };
}

interface Run {
  /** 組裝回報的、實際生效的歷史來源。 */
  readonly built: HistorySource;
  readonly promptsA: readonly (readonly unknown[])[];
  readonly promptsB: readonly (readonly unknown[])[];
  readonly remindersPerPromptA: readonly number[];
  /** 各子日誌上 `source.kind === 'plugin'` 的 `user/message` 條數（提醒）。 */
  readonly loggedA: number;
  readonly loggedB: number;
}

async function run(
  agentLoop: AgentLoopKind,
  historySource: HistorySource,
  extraPlugins: readonly PluginEntry[] = [],
): Promise<Run> {
  // 同一個測試裡跑兩次：各自用乾淨的存放處（同名 root 不能寫第二次）。
  world.storeDirectory = undefined;
  const first = await boot({
    rootTurns: [delegateBoth, { content: '根收尾' }],
    turnsFor,
    agentLoop,
    historySource,
    extraPlugins,
  });
  try {
    await first.pump.submit({ kind: 'message', text: '委派' });
    await first.pump.whenIdle();
    const links = subagentLinks(first.pump.sessions.root.events);
    expect(links).toHaveLength(2);
    const runIdOf = (index: number) => links[index]!.childId.slice(`${ROOT}/`.length);
    const logOf = (runId: string) => first.pump.sessions.get({ kind: 'subagent', runId })!;
    const turnEnds = (runId: string) =>
      logOf(runId).events.filter((event) => event.type === 'turn/end').length;
    await until(() => turnEnds(runIdOf(0)) === 1 && turnEnds(runIdOf(1)) === 1);
    // 人再對 worker-a 說一句：開第二輪。
    await first.detach.background!.sendFromUser(runIdOf(0), '再來一輪');
    await until(() => turnEnds(runIdOf(0)) === 2);
    const logged = (runId: string) =>
      logOf(runId).events.filter(
        (event) =>
          event.type === 'user/message' &&
          (event.data as { source?: { kind?: string } }).source?.kind === 'plugin',
      ).length;
    return {
      built: first.historySource,
      promptsA: first.models['worker-a'].prompts.map((prompt) => prompt.map(project)),
      promptsB: first.models['worker-b'].prompts.map((prompt) => prompt.map(project)),
      remindersPerPromptA: first.models['worker-a'].prompts.map(
        (prompt) => prompt.filter(isReminder).length,
      ),
      loggedA: logged(runIdOf(0)),
      loggedB: logged(runIdOf(1)),
    };
  } finally {
    await first.shutdown();
  }
}

describe.each(['langgraph', 'native'] as const)('背景子代理的提醒鏈讀它自己的日誌：%s', (loop) => {
  it('兩個背景子代理各反覆叫工具、再說一句開第二輪：log 與 state 每一輪 prompt 逐字相同，提醒各記各的', async () => {
    const viaState = await run(loop, 'state');
    const viaLog = await run(loop, 'log');

    // 第一輪第三次之後一則提醒；第二輪鏈清零，第三次之後又一則。
    expect(viaState.built).toBe('state');
    expect(viaLog.built).toBe('log');
    expect(Math.max(...viaLog.remindersPerPromptA)).toBe(2);
    expect(viaLog.loggedA).toBe(2);
    expect(viaLog.loggedB).toBe(1);
    expect(viaLog.promptsA).toEqual(viaState.promptsA);
    expect(viaLog.promptsB).toEqual(viaState.promptsB);
    expect(viaState.loggedA).toBe(2);
    expect(viaState.loggedB).toBe(1);
  });

  it('分得出退回讀 state：state 每步被加一則真使用者訊息，log 下鏈照日誌算、提醒照出', async () => {
    const viaState = await run(loop, 'state', [STATE_NOISE]);
    const viaLog = await run(loop, 'log', [STATE_NOISE]);

    expect(viaState.built).toBe('state');
    expect(viaLog.built).toBe('log');
    // 對照：state 讀法下每步多一則真使用者訊息，鏈每步清零，一則提醒也出不了。
    expect(viaState.remindersPerPromptA.every((count) => count === 0)).toBe(true);
    expect(viaState.loggedA).toBe(0);
    // log 讀日誌，噪音只在 state 裡：提醒照出。
    expect(Math.max(...viaLog.remindersPerPromptA)).toBeGreaterThanOrEqual(1);
    expect(viaLog.loggedA).toBeGreaterThanOrEqual(1);
    expect(viaLog.loggedB).toBeGreaterThanOrEqual(1);
  });
});
