/**
 * **web 的工具卡從會話日誌開**——[#297](https://github.com/DemianLi/nexus-agent/issues/297) 的驗收。
 *
 * 基座只在**工具本體被呼叫到**時發 `tools` frame。本體沒被呼叫到的那幾類——`handler` 之前就被擋的、
 * 基座找不到的工具、停在核准點按了停止——修之前 web 上連卡都沒有，日誌上卻有一對 `tool/call`／
 * `tool/result`。現在 pump 照 dsh：`tool/call` 開卡、`tool/result` 收卡。
 *
 * 兩層，同 `tool-status-wire.test.ts`：
 *
 * - **產品路徑**：真的組裝、真的 pump、真的折疊器，每一類一條。每條都斷言**基座一顆 frame 都沒發**
 *   ——少了這一句，本體其實有被呼叫到的呼叫也會讓它綠，量的就不是這一類。子代理那兩條另外量歸屬：
 *   合成的卡掛在 `SessionAddress.runId` 上，折疊器拿 `task` 那顆基座 frame 的 `namespace[0]` 查，
 *   兩者相等是這裡量的，不是推的。
 * - **送達的先後**：判定比基座那顆 `tool-started` 先到 pump 時，pump 分不出「本體沒被呼叫到」與「它那顆
 *   還在路上」，當場收卡；假的 agent 把後者排出來，證終態一樣。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { TOOL_ABORTED_BEFORE_DISPATCH_TEXT, TOOL_ABORTED_TEXT, toLoggedMessage } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import { createPlanModePlugin, NOT_IN_PLAN_MODE_MESSAGE } from '@nexus/plugin-plan-mode';
import type { ConversationState, Event } from '@nexus/wire';
import { emptyConversation, reduceConversation, UNFINISHED_TOOL_TEXT } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type ToolEntry = Extract<ConversationState['entries'][number], { kind: 'tool' }>;

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

const isStoppedFrame = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { aborted?: unknown }).aborted === true;

function toolEntries(frames: readonly Event[]): ToolEntry[] {
  const state = frames.reduce(reduceConversation, emptyConversation());
  return state.entries.filter((entry): entry is ToolEntry => entry.kind === 'tool');
}

/**
 * 基座發的 `tools` frame。pump 合成的那幾顆 namespace 是 `[]`（root）或 `[runId, 'tools']`（子代理）；
 * 基座的最後一段是那次呼叫自己的 task id（`tools:<uuid>`，實測）。
 */
function baseToolFrames(frames: readonly Event[], callName?: string): Event[] {
  return frames.filter(
    (frame) =>
      frame.method === 'tools' &&
      frame.params.namespace.length > 0 &&
      frame.params.namespace.at(-1) !== 'tools' &&
      (callName === undefined ||
        (frame.params.data as { tool_name?: unknown }).tool_name === callName),
  );
}

const DANGER: NexusPlugin = {
  name: 'danger',
  apply(registry) {
    registry.tools.register(
      tool(() => '危險的事做完了', {
        name: 'danger',
        description: '要核准。',
        schema: z.object({}),
      }),
    );
    registry.approvals.gate((exec, next) =>
      exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
    );
  },
};

const WORKER: NexusPlugin = {
  name: 'worker-host',
  apply(registry) {
    registry.subagents.register({ name: 'worker', description: '幹活的。' });
  },
};

const DELEGATE: ScriptedTurn = {
  content: '委派。',
  toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
};

describe('產品路徑：本體沒被呼叫到的呼叫，web 上有一張卡', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-tool-card-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 真的組裝接上一個 pump 與一條下行——serve 那條路的形狀，同 `tool-status-wire.test.ts`。 */
  async function assemble(turns: readonly ScriptedTurn[], plugins: readonly NexusPlugin[] = []) {
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns }),
      checkpointer: new MemorySaver(),
      plugins: [...plugins],
      backend: new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' }),
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'tool-card');
    const detach = built.attachSession(pump.sessions);
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    return {
      pump,
      frames,
      /** 送一句話，等到這一輪收尾那顆進了下行。 */
      async say(text: string): Promise<void> {
        const done = frames.filter(isRootDone).length;
        await pump.submit({ kind: 'message', text });
        await until(() => frames.filter(isRootDone).length > done);
      },
      close: async () => {
        line.abort();
        await draining;
        detach();
        await built.dispose();
      },
    };
  }

  it('基座找不到的工具：失敗、紅字是模型看到的那一句', async () => {
    const run = await assemble([
      { content: '', toolCalls: [{ name: 'ghost', args: {} }] },
      { content: '收工。' },
    ]);
    try {
      await run.say('叫一個不存在的');
      expect(baseToolFrames(run.frames)).toEqual([]);
      const [card] = toolEntries(run.frames);
      expect(card).toMatchObject({
        name: 'ghost',
        status: 'failed',
        attribution: { kind: 'root' },
      });
      expect(card?.error).toMatch(/ghost/);
    } finally {
      await run.close();
    }
  }, 20000);

  it('先讀後改：沒讀過就 `edit_file`，失敗、紅字是要求先讀的那一句', async () => {
    await writeFile(join(root, 'a.txt'), '一');
    const run = await assemble([
      {
        content: '',
        toolCalls: [
          { name: 'edit_file', args: { file_path: '/a.txt', old_string: '一', new_string: '二' } },
        ],
      },
      { content: '收工。' },
    ]);
    try {
      await run.say('改檔');
      expect(baseToolFrames(run.frames)).toEqual([]);
      const [card] = toolEntries(run.frames);
      expect(card).toMatchObject({ name: 'edit_file', status: 'failed' });
      expect(card?.error).toMatch(/得先讀過它/);
    } finally {
      await run.close();
    }
  }, 20000);

  it('plan-mode：模式外叫 `exit_plan_mode`，失敗、紅字是 plugin 那一句', async () => {
    const run = await assemble(
      [
        { content: '', toolCalls: [{ name: 'exit_plan_mode', args: { plan: '計劃' } }] },
        { content: '收工。' },
      ],
      [createPlanModePlugin()],
    );
    try {
      await run.say('交計劃');
      expect(baseToolFrames(run.frames)).toEqual([]);
      expect(toolEntries(run.frames)).toMatchObject([
        { name: 'exit_plan_mode', status: 'failed', error: NOT_IN_PLAN_MODE_MESSAGE },
      ]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('停在核准點按停止：等核准時卡在執行中，收回之後失敗、紅字是 before dispatch 那一句', async () => {
    const run = await assemble(
      [{ content: '動手。', toolCalls: [{ name: 'danger', args: {} }] }, { content: '換個話題。' }],
      [DANGER],
    );
    try {
      await run.say('做危險的事');
      expect(run.pump.awaitingInput).toBe(true);
      expect(toolEntries(run.frames).map((card) => [card.name, card.status])).toEqual([
        ['danger', 'running'],
      ]);

      expect(run.pump.cancel()).toBe('withdrawn');
      await run.pump.whenIdle();
      await until(() => run.frames.some(isStoppedFrame));
      expect(baseToolFrames(run.frames)).toEqual([]);
      // 是 pump 照它寫的 `tool/result` 收的，不是折疊器在停止時兜底收的——紅字分得出來。
      expect(toolEntries(run.frames)).toMatchObject([
        { name: 'danger', status: 'failed', error: TOOL_ABORTED_BEFORE_DISPATCH_TEXT },
      ]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('子代理裡基座找不到的工具：卡掛在那個子代理底下', async () => {
    const run = await assemble(
      [
        DELEGATE,
        { content: '', toolCalls: [{ name: 'ghost', args: {} }] },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '根再收一次。' },
      ],
      [WORKER],
    );
    try {
      await run.say('交給子代理');
      // 前提：真的有一個子代理，而且那顆 `ghost` 記在它的日誌上。
      const subagents = run.pump.sessions
        .list()
        .filter((session) => session.address.kind === 'subagent');
      expect(subagents).toHaveLength(1);
      expect(subagents[0]?.log.events.map((event) => event.type)).toContain('tool/call');
      expect(baseToolFrames(run.frames, 'ghost')).toEqual([]);

      const ghost = toolEntries(run.frames).find((card) => card.name === 'ghost');
      expect(ghost).toMatchObject({
        status: 'failed',
        // **這一句量的是 `runId` ＝ 基座給 `task` 的 `namespace[0]`**：不相等的話折疊器查不到，
        // 會是 `unattributed`；namespace 只有一段的話會是 `root`。
        attribution: { kind: 'subagent', name: 'worker' },
      });
    } finally {
      await run.close();
    }
  }, 20000);

  it('子代理停在核准點按停止：root 的 `task` 照 pump 寫的結果收，子代理那張由停止收', async () => {
    const run = await assemble(
      [DELEGATE, { content: '子代理動手。', toolCalls: [{ name: 'danger', args: {} }] }],
      [DANGER, WORKER],
    );
    try {
      await run.say('派出去');
      expect(run.pump.awaitingInput).toBe(true);
      expect(toolEntries(run.frames).find((card) => card.name === 'danger')).toMatchObject({
        status: 'running',
        attribution: { kind: 'subagent', name: 'worker' },
      });

      run.pump.cancel();
      await run.pump.whenIdle();
      await until(() => run.frames.some(isStoppedFrame));
      const cards = toolEntries(run.frames);
      // `task` 早就開始了，所以是 ABORTED（`#withdraw` 的選碼）。
      expect(cards.find((card) => card.name === 'task')).toMatchObject({
        status: 'failed',
        error: TOOL_ABORTED_TEXT,
      });
      // 子代理那顆日誌上沒有結果（pump 只替 root 懸著的寫），照 dsh 由這一輪關閉時收。
      expect(cards.find((card) => card.name === 'danger')).toMatchObject({
        status: 'failed',
        error: UNFINISHED_TOOL_TEXT,
      });
    } finally {
      await run.close();
    }
  }, 20000);
});

describe('送達的先後：判定比基座那顆 `tool-started` 先到', () => {
  const OUTPUT = { status: 'success', content: '本體說好了' };

  function frame(method: string, namespace: string[], data: unknown) {
    return { type: 'event' as const, seq: 0, method, params: { namespace, timestamp: 0, data } };
  }

  /** 假的 agent：先往 root 那份日誌寫一對 `tool/call`／`tool/result`，基座的 frame 要不要跟、何時跟由參數排。 */
  async function play(base: 'none' | 'late') {
    const record = () => {
      const log = pump.sessionLog;
      log.append('tool/call', { callId: 'c1', name: 'write_file', arguments: '{"a":1}' });
      log.append('tool/result', {
        callId: 'c1',
        isError: true,
        error: { name: 'FsError', code: 'FS_SANDBOX_DENIED' },
        message: toLoggedMessage(
          new ToolMessage({
            content: '被擋下',
            tool_call_id: 'c1',
            name: 'write_file',
            status: 'error',
          }),
        ),
      });
    };
    async function* stream() {
      record();
      if (base === 'late') {
        yield frame('tools', ['tools:x'], {
          event: 'tool-started',
          tool_call_id: 'c1',
          tool_name: 'write_file',
          input: '{"a":1}',
        });
        yield frame('tools', ['tools:x'], {
          event: 'tool-finished',
          tool_call_id: 'c1',
          output: OUTPUT,
        });
      }
      yield frame('lifecycle', [], { event: 'completed', graph_name: 'root' });
    }
    const agent = {
      streamEvents: async () => stream(),
      getState: async () => ({ values: {} }),
      updateState: async () => ({}),
    };
    const pump = new ThreadPump(agent as unknown as PumpAgent, 'order');
    const frames: Event[] = [];
    const line = new AbortController();
    const draining = (async () => {
      for await (const next of pump.subscribe(['tools', 'lifecycle'], line.signal))
        frames.push(next);
    })();
    await pump.submit({ kind: 'message', text: '寫' });
    await until(() => frames.some(isRootDone));
    line.abort();
    await draining;
    return frames;
  }

  it('基座一顆都沒發：日誌開、日誌收，一開一收', async () => {
    const frames = await play('none');
    expect(
      frames
        .filter((next) => next.method === 'tools')
        .map((next) => (next.params.data as { event: string }).event),
    ).toEqual(['tool-started', 'tool-finished']);
    expect(toolEntries(frames)).toMatchObject([
      { name: 'write_file', input: '{"a":1}', status: 'failed', error: '被擋下' },
    ]);
  });

  it('基座那顆晚到：當場收過的卡被翻回執行中，緊接著的 `tool-finished` 套上同一個判定，終態一樣', async () => {
    const frames = await play('late');
    expect(toolEntries(frames)).toMatchObject([
      { name: 'write_file', status: 'failed', error: '被擋下', output: OUTPUT },
    ]);
  });
});
