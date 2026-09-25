/**
 * **排著的話等核准答完才跑**——[#629](https://github.com/DemianLi/nexus-agent/issues/629) 的驗收。
 *
 * 第一輪還在跑的時候送出第二句，第一輪接著停在核准點。修之前第二句輪到就照開一輪：那顆中斷被基座靜靜
 * 丟掉（`danger` 沒跑也沒被拒，模型看到 `another message came in`），thread 還卡在「停在核准點」。
 *
 * 照 dsh：排著的話在收件匣的 `next-turn` 裡，**只在一輪開始時領**（`packages/core/agent-loop/src/agent.ts:296-330`，
 * `477b4f4`）。核准是那一輪裡的互動，所以等核准時不會被領走。
 *
 * 三層：
 *
 * - **真的組裝**（`attachSession` 接上）：核准、拒絕、收回、同一輪兩顆只答一顆、停住時收線。斷言到日誌
 *   的 `turn/start`／`turn/end` 順序與模型在第二句那一輪讀到的訊息。
 * - **假的 agent**：只有它排得出兩種先後——第一輪還在收尾時答覆就送進來（排在第二句後面），以及答覆
 *   那一輪跑著時又送一句（要排在停住的那幾句後面）。
 * - **wire**：跑著時 `run.start` 收件、停在核准點後再 `input.respond`。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { TOOL_ABORTED_BEFORE_DISPATCH_TEXT } from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionLog } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { createWireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent, PumpInput } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

/** 工具跑到哪裡了——「跑沒跑」的答案在這裡，不在回傳的措辭上。 */
interface Probe {
  slowStarted: number;
  danger: number;
}

const DANGER_DONE = '危險的事做完了';
const ANOTHER_MESSAGE = 'another message came in';

function toolsPlugin(probe: Probe): PluginEntry {
  return {
    plugin: {
      name: 'queued-tools',
      apply(registry) {
        registry.tools.register(
          tool(
            async () => {
              probe.slowStarted += 1;
              await new Promise((resolve) => setTimeout(resolve, 60));
              return '寫好了';
            },
            { name: 'slow_write', description: '慢慢寫一個檔。', schema: z.object({}) },
          ),
        );
        for (const name of ['danger', 'danger_two']) {
          registry.tools.register(
            tool(
              () => {
                probe.danger += 1;
                return DANGER_DONE;
              },
              { name, description: '要核准。', schema: z.object({}) },
            ),
          );
        }
        registry.approvals.gate((exec, next) =>
          exec.name.startsWith('danger') ? { kind: 'ask', reason: '危險' } : next(),
        );
      },
    },
  };
}

/** 第一輪：先跑慢工具（第二句在這時送進來），再叫要核准的 `danger`。 */
const SCRIPT: readonly ScriptedTurn[] = [
  { content: '先寫。', toolCalls: [{ name: 'slow_write', args: {} }] },
  { content: '再做危險的。', toolCalls: [{ name: 'danger', args: {} }] },
  { content: '第一輪收尾。' },
  { content: '第二句的回覆。' },
  { content: '第三句的回覆。' },
];

/** 日誌上一輪一輪的邊界，照順序：`start:<kind>[:<text>]` 與 `end`。 */
function turnMarks(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'turn/start') {
      const data = event.data as { kind: string; text?: string };
      return [`start:${data.kind}${data.text === undefined ? '' : `:${data.text}`}`];
    }
    return event.type === 'turn/end' || event.type === 'turn/failed' ? ['end'] : [];
  });
}

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 真的組裝接上一個 pump——serve 那條路的形狀，同 `turn-cancel.test.ts`。 */
async function assemble(turns: readonly ScriptedTurn[] = SCRIPT) {
  const probe: Probe = { slowStarted: 0, danger: 0 };
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [toolsPlugin(probe)],
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'queued-root');
  const detach = built.attachSession(pump.sessions);
  return {
    probe,
    model,
    pump,
    marks: () => turnMarks(pump.sessionLog.events),
    /** 送第一句、在慢工具跑著時送第二句，等第一輪停在核准點。 */
    async stopWithQueued(): Promise<{ readonly second: Promise<void> }> {
      const first = pump.submit({ kind: 'message', text: '第一句' });
      await until(() => probe.slowStarted === 1);
      const second = pump.submit({ kind: 'message', text: '第二句' });
      await first;
      // 包在物件裡：`async` 回傳的 promise 會被攤平，那就變成連第二句一起等。
      return { second };
    },
    close: async () => {
      detach();
      await built.dispose();
    },
  };
}

/** 模型在某一次呼叫裡讀到的所有訊息文字。 */
function promptText(model: ScriptedChatModel, call: number): string {
  return (model.prompts[call] ?? []).map((message) => message.text).join('\n');
}

describe('真的組裝：排著的第二句撞上第一輪的核准點', () => {
  it('核准：第二句停住，核准後 danger 真的跑、第一輪收尾，第二句才開一輪', async () => {
    const run = await assemble();
    try {
      const { second } = await run.stopWithQueued();

      // 停住：核准卡照常出現，第二句沒有開跑，但算「還在飛」。
      expect(run.pump.awaitingInput).toBe(true);
      expect(run.pump.running).toBe(true);
      expect(run.marks()).toEqual(['start:message:第一句', 'end']);
      expect(run.model.prompts).toHaveLength(2);
      expect(run.probe.danger).toBe(0);

      const [pending] = run.pump.pendings;
      await run.pump.submit({
        kind: 'resume',
        interruptId: pending!.interruptId,
        response: { decisions: [{ type: 'approve' }] },
      });
      await second;
      await run.pump.whenIdle();

      expect(run.probe.danger).toBe(1);
      expect(run.marks()).toEqual([
        'start:message:第一句',
        'end',
        'start:resume',
        'end',
        'start:message:第二句',
        'end',
      ]);
      // 第二句那一輪（第 4 次模型呼叫）讀到的是 danger 的真結果，不是基座補的那句。
      const seen = promptText(run.model, 3);
      expect(seen).toContain('第二句');
      expect(seen).toContain(DANGER_DONE);
      expect(seen).not.toContain(ANOTHER_MESSAGE);
      expect(run.pump.awaitingInput).toBe(false);
      expect(run.pump.running).toBe(false);
    } finally {
      await run.close();
    }
  }, 20000);

  it('拒絕：第二句在那一輪收掉之後才跑，danger 沒跑', async () => {
    const run = await assemble();
    try {
      const { second } = await run.stopWithQueued();
      const [pending] = run.pump.pendings;
      await run.pump.submit({
        kind: 'resume',
        interruptId: pending!.interruptId,
        response: { decisions: [{ type: 'reject' }] },
      });
      await second;
      await run.pump.whenIdle();

      expect(run.probe.danger).toBe(0);
      expect(run.marks()).toEqual([
        'start:message:第一句',
        'end',
        'start:resume',
        'end',
        'start:message:第二句',
        'end',
      ]);
      const seen = promptText(run.model, 3);
      expect(seen).toContain('第二句');
      expect(seen).not.toContain(ANOTHER_MESSAGE);
      expect(run.pump.awaitingInput).toBe(false);
    } finally {
      await run.close();
    }
  }, 20000);

  it('收回（按停止）：第二句在收回那一輪收掉之後才跑，模型讀到的是收回的原句', async () => {
    const run = await assemble([
      SCRIPT[0]!,
      SCRIPT[1]!,
      { content: '第二句的回覆。' },
      { content: '備用。' },
    ]);
    try {
      const { second } = await run.stopWithQueued();
      expect(run.pump.cancel()).toBe('withdrawn');
      await second;
      await run.pump.whenIdle();

      expect(run.probe.danger).toBe(0);
      expect(run.marks()).toEqual([
        'start:message:第一句',
        'end',
        'start:resume',
        'end',
        'start:message:第二句',
        'end',
      ]);
      const seen = promptText(run.model, 2);
      expect(seen).toContain('第二句');
      expect(seen).toContain(TOOL_ABORTED_BEFORE_DISPATCH_TEXT);
      expect(seen).not.toContain(ANOTHER_MESSAGE);
      expect(run.pump.awaitingInput).toBe(false);
    } finally {
      await run.close();
    }
  }, 20000);

  it('同一輪兩顆中斷只答一顆：第二句仍然停住，兩顆都答完才跑', async () => {
    const run = await assemble([
      SCRIPT[0]!,
      {
        content: '兩個危險的。',
        toolCalls: [
          { name: 'danger', args: {} },
          { name: 'danger_two', args: {} },
        ],
      },
      { content: '第一輪收尾。' },
      { content: '第二句的回覆。' },
      { content: '備用。' },
    ]);
    try {
      const { second } = await run.stopWithQueued();
      expect(run.pump.pendings).toHaveLength(2);
      const [one, two] = run.pump.pendings;

      await run.pump.submit({
        kind: 'resume',
        interruptId: one!.interruptId,
        response: { decisions: [{ type: 'approve' }] },
      });
      await run.pump.whenIdle();
      expect(run.pump.awaitingInput).toBe(true);
      expect(run.pump.running).toBe(true);
      expect(run.marks().filter((mark) => mark === 'start:message:第二句')).toEqual([]);

      await run.pump.submit({
        kind: 'resume',
        interruptId: two!.interruptId,
        response: { decisions: [{ type: 'approve' }] },
      });
      await second;
      await run.pump.whenIdle();
      expect(run.probe.danger).toBe(2);
      expect(run.marks().slice(-2)).toEqual(['start:message:第二句', 'end']);
      expect(run.pump.awaitingInput).toBe(false);
    } finally {
      await run.close();
    }
  }, 20000);

  it('停住時收線：排著的那句有結果、不再算在飛，也不會變成沒人接的 rejection', async () => {
    const run = await assemble();
    try {
      const { second } = await run.stopWithQueued();
      run.pump.close();
      await expect(second).rejects.toThrow('這條 thread 已經收掉了');
      expect(run.pump.running).toBe(false);
      await run.pump.whenIdle();
      expect(run.marks()).toEqual(['start:message:第一句', 'end']);
    } finally {
      await run.close();
    }
  }, 20000);
});

/** 假的 agent 吐得出來的原始封包。 */
function interruptFrame(id: string) {
  return {
    type: 'event',
    seq: 0,
    method: 'updates',
    params: {
      namespace: [],
      timestamp: 0,
      node: '__interrupt__',
      data: { values: [{ id, value: { actionRequests: [{ name: 'danger', args: {} }] } }] },
    },
  };
}

const COMPLETED = {
  type: 'event',
  seq: 0,
  method: 'lifecycle',
  params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
};

/** 一道由測試打開的門。 */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/**
 * 照腳本跑的假 agent：第幾次 `streamEvents` 吐什麼、要不要等一道門才收尾，都由測試排。
 * 沒排到的那幾次直接收尾。
 */
function scriptedAgent(
  steps: readonly { readonly interrupt?: string; readonly hold?: Promise<void> }[],
) {
  let call = 0;
  const agent = {
    streamEvents: async () => {
      const step = steps[call] ?? {};
      call += 1;
      return (async function* () {
        if (step.interrupt !== undefined) yield interruptFrame(step.interrupt);
        if (step.hold !== undefined) await step.hold;
        yield COMPLETED;
      })();
    },
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  };
  return agent as unknown as PumpAgent;
}

const approve = (interruptId: string): PumpInput => ({
  kind: 'resume',
  interruptId,
  response: { decisions: [{ type: 'approve' }] },
});

describe('送達的先後：假的 agent 排', () => {
  it('第一輪還在收尾時就答了：答覆排在第二句後面，照樣先跑', async () => {
    const tail = gate();
    const pump = new ThreadPump(scriptedAgent([{ interrupt: 'i1', hold: tail.opened }]), 'race');
    try {
      const first = pump.submit({ kind: 'message', text: '第一句' });
      const second = pump.submit({ kind: 'message', text: '第二句' });
      await until(() => pump.awaitingInput);
      // 第一輪還沒收尾，答覆就到了——它排在第二句後面。
      const answer = pump.submit(approve('i1'));
      tail.open();
      await Promise.all([first, second, answer]);
      await pump.whenIdle();
      expect(turnMarks(pump.sessionLog.events)).toEqual([
        'start:message:第一句',
        'end',
        'start:resume',
        'end',
        'start:message:第二句',
        'end',
      ]);
    } finally {
      pump.close();
    }
  });

  it('停住的照 FIFO：答覆那一輪跑著時又送的一句，排在停住的那幾句後面', async () => {
    const resumeHold = gate();
    const pump = new ThreadPump(
      scriptedAgent([{ interrupt: 'i1' }, { hold: resumeHold.opened }]),
      'fifo',
    );
    try {
      await pump.submit({ kind: 'message', text: 'A' });
      // 停在核准點時，上行擋著 `run.start`；B、C 是跑著時就收下的那種，這裡直接排。
      const parked = [
        pump.submit({ kind: 'message', text: 'B' }),
        pump.submit({ kind: 'message', text: 'C' }),
      ];
      await until(() => pump.running);
      expect(turnMarks(pump.sessionLog.events)).toEqual(['start:message:A', 'end']);

      const answer = pump.submit(approve('i1'));
      await until(() => turnMarks(pump.sessionLog.events).includes('start:resume'));
      // 答覆那一輪跑著：已經沒有掛著的中斷，上行收得下這一句。
      expect(pump.awaitingInput).toBe(false);
      const late = pump.submit({ kind: 'message', text: 'D' });
      resumeHold.open();
      await Promise.all([answer, late, ...parked]);
      await pump.whenIdle();
      expect(turnMarks(pump.sessionLog.events).filter((mark) => mark.startsWith('start:'))).toEqual(
        [
          'start:message:A',
          'start:resume',
          'start:message:B',
          'start:message:C',
          'start:message:D',
        ],
      );
    } finally {
      pump.close();
    }
  });
});

describe('wire：跑著時收下的一句，等 input.respond 那一輪收掉才跑', () => {
  const opened: WireHandler[] = [];
  afterEach(async () => {
    for (const handler of opened.splice(0)) await handler.close();
  });

  it('第二句的 turn/start 排在 resume 那一輪的 turn/end 之後', async () => {
    const probe: Probe = { slowStarted: 0, danger: 0 };
    const model = new ScriptedChatModel({ turns: SCRIPT });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [toolsPlugin(probe)],
    });
    let log: SessionLog | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        commands: emptyCommandPoint(),
        dispose: built.dispose,
        attachSession: (sessions) => {
          log = sessions.root;
          return built.attachSession(sessions);
        },
      }),
    });
    opened.push(handler);
    const client = createWireClient({
      baseUrl: 'http://queued.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    const thread = 'queued-wire';
    const line = new AbortController();
    const frames: Event[] = [];
    const events = await client.openEvents(thread, {
      channels: ['lifecycle', 'input'],
      signal: line.signal,
    });
    const draining = (async () => {
      try {
        for await (const frame of events) frames.push(frame);
      } catch {
        // 收線時中止。
      }
    })();
    try {
      await client.runStart(thread, '第一句');
      await until(() => probe.slowStarted === 1);
      // 跑著：收件照收。
      await client.runStart(thread, '第二句');
      await until(() => frames.some((frame) => frame.method === 'input.requested'));
      const requested = frames.find((frame) => frame.method === 'input.requested');
      const interruptId = (requested!.params.data as { interrupt_id: string }).interrupt_id;
      await until(() => turnMarks(log!.events).length === 2);
      expect(turnMarks(log!.events)).toEqual(['start:message:第一句', 'end']);

      await client.inputRespond(thread, {
        namespace: [],
        interrupt_id: interruptId,
        response: { decisions: [{ type: 'approve' }] },
      });
      await until(() => turnMarks(log!.events).length === 6);
      expect(turnMarks(log!.events)).toEqual([
        'start:message:第一句',
        'end',
        'start:resume',
        'end',
        'start:message:第二句',
        'end',
      ]);
      expect(probe.danger).toBe(1);
    } finally {
      line.abort();
      await draining;
    }
  }, 20000);
});
