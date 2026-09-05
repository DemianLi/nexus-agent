/**
 * 續行排程器接在 **web 那條路**上：真 agent、真 goal 域、真 pump。
 *
 * 決策那一半的單元在 `goal-driver.test.ts`。**這一份存在是因為那個決定要走完最後一段**
 * ——把排出來的那一輪交回 `submit()`，而那一段是「日誌上寫的字」與「模型讀到的字」分不
 * 分得開的唯一地方。不變量伴生**結構上驗不到**這件事：它只看得到日誌那一份。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import {
  createGoalPlugin,
  GOAL_TOOL_AUTHORITY_MESSAGE,
  renderGoalRoundPrompt,
} from '@nexus/plugin-goal';
import { createGoalInvariantPlugin } from '@nexus/plugin-goal/invariant';
import type { GoalPlugin } from '@nexus/plugin-goal';
import type { SessionLog } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import type { GoalDriverPort } from './goal-driver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedModelState, ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

/** 一份 port，記下它被要求做過什麼。 */
function portFor(
  plugin: GoalPlugin,
  log: () => SessionLog,
  overrides: Partial<GoalDriverPort> = {},
): GoalDriverPort & { readonly warnings: string[]; readonly blocks: string[] } {
  const warnings: string[] = [];
  const blocks: string[] = [];
  return {
    warnings,
    blocks,
    goal: () => plugin.serviceFor(log())?.get(),
    block: (ref, reason) => {
      blocks.push(reason.code);
      plugin.serviceFor(log())?.block(ref, reason);
    },
    disarm: () => void plugin.serviceFor(log())?.disarm(),
    flush: () => Promise.resolve(),
    warn: (message) => void warnings.push(message),
    ...overrides,
  };
}

/**
 * 掛 goal 域，回一個接好會話的 pump ＋ 那個 port ＋ 模型收到過的每一批訊息。
 *
 * **`driver` 給 `undefined` 就是沒掛旗標**——那條路一輪都不該自己排。
 */
/** 一顆要人核准的工具，用來把一輪停在核准點。 */
function noteTool() {
  return tool(({ text }: { text: string }) => `已記下：${text}`, {
    name: 'take_note',
    description: '把一段文字記下來。',
    schema: z.object({ text: z.string().describe('要記下的內容') }),
  });
}

/** 掛那顆工具與一道會問人的閘門。 */
const GATED_FIXTURE: NexusPlugin = {
  name: 'goal-driver-fixture',
  apply(registration) {
    registration.tools.register(noteTool());
    registration.approvals.gate((execution, next) =>
      execution.name === 'take_note' ? { kind: 'ask', reason: '看一下' } : next(),
    );
  },
};

async function build(options: {
  readonly turns: readonly ScriptedTurn[];
  readonly threadId: string;
  readonly withDriver: boolean;
  readonly gated?: boolean;
  readonly portOverrides?: Partial<GoalDriverPort>;
}): Promise<{
  pump: ThreadPump;
  port: ReturnType<typeof portFor>;
  state: ScriptedModelState;
  violations: string[];
  stop: () => Promise<void>;
}> {
  let serial = 0;
  const plugin = createGoalPlugin({ now: () => 100, newGoalId: () => `goal-${(serial += 1)}` });
  const state: ScriptedModelState = { turn: 0, boundToolNames: [], lastPrompt: [], prompts: [] };
  const violations: string[] = [];
  const { agent, dispose, attachSession, attachInvariants } = await createNexusAgent({
    model: new ScriptedChatModel({ turns: options.turns, shared: state }) as never,
    plugins: [
      plugin,
      createGoalInvariantPlugin(),
      ...(options.gated === true ? [GATED_FIXTURE] : []),
    ],
    checkpointer: new MemorySaver(),
    onInvariantViolation: (error) => void violations.push(error.message),
  });
  // 同 `wire-handler.ts`：port 要日誌，而日誌由 pump 建，而 pump 的建構參數是 port。
  const late: { log?: SessionLog } = {};
  const port = portFor(plugin, () => late.log as SessionLog, options.portOverrides ?? {});
  const pump = new ThreadPump(
    agent as unknown as PumpAgent,
    options.threadId,
    options.withDriver ? port : undefined,
  );
  late.log = pump.sessionLog;
  // **伴生接在參與者之前**，同 `wire-handler.ts` 那條線的順序：參與者一裝上去就可能記
  // 東西，而那些東西該被已經在看的檢查看到。
  const detachInvariants = attachInvariants(pump.sessions);
  const detachSession = attachSession(pump.sessions);
  return {
    pump,
    port,
    state,
    violations,
    stop: async () => {
      detachSession();
      detachInvariants?.();
      await dispose();
    },
  };
}

/** 一輪：模型建一個目標。**上限給 1**，這樣續行剛好排一輪就停，腳本不必無限長。 */
const CREATE_TURNS: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'create_goal', args: { objective: '把 CI 修綠', max_goal_rounds: 1 } }],
  },
  { content: '建好了。' },
];

/** 續行輪次裡模型只講一句話，不動工具。 */
const QUIET = { content: '再看一下。' } as const;

/** 日誌上每一顆 `turn/start` 的 `kind`。 */
function startKinds(log: SessionLog): string[] {
  return log.events
    .filter((event) => event.type === 'turn/start')
    .map((event) => (event.data as { kind: string }).kind);
}

/** 等排程器把它那一串排完。 */
async function settle(pump: ThreadPump): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await pump.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));
    if (!pump.running) {
      await pump.whenIdle();
      await new Promise((resolve) => setImmediate(resolve));
      if (!pump.running) return;
    }
  }
}

describe('沒掛旗標', () => {
  it('一輪都不自己排——日誌上一顆 goal 事件都沒有', async () => {
    const { pump, state, stop } = await build({
      turns: CREATE_TURNS,
      threadId: 'no-driver',
      withDriver: false,
    });
    await pump.submit({ kind: 'message', text: '把 CI 修綠' });
    await settle(pump);
    expect(startKinds(pump.sessionLog)).toEqual(['message']);
    expect(state.prompts).toHaveLength(2);
    await stop();
  });
});

describe('掛了旗標', () => {
  /**
   * **這一條是這一份檔案的主角。**
   *
   * 日誌那顆 `turn/start.text` 與模型真的收到的那則訊息**必須是同一串字**。兩份分開算
   * 的話，一顆逐字正確的日誌可以配上餵給模型的任意內容，而伴生只看得到日誌那一份——
   * 它結構上驗不到這種偏差，所以這裡是唯一驗得到的地方。
   */
  it('人那一輪落定之後排第 1 輪，而模型讀到的字就是日誌上那一串', async () => {
    const { pump, state, violations, stop } = await build({
      turns: [...CREATE_TURNS, QUIET],
      threadId: 'driver-1',
      withDriver: true,
    });
    await pump.submit({ kind: 'message', text: '把 CI 修綠' });
    await settle(pump);

    expect(startKinds(pump.sessionLog)).toEqual(['message', 'goal']);
    const round = pump.sessionLog.events.find(
      (event) => event.type === 'turn/start' && (event.data as { kind: string }).kind === 'goal',
    );
    const data = round?.data as { text: string; goalId: string; revision: number; round: number };
    expect(data.round).toBe(1);
    expect(data.revision).toBe(1);
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
    // 模型在續行那一輪收到的第一則新訊息，逐字等於日誌上那一串。
    const lastPrompt = state.prompts.at(-1) ?? [];
    expect(lastPrompt.at(-1)?.content).toBe(data.text);
    // **不變量伴生跑在同一份組裝上，而且一聲都不吭。** 少了這一句，排程器與 renderer
    // 算出不同的字時，這一份測試照樣綠——它自己拿的是同一個 renderer。
    expect(violations).toEqual([]);
    await stop();
  });

  it('目標的輪次上限用完就停，並記一顆 round-limit', async () => {
    const turns: readonly ScriptedTurn[] = [
      {
        content: '',
        toolCalls: [{ name: 'create_goal', args: { objective: '把 CI 修綠', max_goal_rounds: 2 } }],
      },
      { content: '建好了。' },
      QUIET,
      QUIET,
    ];
    const { pump, port, stop } = await build({
      turns,
      threadId: 'driver-limit',
      withDriver: true,
    });
    await pump.submit({ kind: 'message', text: '把 CI 修綠' });
    await settle(pump);
    expect(startKinds(pump.sessionLog)).toEqual(['message', 'goal', 'goal']);
    expect(port.blocks).toEqual(['round-limit']);
    expect(port.goal()).toMatchObject({ phase: 'blocked', roundsStarted: 2 });
    await stop();
  });

  /** 耐久檢查點過不去就停用續行，**不是重試**——見 `goal-driver.ts` 檔頭。 */
  it('flush 失敗就 disarm，一輪都不排', async () => {
    const { pump, port, stop } = await build({
      turns: [...CREATE_TURNS, QUIET],
      threadId: 'driver-flush',
      withDriver: true,
      portOverrides: { flush: () => Promise.reject(new Error('磁碟滿了')) },
    });
    await pump.submit({ kind: 'message', text: '把 CI 修綠' });
    await settle(pump);
    expect(startKinds(pump.sessionLog)).toEqual(['message']);
    expect(port.warnings.join('\n')).toMatch(/磁碟滿了/u);
    expect(port.goal()).toMatchObject({ activation: 'disarmed', phase: 'active' });
    await stop();
  });

  /**
   * **人在 `flush()` 期間插話，那一筆照樣跑得到，而且排在續行前面。**
   *
   * 這一條釘的是**順序**，不是 `thread-pump.ts` 裡那兩句讓行——那兩句今天量不出差異，
   * 理由寫在它們旁邊（`#tail` 已經序列化了一切，排程器搶不了先）。這裡驗的是那個序列化
   * 在有排程器參與時照樣成立：人送進來的那一句不會被續行擠掉、也不會排到它後面去。
   */
  it('flush 期間人插話，那一筆排在續行前面', async () => {
    const ref: { pump?: ThreadPump } = {};
    let injected = false;
    const { pump, stop } = await build({
      turns: [...CREATE_TURNS, { content: '收到。' }],
      threadId: 'driver-yield',
      withDriver: true,
      portOverrides: {
        flush: () => {
          if (!injected && ref.pump !== undefined) {
            injected = true;
            void ref.pump.submit({ kind: 'message', text: '等等，先看這個' }).catch(() => {});
          }
          return Promise.resolve();
        },
      },
    });
    ref.pump = pump;
    await pump.submit({ kind: 'message', text: '把 CI 修綠' });
    await settle(pump);
    // 人那一筆排在續行前面，續行照樣拿得到它那一輪（上限是 1，剛好一輪）。
    expect(startKinds(pump.sessionLog)).toEqual(['message', 'message', 'goal']);
    expect(injected).toBe(true);
    await stop();
  });

  /**
   * **這一條是這張卡最深的那個驗收句**，而它只有走一次真的核准恢復才證得出來。
   *
   * 續行輪次停在核准點 → 人按批准 → 模型在恢復後那一段呼叫 `create_goal`。
   * `hasDirectHumanTurn` 往回追鏈時**穿過 `resume`**、然後撞上 `kind: 'goal'` 停住 ——
   * 人批准的是一顆工具，不是這一輪。這一格若破了，模型就能靠「叫一顆要核准的工具、
   * 等人按批准」把人類授權借到自己的續行輪次上。
   *
   * 單元那一半在 `@nexus/plugin-goal` 的 `authority.test.ts`；**手寫的事件序列證不到
   * 「真的跑一次會長這樣」**，所以這一條在這裡。
   */
  it('續行輪次停在核准點、人按批准之後，模型照樣建不了目標', async () => {
    const turns: readonly ScriptedTurn[] = [
      {
        content: '',
        toolCalls: [{ name: 'create_goal', args: { objective: '把 CI 修綠', max_goal_rounds: 1 } }],
      },
      { content: '建好了。' },
      // 續行第 1 輪：叫一顆要核准的工具，停在核准點。
      { content: '', toolCalls: [{ name: 'take_note', args: { text: '一筆' } }] },
      // 人按了批准之後這一段：試著再建一個目標。
      { content: '', toolCalls: [{ name: 'create_goal', args: { objective: '換一個' } }] },
      { content: '好吧。' },
    ];
    const { pump, state, stop } = await build({
      turns,
      threadId: 'driver-resume',
      withDriver: true,
      gated: true,
    });
    await pump.submit({ kind: 'message', text: '把 CI 修綠' });
    await settle(pump);
    // 續行那一輪停在核准點了。
    expect(startKinds(pump.sessionLog)).toEqual(['message', 'goal']);
    const pending = pump.pending;
    expect(pending).toBeDefined();

    await pump.submit({
      kind: 'resume',
      response: [{ type: 'approve', args: { text: '一筆' } }],
    });
    await settle(pump);

    expect(startKinds(pump.sessionLog)).toEqual(['message', 'goal', 'resume']);
    // **模型讀到的是一句拒絕**：往回追鏈穿過 resume 之後撞上 goal 那一輪就停住了。
    const said = state.prompts
      .flat()
      .map((message) => String(message.content))
      .join('\n');
    expect(said).toContain(GOAL_TOOL_AUTHORITY_MESSAGE);
    await stop();
  });

  /**
   * **收線之後日誌上不會再多一顆事件。** dsh 的 teardown 也是這樣：關掉準入、取消進行
   * 中的、等停穩。
   *
   * 擋住那一輪的是 `submit()` 自己的拒絕（收線之後它一律 reject），不是
   * `#driveGoalRound` 裡那兩處 `#closed`——那兩處只是提早退出，量過拿掉行為不變。
   * 這一條釘的是**結果**：thread 收掉之後沒有人再寫得進去。
   */
  it('close 之後一輪都不再排', async () => {
    const { pump, stop } = await build({
      turns: [...CREATE_TURNS, QUIET],
      threadId: 'driver-closed',
      withDriver: true,
      portOverrides: {
        // 在檢查點裡收線：排程器算完那一輪之後才會發現 thread 已經沒了。
        flush: () => {
          pump.close();
          return Promise.resolve();
        },
      },
    });
    await pump.submit({ kind: 'message', text: '把 CI 修綠' });
    await settle(pump);
    expect(startKinds(pump.sessionLog)).toEqual(['message']);
    await stop();
  });

  /** 沒有 goal 域（`--plugins` 換掉了預設清單）時安靜地什麼都不做。 */
  it('查不到域就不排，也不吭聲', async () => {
    const { pump, port, stop } = await build({
      turns: CREATE_TURNS,
      threadId: 'driver-nodomain',
      withDriver: true,
      portOverrides: { goal: () => undefined },
    });
    await pump.submit({ kind: 'message', text: '把 CI 修綠' });
    await settle(pump);
    expect(startKinds(pump.sessionLog)).toEqual(['message']);
    expect(port.warnings).toEqual([]);
    await stop();
  });
});
