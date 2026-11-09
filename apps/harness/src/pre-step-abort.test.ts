/**
 * **`agent/pre-step` 期間按了停止：那一步不叫模型，兩個 loop 一樣**（[#2618](https://github.com/DemianLi/nexus-agent/issues/2618)）。
 *
 * 停止的時機由一位 `agent/pre-step` 監聽者卡住：第一次被叫時送停止，等這一步的 signal 中止才往下交。組裝是真的
 * `createNexusAgent` 接 pump，同 `turn-cancel.test.ts`。
 *
 * 判準看日誌：中止那一步的請求快照（`request/system`、`request/header`）與起訖（`model/start`、`model/end`）一顆都不寫。
 * 只拿掉 `model/start` 的話，留下的請求快照等不到它的 `model/start`，日誌關係檢查會報 `request-without-model-start`。
 *
 * @module
 */

import { MemorySaver } from '@langchain/langgraph';
import { createSessionRelationshipChecker } from '@nexus/core';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type Loop = 'langgraph' | 'native';

/** 中止那一步不該寫的四顆。 */
const STEP_EVENTS = ['request/system', 'request/header', 'model/start', 'model/end'] as const;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * 組一份：上了膛的監聽者在下一次 pre-step 送停止、等 signal 中止，再回 `decide()` 的結果。
 *
 * @param loop - 哪一個 loop。
 * @param decide - 等到中止之後回什麼；`continue` 往下交，`reject` 擋下。
 */
async function assemble(loop: Loop, decide: 'continue' | 'reject') {
  const model = new ScriptedChatModel({ turns: [{ content: '第二句收到。' }] });
  const control: { armed: boolean; pump?: ThreadPump } = { armed: false };
  const stopper: PluginEntry = {
    plugin: {
      name: 'pre-step-stopper',
      apply(registry) {
        registry.events.on('agent/pre-step', async (payload, next) => {
          if (!control.armed) return next();
          control.armed = false;
          control.pump?.cancel();
          await new Promise<void>((resolve) => {
            if (payload.signal.aborted) resolve();
            else payload.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return decide === 'reject' ? { kind: 'reject' as const, reason: '測試：擋下' } : next();
        });
      },
    },
  };
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    agentLoop: loop,
    plugins: [stopper],
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, `pre-step-abort-${loop}`);
  control.pump = pump;
  const detach = built.attachSession(pump.sessions);
  cleanups.push(async () => {
    detach();
    await built.dispose();
  });
  return {
    model,
    pump,
    arm: () => {
      control.armed = true;
    },
    armed: () => control.armed,
    log: (): readonly SessionEvent[] => pump.sessions.root.events,
  };
}

const typesOf = (events: readonly SessionEvent[]) => events.map((event) => event.type);

/** 從頭餵一遍日誌關係檢查，回所有違規的規則名。 */
function violationsOf(events: readonly SessionEvent[]): string[] {
  const checker = createSessionRelationshipChecker();
  return events.flatMap((event) => checker.accept(event).map((violation) => violation.rule));
}

describe('pre-step 期間按停止', () => {
  it.each(['native', 'langgraph'] as const)(
    '%s：那一步的請求快照與起訖一顆都不寫，模型沒被叫；下一輪照常，快照記在那一次',
    async (loop: Loop) => {
      const run = await assemble(loop, 'continue');
      run.arm();
      await run.pump.submit({ kind: 'message', text: '說句話' });
      expect(run.armed()).toBe(false);

      const stopped = run.log();
      expect(stopped.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted', cause: { kind: 'user' } } },
      });
      for (const type of STEP_EVENTS) expect(typesOf(stopped)).not.toContain(type);
      expect(run.model.prompts).toHaveLength(0);
      expect(violationsOf(stopped)).toEqual([]);

      // 同一份組裝不中止時，四顆都寫：上面的「沒有」不是因為這份組裝本來就不寫。
      const before = stopped.length;
      await run.pump.submit({ kind: 'message', text: '再說一次' });
      const resumed = run.log().slice(before);
      for (const type of STEP_EVENTS) expect(typesOf(resumed)).toContain(type);
      expect(resumed.at(-1)).toMatchObject({ type: 'turn/end', data: {} });
      expect(run.model.prompts).toHaveLength(1);
      expect(violationsOf(run.log())).toEqual([]);
    },
    30000,
  );

  it.each(['native', 'langgraph'] as const)(
    '%s：中止之後監聽者又回 reject，這一輪收成被擋下，不是被中止',
    async (loop: Loop) => {
      const run = await assemble(loop, 'reject');
      run.arm();
      await run.pump.submit({ kind: 'message', text: '說句話' });
      expect(run.armed()).toBe(false);

      const events = run.log();
      expect(events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'blocked' } },
      });
      for (const type of STEP_EVENTS) expect(typesOf(events)).not.toContain(type);
      expect(run.model.prompts).toHaveLength(0);
      expect(violationsOf(events)).toEqual([]);
    },
    30000,
  );
});
