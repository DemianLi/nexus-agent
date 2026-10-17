/**
 * goal 遷上樹之後，**宿主這一側**要證的事（[#1486](https://github.com/DemianLi/nexus-agent/issues/1486)，驗收 D、E 與 PM 補的三點）。
 *
 * 插件本身的 lazy 語意、一致性與「套一次服務兩條 thread」在 `packages/nexus-plugin-goal/src/tree.test.ts`；這一檔問的是宿主拿著
 * `goals` 服務做的事：
 *
 * - **逐出判斷走非建立式讀（`existingFor`）**：真的 wire handler＋真的 `goals` 服務＋真的 `create`。武裝中的目標不撤；沒碰過 goal
 *   的 thread 被撤，而且那一掃沒有替它建出服務；折疊壞掉的目標判成「不閒置」，不是一個沒人接的 rejection。
 * - **撤掉再開 ≡ 重啟再開**：核心跨組裝共用（樹上那一列的樣子），撤掉的日誌與它的服務都可回收；重開拿到新日誌、新服務，目標從日誌折回來，
 *   授權不持久所以是 `disarmed`——與重啟一致。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，時鐘是假的，掃描由 `handler.sweepIdle()` 決定性地驅動。
 */

import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';

import { GOALS_SERVICE } from '@nexus/goal';
import { createGoalCore, goalConfigSchema } from '@nexus/plugin-goal';
import type { GoalCore } from '@nexus/plugin-goal';
import { goalId, SessionLog } from '@nexus/core';
import type { GoalChangeMeta } from '@nexus/core';
import { historyPath } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { goalDriverPort } from './assembly-root.js';
import { loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createGoalPlugin, goalCoreOf } from './goal.fixture.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadAgent } from './wire-handler.js';

const BASE = 'http://goal-evict.test';
/** 閒置多久逐出；假時鐘的單位。 */
const T = 10_000;

interface Rig {
  readonly handler: ReturnType<typeof createWireHandler>;
  /** 整個行程共用的一份核心——樹上那一列的樣子。 */
  readonly core: GoalCore;
  /** 每條 thread 目前的 root 日誌（`goalDriver` 工廠收到的 `log()` 讀回來的）。 */
  readonly logs: Map<string, () => SessionLog>;
  readonly disposed: string[];
  readonly warnings: string[];
  advance(ms: number): void;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.handler.close();
});

function rig(): Rig {
  const core = createGoalCore(goalConfigSchema.parse({}));
  const logs = new Map<string, () => SessionLog>();
  const disposed: string[] = [];
  const warnings: string[] = [];
  const clock = { now: 1_000_000 };
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    idleEvictMs: T,
    // 計時器不插手：掃描由測試驅動。
    idleEvictPollMs: 3_600_000,
    now: () => clock.now,
    warn: (message) => warnings.push(message),
    createAgent: async (threadId): Promise<ThreadAgent> => {
      const built = await createNexusAgent({
        model: new ScriptedChatModel({ turns: [{ content: '好' }] }),
        checkpointer: new PrunedMemorySaver(),
        plugins: [createGoalPlugin({ core })],
        stepInbox: true,
      });
      return {
        agent: built.agent as unknown as PumpAgent,
        stepInbox: true,
        commands: built.commands,
        attachSessions: composeAttachSessions(built),
        // **跟產品一樣用 `goalDriverPort`**：逐出判斷走它的 `armed()`，而不是測試自己捏的替身。
        goalDriver: (log) => {
          logs.set(threadId, log);
          return goalDriverPort(
            goalCoreOf(built.services.use(GOALS_SERVICE)),
            log,
            () => Promise.resolve(),
            (message) => warnings.push(message),
          );
        },
        dispose: async () => {
          disposed.push(threadId);
          await built.dispose();
        },
      };
    },
  });
  const made: Rig = {
    handler,
    core,
    logs,
    disposed,
    warnings,
    advance: (ms) => {
      clock.now += ms;
    },
  };
  rigs.push(made);
  return made;
}

/** 讀一條 thread 的歷史：經 `threadFor`，不用跑模型就把一條 thread 組起來的最短路。 */
async function touch(r: Rig, thread: string): Promise<void> {
  const response = await r.handler.handle(
    loopbackRequest(`${BASE}${historyPath(thread)}`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    }),
  );
  await response.json();
}

function rootOf(r: Rig, thread: string): SessionLog {
  const read = r.logs.get(thread);
  if (read === undefined) throw new Error(`${thread} 還沒有 goalDriver 被問過日誌`);
  return read();
}

/** 掃一次，讓逐出（若有）完整落定。 */
async function sweep(r: Rig, ms = T * 2): Promise<void> {
  r.advance(ms);
  await r.handler.sweepIdle();
}

describe('閒置逐出走非建立式讀，而且讀的是真的 goals 服務', () => {
  it('武裝中的目標：不撤；收回授權之後才撤', async () => {
    const r = rig();
    await touch(r, 't1');
    const log = rootOf(r, 't1');
    const service = r.core.serviceFor(log);
    service.create({ objective: '把 CI 修綠' });
    expect(service.get()?.activation).toBe('armed');

    await sweep(r);
    expect(r.disposed).toEqual([]);

    service.disarm();
    // 放掉條件的那一刻要重新計時：再掃一次還是不撤，再過 T 才撤。
    await sweep(r, 1);
    expect(r.disposed).toEqual([]);
    await sweep(r, T);
    expect(r.disposed).toEqual(['t1']);
  });

  it('暫停的目標、完成的目標都不擋逐出（只有 active 且 armed 才擋）', async () => {
    const r = rig();
    await touch(r, 't1');
    const service = r.core.serviceFor(rootOf(r, 't1'));
    const created = service.create({ objective: '做完它' });
    service.pause({ id: created.id, revision: created.revision });
    expect(service.get()?.phase).toBe('paused');
    await sweep(r);
    expect(r.disposed).toEqual(['t1']);
  });

  it('沒碰過 goal 的 thread：被撤，而且那一掃沒有替它建出服務', async () => {
    const r = rig();
    await touch(r, 't1');
    const log = rootOf(r, 't1');
    expect(r.core.existingFor(log)).toBeUndefined();

    await sweep(r);

    expect(r.disposed).toEqual(['t1']);
    // 逐出的判斷問了 `armed()`；非建立式讀不能把這條 thread 的日誌整份重播一遍、也不能留下一個服務。
    expect(r.core.existingFor(log)).toBeUndefined();
  });

  it('折疊壞掉的目標：判成「不閒置」，不撤、不拋', async () => {
    const r = rig();
    await touch(r, 't1');
    const log = rootOf(r, 't1');
    // 日誌上有一顆接不上的 goal/change：服務一建出來重放就失敗，之後每一次 `get()` 都拋。
    log.append('goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'nonsense',
    } as unknown as GoalChangeMeta);
    const service = r.core.serviceFor(log);
    expect(() => service.get()).toThrow(/goal 重放在會話事件/u);

    await sweep(r);

    expect(r.disposed).toEqual([]);
  });
});

describe('撤掉再開 ≡ 重啟再開', () => {
  it('重開拿到新日誌、新服務；目標從日誌折回來，授權不持久（disarmed）', async () => {
    const r = rig();
    await touch(r, 't1');
    const before = rootOf(r, 't1');
    const first = r.core.serviceFor(before);
    const created = first.create({ objective: '跨過一次逐出' });
    first.disarm();
    // 逐出只認 SessionLog 的 events 是否落盤；這條 thread 的 goal 狀態要靠日誌帶過去，所以把事件抄成下一個行程的種子。
    const seed = [...before.events];

    await sweep(r);
    expect(r.disposed).toEqual(['t1']);

    // 重開：新組裝、新日誌（下一個行程的樣子——日誌帶著上一個的事件當種子）。
    r.logs.delete('t1');
    await touch(r, 't1');
    const after = rootOf(r, 't1');
    expect(after).not.toBe(before);
    const resumed = new SessionLog('t1-resumed', { seed });
    const second = r.core.serviceFor(resumed);
    expect(second).not.toBe(first);
    expect(second.get()).toMatchObject({
      id: created.id,
      objective: '跨過一次逐出',
      phase: 'active',
      activation: 'disarmed',
    });
    // 與「重啟再開」同一個結果：另起一份核心（另一個行程）重放同一份種子。
    const restarted = createGoalCore(goalConfigSchema.parse({})).serviceFor(
      new SessionLog('t1-restart', { seed }),
    );
    expect(second.get()).toEqual(restarted.get());
  });

  it('撤掉的日誌與它的服務可回收：查找表以日誌為弱鍵', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const core = createGoalCore(goalConfigSchema.parse({}));
    const serviceRef = (() => {
      const log = new SessionLog('collectable');
      const service = core.serviceFor(log);
      service.create({ objective: '會被回收' });
      return { log: new WeakRef(log), service: new WeakRef(service) };
    })();
    // gc → 讓出事件迴圈 → 再取，連跑幾輪：WeakRef 的目標在同一個同步區塊裡不會被回收。
    for (let round = 0; round < 5; round += 1) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(serviceRef.log.deref()).toBeUndefined();
    expect(serviceRef.service.deref()).toBeUndefined();
  });
});

describe('舊的 goal/change 種子仍可折回來（不依賴任何接線步驟）', () => {
  it('沒有 attachSession 的日誌，第一次問就重放', () => {
    const core = createGoalCore(goalConfigSchema.parse({}), {
      now: () => 7,
      newGoalId: () => 'goal-種子',
    });
    const earlier = new SessionLog('earlier');
    core.serviceFor(earlier).create({ objective: '種子裡的目標' });
    const resumed = new SessionLog('resumed', { seed: earlier.events });
    expect(core.existingFor(resumed)).toBeUndefined();
    expect(core.serviceFor(resumed).get()?.id).toBe(goalId('goal-種子'));
  });
});
