/**
 * 續行排程器接在 **CLI 那條路**上。
 *
 * 與 `goal-driver-pump.test.ts` 對稱：那一份驗 web 那條，這一份驗 REPL 那條。**兩條都要
 * 有**，因為兩邊各自擁有自己的輪迴圈，而「日誌上寫的字」與「模型讀到的字」是不是同一串
 * 這件事，在每一條路上都要各自成立一次。
 */

import { MemorySaver } from '@langchain/langgraph';
import type { SessionLog } from '@nexus/core';
import {
  createGoalPlugin,
  GOAL_COMMAND_NAME,
  goalPlugin,
  GOALS_SERVICE,
  renderGoalRoundPrompt,
} from '@nexus/plugin-goal';
import type { GoalServices } from '@nexus/plugin-goal';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import {
  createCliAgent,
  driveGoalRounds,
  formatGoalDriverDisclosure,
  goalDriverPort,
  runCli,
  runTurn,
} from './cli.js';
import { parseCliArgs } from './cli.js';
import type { GoalDriverPort } from './goal-driver.js';
import { ROUND_CAP_BLOCK_CODE } from './goal-driver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedModelState, ScriptedTurn } from './scripted-model.js';
import type { NexusAgentHandle } from './agent-factory.js';
import { shippedPlugins } from './fixtures.js';
import { goalId, SessionRegistry } from '@nexus/core';

const shipped = await shippedPlugins();

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
  goals: GoalServices;
  port: GoalDriverPort & { readonly warnings: string[] };
  state: ScriptedModelState;
  stop: () => Promise<void>;
}> {
  let serial = 0;
  const plugin = createGoalPlugin({ now: () => 100, newGoalId: () => `goal-${(serial += 1)}` });
  const state: ScriptedModelState = { turn: 0, boundToolNames: [], lastPrompt: [], prompts: [] };
  const { agent, dispose, attachSession, services } = await createNexusAgent({
    model: new ScriptedChatModel({ turns, shared: state }) as never,
    plugins: [plugin],
    checkpointer: new MemorySaver(),
  });
  const sessions = new SessionRegistry('cli-driver');
  const detach = attachSession(sessions);
  // **這一次組裝的那一份**（#459）：以前是問模組層級的 plugin 物件。
  const goals = services.use(GOALS_SERVICE);
  const warnings: string[] = [];
  const port: GoalDriverPort & { readonly warnings: string[] } = {
    warnings,
    goal: () => goals.serviceFor(sessions.root)?.get(),
    block: (ref, reason) => void goals.serviceFor(sessions.root)?.block(ref, reason),
    disarm: () => void goals.serviceFor(sessions.root)?.disarm(),
    flush: () => Promise.resolve(),
    warn: (message) => void warnings.push(message),
  };
  return {
    agent,
    log: sessions.root,
    goals,
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
 * ——出貨清單裡同時有 goal 域與它的配套入口，而旗標關著。只在掛了排程器時才擋
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
      shipped,
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

/**
 * 命令列那條上限。**它存在的理由是目標自己那條不歸操作的人管**：`service.ts:269` 是
 * `request.maxGoalRounds ?? this.#defaultMaxGoalRounds`，`??` 不是 `Math.min`，所以模型在
 * `create_goal` 裡填的數字贏過組裝點給的預設。這一份釘的是「模型填了一個大數字，人設的
 * 那條照樣夾得住」。
 */
describe('--max-goal-rounds', () => {
  it('模型自己填 5，人給 1，就只跑得到 1 輪', async () => {
    const { agent, log, goals, port, stop } = await build([
      {
        content: '',
        toolCalls: [{ name: 'create_goal', args: { objective: '把 CI 修綠', max_goal_rounds: 5 } }],
      },
      { content: '建好了。' },
      { content: '再看看。' },
      { content: '不該跑到這一輪。' },
    ]);
    const { printer } = recorder();

    await runTurn(agent, '把 CI 修綠', printer, log);
    await driveGoalRounds(agent, printer, log, port, 1);

    expect(startKinds(log)).toEqual(['message', 'goal']);
    const goal = goals.serviceFor(log)?.get();
    expect(goal?.maxGoalRounds).toBe(5);
    expect(goal?.phase).toBe('blocked');
    expect(goal?.blockedReason?.code).toBe(ROUND_CAP_BLOCK_CODE);
    await stop();
  });

  /**
   * **同一份腳本、同一個目標，只拿掉 `--max-goal-rounds` 這一個變數。** 沒有這一格對照，
   * 上面那條綠證不了「只跑一輪」是那條上限造成的——腳本自己跑完也會停。
   */
  it('同一份腳本不給上限就跑滿模型自己填的 5——對照組', async () => {
    const { agent, log, goals, port, stop } = await build([
      {
        content: '',
        toolCalls: [{ name: 'create_goal', args: { objective: '把 CI 修綠', max_goal_rounds: 5 } }],
      },
      { content: '建好了。' },
      { content: '第 1 輪。' },
      { content: '第 2 輪。' },
      { content: '第 3 輪。' },
      { content: '第 4 輪。' },
      { content: '第 5 輪。' },
    ]);
    const { printer } = recorder();

    await runTurn(agent, '把 CI 修綠', printer, log);
    await driveGoalRounds(agent, printer, log, port);

    expect(startKinds(log)).toEqual(['message', 'goal', 'goal', 'goal', 'goal', 'goal']);
    expect(goals.serviceFor(log)?.get()?.blockedReason?.code).toBe('round-limit');
    await stop();
  });

  it('沒配 --goal-driver 就拋——一個限制不到任何東西的上限比沒設更糟', () => {
    expect(() => parseCliArgs(['--max-goal-rounds', '3', '動手'])).toThrow('要配 --goal-driver');
  });

  it.each([['0'], ['-1'], ['2.5'], ['abc'], ['']])('%s 不是正整數，當場拋', (raw) => {
    expect(() => parseCliArgs(['--goal-driver', '--max-goal-rounds', raw, '動手'])).toThrow(
      '--max-goal-rounds',
    );
  });

  it('給對了就解析成數字，不是字串', () => {
    expect(parseCliArgs(['--goal-driver', '--max-goal-rounds', '3', '動手']).maxGoalRounds).toBe(3);
  });

  it('沒給就是缺席，不是一個假的預設', () => {
    expect(parseCliArgs(['--goal-driver', '動手']).maxGoalRounds).toBeUndefined();
  });
});

describe('披露', () => {
  it('關著的時候說得出怎麼打開，開著的時候說得出上限', () => {
    expect(formatGoalDriverDisclosure(false)).toContain('--goal-driver');
    expect(formatGoalDriverDisclosure(true)).toContain('max_goal_rounds');
    expect(formatGoalDriverDisclosure(true)).toContain('256');
  });

  /**
   * **兩條上限都要出現在畫面上，而且沒給的時候要明著說沒給。**
   *
   * 這一行自己的檔頭寫著「說謊的披露比沒有披露更糟」。只印目標那條會讓人以為有一個他控制
   * 得了的數字（那個數字是模型填的）；只印命令列那條會讓人看不見模型可以在它底下自己挑
   * 一個更小的。
   */
  it('給了上限就印出來，沒給就明著說沒給', () => {
    expect(formatGoalDriverDisclosure(true, 3)).toContain('--max-goal-rounds 3');
    expect(formatGoalDriverDisclosure(true, 3)).toContain('max_goal_rounds');
    expect(formatGoalDriverDisclosure(true)).toContain('沒有給 --max-goal-rounds');
  });

  it('runCli 印的那一行帶著真的生效值', async () => {
    const { printer, out } = recorder();
    await runCli({
      argv: ['--goal-driver', '--max-goal-rounds', '2', '把這句話回聲一次。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
      env: {},
    });
    expect(out.join('\n')).toContain(formatGoalDriverDisclosure(true, 2));
  });

  /**
   * **開著旗標、沒有 active goal 時安靜地什麼都不做，不是拋。**
   *
   * **這一條看不出 goal 域在不在**，而它以前的檔頭聲稱看得出來——那句話是假的：假模型腳本
   * 從來不設 goal，所以「沒有 goal 域」與「有 goal 域但沒有 active goal」在畫面上一模一樣
   * （實測：把這份 patch 清空、或把它的 `id` 打錯，這一條照樣綠）。在
   * [#455](https://github.com/DemianLi/nexus-agent/issues/455) 拿掉 `--plugins` 之前也一樣假，
   * 換掉整份清單只是同一個觀察。
   *
   * 「這一次組裝到底有沒有那個服務」由下一條用 REPL 的 `/goal` 問——那個觀察點分得開。
   * 排程器對 `goals === undefined` 的行為由 `goal-driver-pump.test.ts` 在單元層釘。
   */
  it('patch 把 goal 那一列關掉之後，開著旗標也安靜地什麼都不做', async () => {
    const { printer, out } = recorder();
    await runCli({
      argv: ['--patch', 'src/goal-disabled.patch.yml', '--goal-driver', '動手'],
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

  /**
   * **同一份 patch 真的把 goal 拿掉了**——這一條才是「組裝裡有沒有那個服務」的判準。
   *
   * 觀察點是 REPL 的 `/goal`：它是 goal plugin 註冊的命令，那一列關著就沒有人註冊它，
   * 於是那一行不被當命令攔下、直接當一句話送進模型（假模型的第一輪是回聲）。
   * 對照組是 `session-participants.test.ts` 的同一個命令跑在出貨清單上：那裡印「目標建好了」。
   */
  it('同一份 patch 真的把 goal 拿掉了——REPL 裡 /goal 已經不是命令', async () => {
    const { printer, out } = recorder();
    const input = new PassThrough();
    input.end(`/${GOAL_COMMAND_NAME} 隨便一個目標\n/exit\n`);
    await runCli({
      argv: ['--patch', 'src/goal-disabled.patch.yml'],
      input,
      output: new PassThrough(),
      printer,
      env: {},
    });
    const said = out.join('\n');
    // 命令不在了：沒有 goal plugin 的回應。
    expect(said).not.toContain('目標建好了');
    // 而那一行真的被當成一句話送進去了——正面證據，不只是「沒看到」。
    expect(said).toContain('回聲：');
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

/**
 * **排程器問的是哪一份 goal 域**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）。
 *
 * 這一組量的是交付物：出貨的那份清單（`apps/harness/cordis.yml`），與 `createCliAgent` 真的組出來的東西。
 * 在手搭的 registry 上驗隔離證明不了這條——**清單裡掛的是哪一顆物件**才是以前串台的來源。
 */
describe('goals 服務綁的是這一次組裝', () => {
  it('預設清單掛的就是模組層級那一顆 goal plugin', () => {
    expect(shipped.filter((entry) => entry.plugin === goalPlugin)).toHaveLength(1);
  });

  /**
   * **`goalDriverPort` 自己那三格要真的打到注入進來的那一份。**
   *
   * 其餘每一條排程器測試都自己搭一個 port（要塞得進替身與計數），所以
   * `goalDriverPort` 這個函式本身一直沒有人驅動過——把它的 `goal()` 改成永遠回
   * `undefined`，整套 harness 測試照樣綠（實測）。這一條就是那個洞。
   */
  it('goalDriverPort 的 goal / block / disarm 都打在注入的那一份上', async () => {
    const built = await createCliAgent({ live: false }, shipped);
    try {
      built.attachSession(built.sessions);
      const service = built.goals?.serviceFor(built.sessionLog);
      if (service === undefined) throw new Error('接了線就該找得到服務');
      const created = service.create({ objective: '量這一條' });

      const port = goalDriverPort(
        built.goals,
        () => built.sessionLog,
        () => Promise.resolve(),
        () => undefined,
      );
      expect(port.goal()?.objective).toBe('量這一條');

      port.disarm();
      expect(service.get()?.activation).toBe('disarmed');

      port.block(
        { id: created.id, revision: service.get()?.revision ?? created.revision },
        { code: 'round-limit', message: '量一下' },
      );
      expect(service.get()?.phase).toBe('blocked');
      expect(service.get()?.blockedReason?.code).toBe('round-limit');
    } finally {
      await built.dispose();
    }
  });

  it('兩次 createCliAgent 各拿各的——serve 每條 thread 組裝一次', async () => {
    const first = await createCliAgent({ live: false }, shipped);
    const second = await createCliAgent({ live: false }, shipped);
    try {
      const firstGoals = first.goals;
      const secondGoals = second.goals;
      if (firstGoals === undefined || secondGoals === undefined) {
        throw new Error('預設清單掛了 goal，兩次組裝都該拿得到服務');
      }
      // **不是同一個把手**：以前兩次組裝共用模組層級那一格。
      expect(firstGoals).not.toBe(secondGoals);

      first.attachSession(first.sessions);
      firstGoals.serviceFor(first.sessionLog)?.create({ objective: '第一次組裝的目標' });

      expect(firstGoals.attached()).toHaveLength(1);
      expect(firstGoals.serviceFor(first.sessionLog)?.get()?.objective).toBe('第一次組裝的目標');
      // **第二次組裝一份都看不到**——連第一次那份日誌都查不到。
      expect(secondGoals.attached()).toEqual([]);
      expect(secondGoals.serviceFor(first.sessionLog)).toBeUndefined();
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
