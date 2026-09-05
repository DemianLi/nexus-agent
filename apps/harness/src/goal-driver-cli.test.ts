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
import {
  createCliAgent,
  DEFAULT_PLUGINS,
  driveGoalRounds,
  formatGoalDriverDisclosure,
  runCli,
  runTurn,
} from './cli.js';
import type { GoalDriverPort } from './goal-driver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedModelState, ScriptedTurn } from './scripted-model.js';
import type { NexusAgentHandle } from './agent-factory.js';
import { goalId, SessionRegistry } from '@nexus/core';

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

  /**
   * **續行輪次拋錯時往外拋，而且不重試。**
   *
   * 兩個呼叫端各自接：REPL 那條在 `try` 裡，印一行錯誤之後**繼續收下一句**；一次性模式
   * 那條讓它走 `runCli` 的錯誤路徑。共通的是**日誌上留下一顆 `turn/failed`**，而決策函式
   * 看到它就回 `turn-failed` ——所以再問一次排程器，它一輪都不排。異常自動重試明著在範圍
   * 外：一次供應商錯誤不該變成 256 次重試。
   */
  it('續行輪次拋錯就整串停，再問一次也不排', async () => {
    // 腳本只有兩輪（建目標那一輪用掉），所以續行那一輪一開口就沒稿子了。
    const { agent, log, port, stop } = await build(CREATE_TURNS);
    const { printer } = recorder();
    await runTurn(agent, '把 CI 修綠', printer, log);

    await expect(driveGoalRounds(agent, printer, log, port)).rejects.toThrow(/腳本只有/u);
    expect(log.events.map((event) => event.type)).toContain('turn/failed');

    // **再問一次**：日誌上那顆 `turn/failed` 讓它回 `turn-failed`，不補排。
    const before = log.length;
    await driveGoalRounds(agent, printer, log, port);
    expect(log.length).toBe(before);
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

/**
 * **這一組驗的是「伴生的武裝跟排程器無關」**，而那句話寫在三個檔頭裡
 * （`invariant.ts`、`index.ts`、`goal-driver.ts`）。
 *
 * `invariant.test.ts` 那一組是同一個形狀，但它自己組配套入口；這裡走的是**真的預設清單**
 * ——`DEFAULT_PLUGINS` 裡同時有 goal 域與它的配套入口，而旗標關著。只在掛了排程器時才擋
 * 的檢查，對一顆手寫或寫壞的輪次是零防守，而那正是這裡量的東西。
 */
describe('伴生在預設組裝上是武裝的，旗標關著也一樣', () => {
  const CREATED = {
    kind: 'goal/change' as const,
    version: 1 as const,
    operation: 'create' as const,
    goal: {
      id: goalId('goal-x'),
      revision: 1,
      objective: '把 CI 修綠',
      phase: 'active' as const,
      maxGoalRounds: 8,
    },
    roundsStarted: 0,
    createdAt: 10,
    updatedAt: 10,
  };

  async function watchDefaultAssembly(
    write: (log: SessionLog) => void,
  ): Promise<{ violations: string[]; kinds: string[] }> {
    const { dispose, sessions, sessionLog, attachInvariants } = await createCliAgent(
      { live: false },
      DEFAULT_PLUGINS,
    );
    const violations: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => void violations.push(String(message));
    const detach = attachInvariants(sessions);
    try {
      write(sessionLog);
    } finally {
      detach?.();
      console.error = original;
      await dispose();
    }
    return { violations, kinds: startKinds(sessionLog) };
  }

  it('一顆內容對不上的續行輪次被報出來', async () => {
    const { violations } = await watchDefaultAssembly((log) => {
      log.append('goal/change', CREATED);
      log.append('turn/start', {
        kind: 'goal',
        text: '亂寫的續行文字',
        goalId: CREATED.goal.id,
        revision: 1,
        round: 1,
      });
    });
    expect(violations.join('\n')).toMatch(/第 1 輪內容不是這個套件算出來的續行文字/u);
  });

  it('一顆身分對不上的續行輪次也被報出來', async () => {
    const { violations } = await watchDefaultAssembly((log) => {
      log.append('turn/start', {
        kind: 'goal',
        text: '沒有目標卻排了一輪',
        goalId: goalId('goal-nope'),
        revision: 1,
        round: 1,
      });
    });
    expect(violations.join('\n')).toMatch(/不是目前 active 目標的下一個準入輪次/u);
  });

  it('文字對得上的那一顆一聲都不吭', async () => {
    const { violations } = await watchDefaultAssembly((log) => {
      log.append('goal/change', CREATED);
      log.append('turn/start', {
        kind: 'goal',
        text: renderGoalRoundPrompt(CREATED.goal, 1),
        goalId: CREATED.goal.id,
        revision: 1,
        round: 1,
      });
    });
    expect(violations).toEqual([]);
  });
});

describe('披露', () => {
  it('關著的時候說得出怎麼打開，開著的時候說得出上限', () => {
    expect(formatGoalDriverDisclosure(false)).toContain('--goal-driver');
    expect(formatGoalDriverDisclosure(true)).toContain('max_goal_rounds');
    expect(formatGoalDriverDisclosure(true)).toContain('256');
  });

  /**
   * **`--plugins` 換掉預設清單之後，那條路上就沒有 goal 域了。**
   *
   * 排程器的 `goal()` 走 `GOAL_PLUGIN.serviceFor(log)`，而 `GOAL_PLUGIN` 是**預設清單裡
   * 那一個物件**——換掉清單就查不到服務。那時要安靜地什麼都不做，不是拋。
   * 這一格用 port override 假裝不出來：它問的是那個 module 層級物件的身分。
   */
  it('--plugins 換掉清單之後，開著旗標也安靜地什麼都不做', async () => {
    const { printer, out } = recorder();
    await runCli({
      argv: ['--plugins', 'src/approval.fixture.ts', '--goal-driver', '動手'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
      env: {},
    });
    const said = out.join('\n');
    // 披露照樣說「開啟」——旗標真的開著，說謊的披露比沒有披露更糟。
    expect(said).toContain(formatGoalDriverDisclosure(true));
    // 但一輪都沒排，也沒有任何抱怨。
    expect(said).not.toContain('[續行] 第');
    expect(said).not.toContain('[續行] 排下一輪時出事');
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
