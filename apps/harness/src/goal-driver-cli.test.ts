/**
 * 續行排程器接在 **CLI 那條路**上。
 *
 * 與 `goal-driver-pump.test.ts` 對稱：那一份驗 web 那條，這一份驗 REPL 那條。**兩條都要
 * 有**，因為兩邊各自擁有自己的輪迴圈，而「日誌上寫的字」與「模型讀到的字」是不是同一串
 * 這件事，在每一條路上都要各自成立一次。
 */

import { MemorySaver } from '@langchain/langgraph';
import type { SessionLog } from '@nexus/core';
import { createGoalPlugin, renderGoalRoundPrompt } from '@nexus/plugin-goal';
import type { GoalPlugin } from '@nexus/plugin-goal';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { driveGoalRounds, formatGoalDriverDisclosure, runCli, runTurn } from './cli.js';
import type { GoalDriverPort } from './goal-driver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedModelState, ScriptedTurn } from './scripted-model.js';
import type { NexusAgentHandle } from './agent-factory.js';
import { SessionRegistry } from '@nexus/core';

type NexusAgent = NexusAgentHandle['agent'];

/** 收下每一行輸出。 */
function recorder(): {
  printer: { log: (l: string) => void; error: (l: string) => void };
  out: string[];
} {
  const out: string[] = [];
  return { printer: { log: (l) => void out.push(l), error: (l) => void out.push(l) }, out };
}

async function build(turns: readonly ScriptedTurn[]): Promise<{
  agent: NexusAgent;
  log: SessionLog;
  plugin: GoalPlugin;
  port: GoalDriverPort & { readonly warnings: string[] };
  state: ScriptedModelState;
  stop: () => Promise<void>;
}> {
  let serial = 0;
  const plugin = createGoalPlugin({ now: () => 100, newGoalId: () => `goal-${(serial += 1)}` });
  const state: ScriptedModelState = { turn: 0, boundToolNames: [], lastPrompt: [], prompts: [] };
  const { agent, dispose, attachSession } = await createNexusAgent({
    model: new ScriptedChatModel({ turns, shared: state }) as never,
    plugins: [plugin],
    checkpointer: new MemorySaver(),
  });
  const sessions = new SessionRegistry('cli-driver');
  const detach = attachSession(sessions);
  const warnings: string[] = [];
  const port: GoalDriverPort & { readonly warnings: string[] } = {
    warnings,
    goal: () => plugin.serviceFor(sessions.root)?.get(),
    block: (ref, reason) => void plugin.serviceFor(sessions.root)?.block(ref, reason),
    disarm: () => void plugin.serviceFor(sessions.root)?.disarm(),
    flush: () => Promise.resolve(),
    warn: (message) => void warnings.push(message),
  };
  return {
    agent,
    log: sessions.root,
    plugin,
    port,
    state,
    stop: async () => {
      detach();
      await dispose();
    },
  };
}

/** 建一個上限 1 的目標，這樣續行剛好排一輪就停。 */
const CREATE_TURNS: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'create_goal', args: { objective: '把 CI 修綠', max_goal_rounds: 1 } }],
  },
  { content: '建好了。' },
];

function startKinds(log: SessionLog): string[] {
  return log.events
    .filter((event) => event.type === 'turn/start')
    .map((event) => (event.data as { kind: string }).kind);
}

describe('REPL 那條路自己排下一輪', () => {
  /**
   * **主角同 `goal-driver-pump.test.ts`**：日誌那顆 `turn/start.text` 與模型真的收到的
   * 那則訊息必須是同一串字。`runTurn` 從同一個 `text` 同時寫日誌與呼叫
   * `toAgentInvocation()`，所以這件事在這條路上是結構成立的——但結構成立要有人量。
   */
  it('人那一輪之後排一輪，模型讀到的字就是日誌上那一串', async () => {
    const { agent, log, port, state, stop } = await build([
      ...CREATE_TURNS,
      { content: '再看看。' },
    ]);
    const { printer, out } = recorder();

    await runTurn(agent, '把 CI 修綠', printer, log);
    await driveGoalRounds(agent, printer, log, port);

    expect(startKinds(log)).toEqual(['message', 'goal']);
    const round = log.events.find(
      (event) => event.type === 'turn/start' && (event.data as { kind: string }).kind === 'goal',
    );
    const data = round?.data as { text: string; goalId: string; round: number };
    expect(data.round).toBe(1);
    expect(data.text).toBe(
      renderGoalRoundPrompt(
        {
          id: data.goalId as never,
          revision: 1,
          objective: '把 CI 修綠',
          phase: 'active',
          maxGoalRounds: 1,
        },
        1,
      ),
    );
    expect((state.prompts.at(-1) ?? []).at(-1)?.content).toBe(data.text);
    // **畫面上看得出來是誰在推。** 不印的話，「模型自己又開了一輪」與「人打了一句話」
    // 在畫面上一模一樣。
    expect(out.join('\n')).toContain('[續行] 第 1 輪');
    await stop();
  });

  it('上限用完就停，並記一顆 round-limit', async () => {
    const { agent, log, port, stop } = await build([...CREATE_TURNS, { content: '再看看。' }]);
    const { printer } = recorder();
    await runTurn(agent, '把 CI 修綠', printer, log);
    await driveGoalRounds(agent, printer, log, port);
    expect(port.goal()).toMatchObject({ phase: 'blocked', roundsStarted: 1 });
    await stop();
  });

  /** 沒有目標就一輪都不排——**而且不吭聲**。 */
  it('沒有目標時安靜地什麼都不做', async () => {
    const { agent, log, port, stop } = await build([{ content: '好的。' }]);
    const { printer, out } = recorder();
    await runTurn(agent, '隨便聊聊', printer, log);
    await driveGoalRounds(agent, printer, log, port);
    expect(startKinds(log)).toEqual(['message']);
    expect(out.join('\n')).not.toContain('[續行]');
    expect(port.warnings).toEqual([]);
    await stop();
  });
});

describe('披露', () => {
  it('關著的時候說得出怎麼打開，開著的時候說得出上限', () => {
    expect(formatGoalDriverDisclosure(false)).toContain('--goal-driver');
    expect(formatGoalDriverDisclosure(true)).toContain('max_goal_rounds');
    expect(formatGoalDriverDisclosure(true)).toContain('256');
  });

  it('runCli 印的那一行跟著旗標走，不是固定字串', async () => {
    for (const on of [false, true]) {
      const { printer, out } = recorder();
      await runCli({
        argv: on ? ['--goal-driver', '把這句話回聲一次。'] : ['把這句話回聲一次。'],
        input: new PassThrough(),
        output: new PassThrough(),
        printer,
        env: {},
      });
      expect(out.join('\n')).toContain(formatGoalDriverDisclosure(on));
    }
  });
});
