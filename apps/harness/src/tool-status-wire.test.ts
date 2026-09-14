/**
 * **web 的工具卡，終態以會話日誌為準**——[#296](https://github.com/DemianLi/nexus-agent/issues/296)
 * 的驗收。
 *
 * 基座在工具本體裡就發了 `tool-finished`，之後還有 middleware 把成功換成錯誤。修之前 web 只看那顆
 * frame，所以 fence 擋下的寫入畫成「完成」（2026-09-13 live 實跑量到）。現在 pump 訂閱會話註冊表，
 * 以圍堵寫的 `tool/result` 為準，紅字是模型看到的那一句。
 *
 * 兩層：
 *
 * - **產品路徑**：真的組裝、真的 pump、真的折疊器（`@nexus/wire` 的 `reduceConversation`），在
 *   `handler` 之後改結果的四個生產者各一條，外加成功的對照與子代理裡的一顆。這一層量得到「真的會對」，
 *   **量不到先後**——日誌判定與那顆 frame 誰先到 pump 是自然發生的那一種。
 * - **送達的兩種先後**：假的 agent 自己排，判定在 frame 之前、之後各一次。只有這一層分得出兩條分支。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { TOOL_ABORTED_TEXT, toLoggedMessage } from '@nexus/core';
import type { NexusPlugin, SandboxMode } from '@nexus/core';
import type { ConversationState, Event } from '@nexus/wire';
import { emptyConversation, reduceConversation } from '@nexus/wire';
import { createMiddleware } from 'langchain';
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

/** root 那顆收尾的 `lifecycle`：這一輪的 frame 都已經進了下行。 */
const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

/** 一條下行上，某一顆呼叫收到幾顆 `tool-finished`：1 是判定先到、2 是補發了更正。 */
function finishesOf(frames: readonly Event[], callId: string): number {
  return frames.filter((frame) => {
    const data = frame.params.data as { event?: unknown; tool_call_id?: unknown };
    return (
      frame.method === 'tools' && data.event === 'tool-finished' && data.tool_call_id === callId
    );
  }).length;
}

function toolEntries(frames: readonly Event[]): ToolEntry[] {
  const state = frames.reduce(reduceConversation, emptyConversation());
  return state.entries.filter((entry): entry is ToolEntry => entry.kind === 'tool');
}

describe('產品路徑：handler 之後被改成錯誤的結果，web 畫成失敗', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-tool-status-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 真的組裝接上一個 pump 與一條下行——serve 那條路的形狀，同 `turn-cancel.test.ts`。 */
  async function assemble(
    turns: readonly ScriptedTurn[],
    options: { plugins?: readonly NexusPlugin[]; mode?: SandboxMode } = {},
  ) {
    const built = await createNexusAgent({
      model: new ScriptedChatModel({ turns }),
      checkpointer: new MemorySaver(),
      plugins: [...(options.plugins ?? [])],
      ...(options.mode === undefined
        ? {}
        : { backend: new ContainedFilesystemBackend({ rootDir: root, mode: options.mode }) }),
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'tool-status');
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

  it('read-only 下 fence 擋下的 `write_file`：失敗、紅字是拒絕原文、輸出沒被清掉', async () => {
    const run = await assemble(
      [
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/a.txt', content: '一' } }],
        },
        { content: '收工。' },
      ],
      { mode: 'read-only' },
    );
    try {
      await run.say('寫檔');
      const [entry] = toolEntries(run.frames);
      expect(entry).toMatchObject({ name: 'write_file', status: 'failed' });
      expect(entry?.error).toMatch(/^\[containment\] .*這個 backend 是唯讀的/);
      expect(entry?.output).toBeDefined();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await run.close();
    }
  }, 20000);

  it('對照：workspace-write 下同一顆寫得進去，照舊是完成', async () => {
    const run = await assemble(
      [
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/a.txt', content: '一' } }],
        },
        { content: '收工。' },
      ],
      { mode: 'workspace-write' },
    );
    try {
      await run.say('寫檔');
      const [entry] = toolEntries(run.frames);
      expect(entry).toMatchObject({ name: 'write_file', status: 'done' });
      expect(entry?.error).toBeUndefined();
      expect(await readdir(root)).toEqual(['a.txt']);
    } finally {
      await run.close();
    }
  }, 20000);

  it('輸出不合宣告的 schema：失敗、紅字是校驗器那一句', async () => {
    const shaped: NexusPlugin = {
      name: 'shaped',
      apply(registry) {
        registry.tools.register(
          tool(() => JSON.stringify({ count: '三' }), {
            name: 'counter',
            description: '數東西。',
            schema: z.object({}),
          }),
          { outputSchema: z.object({ count: z.number() }) },
        );
      },
    };
    const run = await assemble(
      [{ content: '', toolCalls: [{ name: 'counter', args: {} }] }, { content: '收工。' }],
      { plugins: [shaped] },
    );
    try {
      await run.say('數');
      const [entry] = toolEntries(run.frames);
      expect(entry).toMatchObject({ name: 'counter', status: 'failed' });
      expect(entry?.error).toMatch(/^工具 counter 的輸出不合它宣告的 schema：/);
    } finally {
      await run.close();
    }
  }, 20000);

  it('工具跑到一半按停止、本體成功落定：失敗、紅字是 ABORTED 那一句', async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: NexusPlugin = {
      name: 'slow',
      apply(registry) {
        registry.tools.register(
          tool(
            async () => {
              started += 1;
              await gate;
              return '寫好了';
            },
            { name: 'slow_write', description: '慢慢寫。', schema: z.object({}) },
          ),
        );
      },
    };
    const run = await assemble(
      [
        { content: '', toolCalls: [{ name: 'slow_write', args: {} }] },
        { content: '不該走到這裡。' },
      ],
      { plugins: [slow] },
    );
    try {
      const turn = run.pump.submit({ kind: 'message', text: '寫' });
      await until(() => started === 1);
      expect(run.pump.cancel()).toBe('run');
      release();
      await turn;
      await until(() => run.frames.some(isRootDone));
      const [entry] = toolEntries(run.frames);
      expect(entry).toMatchObject({
        name: 'slow_write',
        status: 'failed',
        error: TOOL_ABORTED_TEXT,
      });
    } finally {
      release();
      await run.close();
    }
  }, 20000);

  it('本體成功、內層 middleware 在它之後拋錯：失敗、紅字是圍堵那一句', async () => {
    const fragile: NexusPlugin = {
      name: 'fragile',
      apply(registry) {
        registry.tools.register(
          tool(() => '做完了', {
            name: 'fragile',
            description: '會被後面炸掉。',
            schema: z.object({}),
          }),
        );
        registry.middleware.use(
          createMiddleware({
            name: 'blowsUpAfter',
            wrapToolCall: async (request, handler) => {
              const result = await handler(request);
              if (request.toolCall.name === 'fragile') throw new Error('之後炸了');
              return result;
            },
          }) as never,
        );
      },
    };
    const run = await assemble(
      [{ content: '', toolCalls: [{ name: 'fragile', args: {} }] }, { content: '收工。' }],
      { plugins: [fragile] },
    );
    try {
      await run.say('做');
      const [entry] = toolEntries(run.frames);
      expect(entry).toMatchObject({
        name: 'fragile',
        status: 'failed',
        error: '工具 fragile 執行失敗：之後炸了',
      });
    } finally {
      await run.close();
    }
  }, 20000);

  it('子代理裡被 fence 擋下的 `write_file` 也畫成失敗——子代理的日誌也在訂閱範圍裡', async () => {
    const worker: NexusPlugin = {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({ name: 'worker', description: '幹活的。' });
      },
    };
    const run = await assemble(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '寫檔', subagent_type: 'worker' } }],
        },
        {
          content: '',
          toolCalls: [{ name: 'write_file', args: { file_path: '/a.txt', content: '一' } }],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '根再收一次。' },
      ],
      { plugins: [worker], mode: 'read-only' },
    );
    try {
      await run.say('交給子代理');
      const write = toolEntries(run.frames).find((entry) => entry.name === 'write_file');
      expect(write).toMatchObject({ status: 'failed' });
      expect(write?.error).toMatch(/^\[containment\] .*這個 backend 是唯讀的/);
      // 它真的在子代理那一層：前提沒發生的話，這條會在 root 那顆上假綠。
      expect(write?.attribution).not.toBeUndefined();
      expect(
        run.pump.sessions.list().filter((session) => session.address.kind === 'subagent'),
      ).toHaveLength(1);
    } finally {
      await run.close();
    }
  }, 20000);
});

describe('送達的兩種先後：判定比 frame 先到、比 frame 晚到，結果一樣', () => {
  const NAMESPACE = ['tools:worker-1'];
  const OUTPUT = { status: 'success', content: '本體說寫好了' };

  function frame(method: string, namespace: string[], data: unknown) {
    return { type: 'event' as const, seq: 0, method, params: { namespace, timestamp: 0, data } };
  }

  /**
   * 一顆工具的 frame，中間在指定的時刻往 root 那份日誌寫判定。
   *
   * **先後由產生器決定，不靠運氣**：pump 用 `for await` 抽，產生器在 `yield` 之後的那一行，要等 pump
   * 把前一顆翻譯、廣播完、再要下一顆時才跑。
   */
  async function play(
    order: 'verdict-first' | 'frame-first' | 'no-verdict',
    verdict: { isError: boolean },
    beforeRun?: (pump: ThreadPump) => void,
  ) {
    // `pump` 在下面才建；這個函式要等產生器跑起來才被叫，那時已經有了。
    const settle = () => {
      pump.sessionLog.append('tool/result', {
        callId: 'c1',
        isError: verdict.isError,
        ...(verdict.isError ? { error: { name: 'FsError', code: 'FS_SANDBOX_DENIED' } } : {}),
        message: toLoggedMessage(
          new ToolMessage({
            content: verdict.isError ? '被 fence 擋下' : '寫好了',
            tool_call_id: 'c1',
            name: 'write_file',
            ...(verdict.isError ? { status: 'error' as const } : {}),
          }),
        ),
      });
    };
    async function* stream() {
      yield frame('tools', NAMESPACE, {
        event: 'tool-started',
        tool_call_id: 'c1',
        tool_name: 'write_file',
        input: '{}',
      });
      if (order === 'verdict-first') settle();
      yield frame('tools', NAMESPACE, {
        event: 'tool-finished',
        tool_call_id: 'c1',
        output: OUTPUT,
      });
      if (order === 'frame-first') settle();
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
    beforeRun?.(pump);
    await pump.submit({ kind: 'message', text: '寫' });
    await until(() => frames.some(isRootDone));
    line.abort();
    await draining;
    return frames;
  }

  it('判定先到：套在那顆 `tool-finished` 上，只有一顆', async () => {
    const frames = await play('verdict-first', { isError: true });
    expect(finishesOf(frames, 'c1')).toBe(1);
    expect(toolEntries(frames)).toMatchObject([
      { status: 'failed', error: '被 fence 擋下', output: OUTPUT },
    ]);
  });

  it('判定後到：補發一顆同 id、同 namespace、帶原輸出的更正', async () => {
    const frames = await play('frame-first', { isError: true });
    expect(finishesOf(frames, 'c1')).toBe(2);
    const correction = frames.filter((next) => next.method === 'tools').at(-1);
    expect(correction?.params.namespace).toEqual(NAMESPACE);
    expect(toolEntries(frames)).toMatchObject([
      { status: 'failed', error: '被 fence 擋下', output: OUTPUT },
    ]);
  });

  it('對照：判定是成功的話，兩種先後都不多發、照舊是完成', async () => {
    for (const order of ['verdict-first', 'frame-first'] as const) {
      const frames = await play(order, { isError: false });
      expect(finishesOf(frames, 'c1')).toBe(1);
      expect(toolEntries(frames)).toMatchObject([{ status: 'done', output: OUTPUT }]);
      expect(toolEntries(frames)[0]?.error).toBeUndefined();
    }
  });

  /**
   * pump 自己也寫 `tool/result`（停在核准點時收回，#276），那時沒有 run。那一顆不能被當成下一輪的
   * 判定——同一個 callId 在下一輪再來的話，會把一顆成功的卡畫成失敗。
   */
  it('沒有 run 在跑時日誌上的 `tool/result` 不算數：下一輪同 id 的那顆照本體畫', async () => {
    const frames = await play('no-verdict', { isError: false }, (pump) => {
      pump.sessionLog.append('tool/result', { callId: 'c1', isError: true });
    });
    expect(finishesOf(frames, 'c1')).toBe(1);
    expect(toolEntries(frames)).toMatchObject([{ status: 'done', output: OUTPUT }]);
  });
});
