/**
 * 三顆模型工具走**真的通道**：註冊表 → `sessions` 接線 → `forCall` → 服務 → 日誌。
 *
 * 刻意不直接叫 `createGoalTools`：這個套件宣稱「掛上去之後模型改得動同一份域狀態」，
 * 而那個宣稱裡最容易靜靜壞掉的是接線那一段（`forCall` 挑錯日誌、服務查不到）。
 *
 * **權限那一半的單元在 `authority.test.ts`**，走真 agent 的行為驗收在
 * `apps/harness/src/goal-tools.test.ts`——那一份才證得了核准恢復之後那一輪真的過得了。
 */

import { describe, expect, it } from 'vitest';

import type { StructuredTool } from '@langchain/core/tools';
import { createRegistry, createSessionRunner, SessionRegistry } from '@nexus/core';
import type { NamedEntry, SessionLog } from '@nexus/core';

import { createGoalPlugin } from './index.js';
import type { GoalPluginOptions } from './index.js';
import {
  GOAL_CREATE_TOOL_NAME,
  GOAL_GET_TOOL_NAME,
  GOAL_MODEL_REPORTED_CODE,
  GOAL_TOOL_AUTHORITY_MESSAGE,
  GOAL_TOOL_ERROR_PREFIX,
  GOAL_TOOL_INVALID_REF_MESSAGE,
  GOAL_TOOL_NO_SERVICE_MESSAGE,
  GOAL_TOOL_NOT_ATTACHED_MESSAGE,
  GOAL_TOOL_REASON_MISPLACED_MESSAGE,
  GOAL_TOOL_REASON_REQUIRED_MESSAGE,
  GOAL_TOOL_REPLACEMENT_MISPLACED_MESSAGE,
  GOAL_TOOL_UNKNOWN_CALLER_MESSAGE,
  GOAL_UPDATE_TOOL_NAME,
} from './tools.js';

/** root 的工具呼叫長這樣（`session-address.ts` 那張表的第一列）。 */
const ROOT_CALL = { configurable: { checkpoint_ns: 'tools:call-1' } };

/**
 * 一次組裝：註冊表 → 綁一張 `SessionRegistry` → 每一份會話各裝一次參與者。
 *
 * **`bind` 是 `forCall` 唯一的輸入**（`registry.ts` 的 `boundSessions`），所以照
 * `agent-factory.ts` 的 `attachSession` 抄同一組四行——少一行工具就一律回「沒接上」。
 */
function bench(options: GoalPluginOptions = {}): {
  log: SessionLog;
  sessions: SessionRegistry;
  registry: ReturnType<typeof createRegistry>;
  call: (name: string, args?: Record<string, unknown>, config?: unknown) => Promise<string>;
  tools: Map<string, NamedEntry<StructuredTool>>;
} {
  let serial = 0;
  const plugin = createGoalPlugin({
    now: () => 100,
    newGoalId: () => `goal-${(serial += 1)}`,
    ...options,
  });
  const registry = createRegistry();
  const exit = registry.enter({ id: 'goal#0', name: 'goal' });
  plugin.apply(registry);
  exit();
  const sessions = new SessionRegistry('goal');
  attach(registry, sessions);
  const tools = registry.tools.effective(undefined);
  return {
    log: sessions.root,
    sessions,
    registry,
    tools,
    call: async (name, args = {}, config = ROOT_CALL) => {
      const found = tools.get(name);
      if (found === undefined) throw new Error(`沒有這顆工具：${name}`);
      return String(await found.value.invoke(args as never, config as never));
    },
  };
}

/** 照 `agent-factory.ts` 的 `attachSession`：綁註冊表，每一份會話各裝一次參與者。 */
function attach(registry: ReturnType<typeof createRegistry>, sessions: SessionRegistry): void {
  const installers = registry.sessions.installers();
  registry.sessions.bind(sessions);
  sessions.observe(({ address, log }) => {
    if (installers.length > 0) createSessionRunner({ address, log, installers });
  });
}

/** 記一顆人打的輪次。 */
function human(log: SessionLog, text = '把這件事做完'): void {
  log.append('turn/start', { kind: 'message', text });
}

/** 解出一次回傳的 JSON。 */
function parse(raw: string): { goal: unknown; activation?: unknown } {
  return JSON.parse(raw) as { goal: unknown; activation?: unknown };
}

/** 目前這一份的 CAS 兩格。 */
async function refOf(call: ReturnType<typeof bench>['call']): Promise<{
  goal_id: string;
  revision: number;
}> {
  const view = parse(await call(GOAL_GET_TOOL_NAME)).goal as { id: string; revision: number };
  return { goal_id: view.id, revision: view.revision };
}

describe('註冊', () => {
  it('三顆都在，而且都是 rootOnly——subagent 那一份拿到的是拒絕樁', () => {
    const { tools } = bench();
    expect([...tools.keys()].sort()).toEqual(
      [GOAL_CREATE_TOOL_NAME, GOAL_GET_TOOL_NAME, GOAL_UPDATE_TOOL_NAME].sort(),
    );
  });
});

describe('get_goal', () => {
  it('沒有目標時回 {"goal":null}，而且不要求任何權限', async () => {
    const { call } = bench();
    expect(await call(GOAL_GET_TOOL_NAME)).toBe('{"goal":null}');
  });

  it('有目標時把 id、revision 與相位一起交出去', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '把 CI 修綠' });
    const value = parse(await call(GOAL_GET_TOOL_NAME));
    expect(value.goal).toMatchObject({
      id: 'goal-1',
      revision: 1,
      objective: '把 CI 修綠',
      phase: 'active',
      roundsStarted: 0,
    });
    expect(value.activation).toBe('armed');
  });
});

describe('create_goal', () => {
  it('人打過字就建得起來，而且域真的動了', async () => {
    const { call, log } = bench();
    human(log);
    const value = parse(await call(GOAL_CREATE_TOOL_NAME, { objective: '把 CI 修綠' }));
    expect(value.goal).toMatchObject({ objective: '把 CI 修綠', phase: 'active' });
    expect(log.events.filter((event) => event.type === 'goal/change')).toHaveLength(1);
  });

  /** **這一條是權限那半在工具上的守衛**：日誌裡沒有人類輪次，域一格都不准動。 */
  it('這一輪追不到人類訊息就拒絕，而且什麼都沒寫', async () => {
    const { call, log } = bench();
    expect(await call(GOAL_CREATE_TOOL_NAME, { objective: '偷偷來' })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_AUTHORITY_MESSAGE,
    );
    expect(log.events).toEqual([]);
  });

  it('max_goal_rounds 給了就用它', async () => {
    const { call, log } = bench();
    human(log);
    const value = parse(
      await call(GOAL_CREATE_TOOL_NAME, { objective: '長跑', max_goal_rounds: 12 }),
    );
    expect(value.goal).toMatchObject({ maxGoalRounds: 12 });
  });

  it('域的拒絕（已經有一個沒完成的目標）變成一句話，不是拋', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '第一個' });
    const second = await call(GOAL_CREATE_TOOL_NAME, { objective: '第二個' });
    expect(second.startsWith(GOAL_TOOL_ERROR_PREFIX)).toBe(true);
    expect(second).toContain('已經存在');
  });
});

describe('update_goal', () => {
  it('照抄 get_goal 的兩格就改得動敘述', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '舊的' });
    const ref = await refOf(call);
    const value = parse(
      await call(GOAL_UPDATE_TOOL_NAME, { ...ref, action: 'edit', objective: '新的' }),
    );
    expect(value.goal).toMatchObject({ objective: '新的', revision: 2, phase: 'active' });
  });

  /** CAS 是這顆工具的重點：拿舊的 revision 打就該被擋，而且目標一字不動。 */
  it('過期的 revision 被擋，目標維持原樣', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '原本的' });
    const stale = await refOf(call);
    await call(GOAL_UPDATE_TOOL_NAME, { ...stale, action: 'edit', objective: '改一次' });
    const rejected = await call(GOAL_UPDATE_TOOL_NAME, {
      ...stale,
      action: 'edit',
      objective: '再改一次',
    });
    expect(rejected.startsWith(GOAL_TOOL_ERROR_PREFIX)).toBe(true);
    expect(parse(await call(GOAL_GET_TOOL_NAME)).goal).toMatchObject({
      objective: '改一次',
      revision: 2,
    });
  });

  it('pause 與 resume 走得通', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '暫停看看' });
    const paused = parse(
      await call(GOAL_UPDATE_TOOL_NAME, { ...(await refOf(call)), action: 'pause' }),
    );
    expect(paused.goal).toMatchObject({ phase: 'paused' });
    expect(paused.activation).toBe('disarmed');
    const resumed = parse(
      await call(GOAL_UPDATE_TOOL_NAME, { ...(await refOf(call)), action: 'resume' }),
    );
    expect(resumed.goal).toMatchObject({ phase: 'active' });
    expect(resumed.activation).toBe('armed');
  });

  it('complete 走得通', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '做完它' });
    const done = parse(
      await call(GOAL_UPDATE_TOOL_NAME, { ...(await refOf(call)), action: 'complete' }),
    );
    expect(done.goal).toMatchObject({ phase: 'complete' });
  });

  /**
   * **blocked 沒有輪次門檻**，因為沒有輪次可數（`tools.ts` 檔頭第 2 列）。dsh 那側要
   * 連續 3 個 goal round，我們這裡人直接說「擋住了」就擋得住。
   */
  it('blocked 帶理由就擋得住，理由用 model-reported 落庫', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: '擋住的' });
    const value = parse(
      await call(GOAL_UPDATE_TOOL_NAME, {
        ...(await refOf(call)),
        action: 'blocked',
        blocked_reason: '拿不到測試環境的憑證',
      }),
    );
    expect(value.goal).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: GOAL_MODEL_REPORTED_CODE, message: '拿不到測試環境的憑證' },
    });
  });

  it('blocked 沒帶理由被擋', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: 'x' });
    expect(await call(GOAL_UPDATE_TOOL_NAME, { ...(await refOf(call)), action: 'blocked' })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_REASON_REQUIRED_MESSAGE,
    );
  });

  it('replacement 配在 edit 以外的 action 上被擋', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: 'x' });
    expect(
      await call(GOAL_UPDATE_TOOL_NAME, {
        ...(await refOf(call)),
        action: 'pause',
        objective: '順便改一下',
      }),
    ).toBe(GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_REPLACEMENT_MISPLACED_MESSAGE);
  });

  it('blocked_reason 配在 blocked 以外的 action 上被擋', async () => {
    const { call, log } = bench();
    human(log);
    await call(GOAL_CREATE_TOOL_NAME, { objective: 'x' });
    expect(
      await call(GOAL_UPDATE_TOOL_NAME, {
        ...(await refOf(call)),
        action: 'complete',
        blocked_reason: '順便講一下',
      }),
    ).toBe(GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_REASON_MISPLACED_MESSAGE);
  });

  it('goal_id 空的或 revision 是 0 都被擋', async () => {
    const { call, log } = bench();
    human(log);
    expect(await call(GOAL_UPDATE_TOOL_NAME, { goal_id: '', revision: 1, action: 'pause' })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_INVALID_REF_MESSAGE,
    );
    expect(await call(GOAL_UPDATE_TOOL_NAME, { goal_id: 'g', revision: 0, action: 'pause' })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_INVALID_REF_MESSAGE,
    );
  });

  it('沒有人類輪次時，每一個 action 都被擋', async () => {
    const { call } = bench();
    for (const action of ['edit', 'pause', 'resume', 'complete', 'blocked']) {
      expect(await call(GOAL_UPDATE_TOOL_NAME, { goal_id: 'goal-1', revision: 1, action })).toBe(
        GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_AUTHORITY_MESSAGE,
      );
    }
  });
});

describe('接線說得出原因', () => {
  it('認不出呼叫者', async () => {
    const { call } = bench();
    expect(await call(GOAL_GET_TOOL_NAME, {}, { configurable: {} })).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_UNKNOWN_CALLER_MESSAGE,
    );
  });

  it('這次組裝沒接會話日誌', async () => {
    const plugin = createGoalPlugin();
    const registry = createRegistry();
    const exit = registry.enter({ id: 'goal#0', name: 'goal' });
    plugin.apply(registry);
    exit();
    const found = registry.tools.effective(undefined).get(GOAL_GET_TOOL_NAME);
    expect(String(await found?.value.invoke({} as never, ROOT_CALL as never))).toBe(
      GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_NOT_ATTACHED_MESSAGE,
    );
  });

  /**
   * **subagent 那條路的字面版本。** 域只接 root，所以一份 subagent 日誌上本來就沒有服務。
   * 產品路徑到不了這裡（工具是 `rootOnly` 註冊的），釘住它是為了萬一那層沒了，這裡
   * **仍然 fail-closed**——回一句話，不是靜靜動到 root 的目標。
   */
  it('日誌在、但那一份上沒有 goal 域', async () => {
    const { sessions, tools } = bench();
    const log = sessions.open({ kind: 'subagent', runId: 'tools:spawn-1' });
    human(log);
    const found = tools.get(GOAL_CREATE_TOOL_NAME);
    const result = String(
      await found?.value.invoke(
        { objective: '偷偷來' } as never,
        {
          configurable: { checkpoint_ns: 'tools:spawn-1|tools:call-1' },
        } as never,
      ),
    );
    expect(result).toBe(GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_NO_SERVICE_MESSAGE);
    expect(log.events.filter((event) => event.type === 'goal/change')).toEqual([]);
  });
});
