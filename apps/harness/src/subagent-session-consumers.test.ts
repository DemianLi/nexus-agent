/**
 * **subagent 的那份日誌，三個消費者一個都不能少**——
 * [#137](https://github.com/DemianLi/nexus-agent/issues/137) 的第四條驗收。
 *
 * 一份日誌今天被三樣東西訂閱：不變量 runner、`sessions` 參與者 runner、遙測協調器。
 * 在會話註冊表出現之前，接線是**組裝點手做的一步，一次接一份**——所以第二份日誌不重接
 * 就沒有檢查、沒有參與者、也不進遙測，而**三件事都是靜默的**。這一檔就是那三個靜默失敗
 * 的絆索。
 *
 * **它們不是三個政策決定。** dsh 那側沒有「要不要接」這個問題：消費者訂的是 session
 * 註冊表，不是一份 session（`packages/core/session/src/invariant.ts:218-220` 的
 * `for (const session of ctx.sessions.list())` 加 `ctx.on('session/created', …)`；遙測的
 * coordinator 檔頭寫的是 “subscribes to the session firehose”）。我們把那個結構補起來，
 * 三題就一起消失了。調研見 `.docs/subagent-session-log-survey.md`。
 *
 * **零憑證、零外部連線**：後端是測試自己的假貨，模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SessionRegistry } from '@nexus/core';
import type {
  InvariantError,
  NexusPlugin,
  SessionTelemetryRecord,
  SessionTelemetryService,
} from '@nexus/core';
import { createGoalPlugin, GOAL_COMMAND_NAME, goalAmbiguousMessage } from '@nexus/plugin-goal';
import { createNexusAgent } from './agent-factory.js';
import { DEFAULT_PLUGINS } from './cli.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const WRITER_TOOL_NAME = 'writer_tool';
const ROOT_ID = 'consumers';

/** 三位消費者各自看到的 `(日誌 id, 事件種類)`。 */
interface Seen {
  readonly invariants: string[];
  readonly participants: string[];
  readonly telemetry: SessionTelemetryRecord[];
}

function collectingSink(records: SessionTelemetryRecord[]): SessionTelemetryService {
  return {
    sharing: 'full',
    emit: (record) => void records.push(record),
    shutdown: () => Promise.resolve(),
  };
}

/**
 * 一個 plugin 掛上全部四樣：會寫日誌的工具、一個 subagent，以及三位消費者。
 *
 * **四樣掛在同一個 `apply` 裡是刻意的**：這一檔問的正是「同一次組裝裡，後來才出生的那份
 * 日誌有沒有被同一批消費者接上」。拆成四個 plugin 問的是另一個問題。
 */
function observingPlugin(seen: Seen): NexusPlugin {
  return {
    name: 'observing',
    apply(registry) {
      registry.tools.register(
        tool(
          ({ note }: { note: string }, config?: unknown) => {
            const found = registry.sessions.forCall(config);
            if (found.kind !== 'ok') return `寫不進去：${found.kind}`;
            // **`turn/failed` 在這裡只是「一個帶字串的事件」**，不是真工具該寫的東西：
            // turn 的擁有者是進入點。下面「輪的擁有者」那一組把這件事講清楚並釘住。
            found.log.append('turn/failed', { message: note });
            return '記了一筆。';
          },
          {
            name: WRITER_TOOL_NAME,
            description: '把一句話記進會話日誌。',
            schema: z.object({ note: z.string() }),
          },
        ),
      );
      registry.subagents.register({ name: 'worker', description: '幹活的。' });

      registry.invariants.register('@nexus/observing', (subject) => {
        subject.observe(
          (event) => void seen.invariants.push(`${subject.log.sessionId}/${event.type}`),
        );
      });
      registry.sessions.join((subject) => {
        subject.observe(
          (event) => void seen.participants.push(`${subject.log.sessionId}/${event.type}`),
        );
      });
      registry.telemetry.use(collectingSink(seen.telemetry));
    },
  };
}

describe('subagent 的日誌與三個消費者', () => {
  it('三個都自動接上了——沒有人記得替第二份日誌重接', async () => {
    const model = new ScriptedChatModel({
      turns: [
        { content: '根記一筆。', toolCalls: [{ name: WRITER_TOOL_NAME, args: { note: '根' } }] },
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        {
          content: '子代理記一筆。',
          toolCalls: [{ name: WRITER_TOOL_NAME, args: { note: '子代理' } }],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '根再收一次。' },
      ],
    });
    const seen: Seen = { invariants: [], participants: [], telemetry: [] };
    const { agent, attachTelemetry, attachInvariants, attachSession, dispose } =
      await createNexusAgent({
        model,
        checkpointer: new MemorySaver(),
        plugins: [observingPlugin(seen)],
      });
    const sessions = new SessionRegistry(ROOT_ID);
    // 順序同兩條進入點：遙測、不變量、參與者。
    const detachTelemetry = attachTelemetry(sessions);
    const detachInvariants = attachInvariants(sessions);
    const detachSession = attachSession(sessions);

    try {
      await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: ROOT_ID } });
    } finally {
      detachSession();
      detachInvariants?.();
      await detachTelemetry?.();
      await dispose();
    }

    const subagent = sessions.list().find((entry) => entry.address.kind === 'subagent');
    expect(subagent).toBeDefined();
    const subagentId = subagent!.log.sessionId;

    // **不變量**：接了才擋得住 subagent 寫壞狀態；不接就是一個沒有檢查的角落。
    expect(seen.invariants).toContain(`${subagentId}/turn/failed`);
    // **參與者**：接了才有人在摺 subagent 那份日誌的狀態。
    expect(seen.participants).toContain(`${subagentId}/turn/failed`);
    // **遙測**：接了 subagent 的事件才出得去。
    expect(
      seen.telemetry
        .filter((record) => record.channel === 'ledger')
        .map((record) => record.attributes['session.id']),
    ).toContain(subagentId);

    // 三個都同時看得到 root 那份——新結構不是把 root 換成 subagent，是兩份都有。
    expect(seen.invariants).toContain(`${ROOT_ID}/turn/failed`);
    expect(seen.participants).toContain(`${ROOT_ID}/turn/failed`);
  });
});

/** 委派一次、子代理不寫任何東西，只把自己那份日誌**開出來**。 */
const OPEN_ONLY = 'open_only';

/** 委派一次、子代理往自己那份日誌寫一顆 turn 事件。 */
const WRITE_TURN = 'write_turn';

function boundaryPlugin(write: boolean): NexusPlugin {
  return {
    name: 'boundary',
    apply(registry) {
      registry.tools.register(
        tool(
          (_input: Record<string, never>, config?: unknown) => {
            const found = registry.sessions.forCall(config);
            if (found.kind !== 'ok') return `寫不進去：${found.kind}`;
            if (write) found.log.append('turn/failed', { message: '子代理寫的' });
            return '好了。';
          },
          {
            name: write ? WRITE_TURN : OPEN_ONLY,
            description: '碰一下自己那份會話日誌。',
            schema: z.object({}),
          },
        ),
      );
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  };
}

/** 委派一次、子代理呼叫那顆工具、收工；root 全程不寫日誌。 */
function delegatingModel(toolName: string): ScriptedChatModel {
  return new ScriptedChatModel({
    turns: [
      {
        content: '委派。',
        toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
      },
      { content: '子代理動手。', toolCalls: [{ name: toolName, args: {} }] },
      { content: '子代理收工。' },
      { content: '根收工。' },
      { content: '再收一次。' },
    ],
  });
}

/**
 * 跑一輪，回報**真的十二個配套入口**報了什麼。
 *
 * **重點在「真的」。** 上面那一組掛的是自己寫的 `@nexus/observing`，它從來不 `fail`，
 * 所以它證得了「消費者接上了」，證不了「接上去之後不會誤報」。而誤報的去處是使用者的
 * 終端機（`cli.ts` 的 `printer.error('[不變量] …')`），一條會在正常流量上誤報的檢查比
 * 沒有檢查更糟——同 `invariant-paths.test.ts` 檔頭那一條。
 */
async function violationsFrom(plugin: NexusPlugin, toolName: string): Promise<string[]> {
  const violations: string[] = [];
  const { agent, attachInvariants, attachSession, dispose } = await createNexusAgent({
    model: delegatingModel(toolName),
    checkpointer: new MemorySaver(),
    plugins: [...DEFAULT_PLUGINS, plugin],
    onInvariantViolation: (error: InvariantError) => void violations.push(error.message),
  });
  const sessions = new SessionRegistry('boundary');
  const detachInvariants = attachInvariants(sessions);
  const detachSession = attachSession(sessions);
  try {
    // 照兩條進入點實際發的順序，把 root 那一輪包起來。
    sessions.root.append('turn/start', { kind: 'message', text: '跑。' });
    await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'boundary' } });
    sessions.root.append('turn/end', {});
  } finally {
    detachSession();
    detachInvariants?.();
    await dispose();
  }
  return violations;
}

describe('輪的擁有者是進入點，不是工具', () => {
  it('多出一份 subagent 日誌本身不會讓任何配套入口吭聲', async () => {
    expect(await violationsFrom(boundaryPlugin(false), OPEN_ONLY)).toEqual([]);
  });

  /**
   * **這一條釘的是一個約定，而它讀起來像壞掉。**
   *
   * subagent 的日誌上**永遠不會有 `turn/start`**：發 turn 事件的是進入點
   * （`thread-pump.ts` 的 `#runOnce`、`cli.ts` 的 `runTurn`），而 subagent 不經過進入點
   * ——它是基座的 `task` middleware 跑的，我們看不到它開始也看不到它結束。所以一顆
   * `turn/failed` 落在那份日誌上，就是「關了一個沒有開著的輪」，核心的 turn 配對當場報。
   *
   * **報得對，不要去鬆綁它。** 鬆綁的代價是 root 那側真正的配對錯誤跟著看不見。要往
   * subagent 的日誌寫東西的工具，該用**自己域的事件種類**（[#132](https://github.com/DemianLi/nexus-agent/issues/132)
   * 的 `todo/write` 會是第一顆），而配套入口對不認得的種類是放行的（`invariant.ts` 的
   * `default` 分支）。
   *
   * 也不要靠「開會話的時候補一顆 `turn/start`」來擺平——那是合成一顆沒有人發過的事件，
   * 而日誌的價值來自它記的是量到的東西。
   */
  it('工具往 subagent 的日誌寫 turn 事件，核心配套入口會報——而那是對的', async () => {
    expect(await violationsFrom(boundaryPlugin(true), WRITE_TURN)).toEqual([
      'invariant violated by "@nexus/core": turn/failed（seq 0）關了一個沒有開著的輪',
    ]);
  });
});

/**
 * **`@nexus/plugin-goal` 只接 root 那一份，而這一條就是那行 `if` 的絆索。**
 *
 * 拿掉 `index.ts` 裡的 `if (subject.address.kind !== 'root') return;`，這裡會紅：參與者
 * 是每一份會話各裝一次的，所以每次委派都多長出一個 `GoalService`，`/goal` 從第二次
 * 委派開始一律回 {@link goalAmbiguousMessage}——一個沒有人動過它卻壞掉的命令。
 *
 * 而「只管 root」不是為了繞過那件事：**它就是 dsh 對 goal 的政策**（`tool-goal` 的
 * `hasDirectHumanInput` 第一道是 `ctx.agents.roots().includes(execution.agent)`）。目標是
 * 人交代的，subagent 沒有人可以交代。
 */
describe('goal 的參與者只掛在 root 上', () => {
  it('委派過之後 `/goal` 照樣答得出來，不是「接了不只一份」', async () => {
    const goal = createGoalPlugin();
    const { agent, commands, attachSession, dispose } = await createNexusAgent({
      model: delegatingModel(OPEN_ONLY),
      checkpointer: new MemorySaver(),
      plugins: [goal, boundaryPlugin(false)],
    });
    const sessions = new SessionRegistry('goal-root');
    const detach = attachSession(sessions);
    try {
      await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'goal-root' } });
      // 子代理那一份真的開出來了，這一條才問得出東西。
      expect(sessions.list()).toHaveLength(2);
      // 掛著的服務仍然只有一個——root 那個。
      expect(goal.attached()).toHaveLength(1);

      const definition = commands.find(GOAL_COMMAND_NAME);
      const answer = await definition?.handler({
        commandId: 'cmd-1',
        rawInput: '',
        signal: new AbortController().signal,
      });
      expect(answer?.text).not.toBe(goalAmbiguousMessage(2));
    } finally {
      detach();
      await dispose();
    }
  });
});
