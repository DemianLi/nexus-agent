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
import { TOOL_ABORTED_BEFORE_DISPATCH_TEXT, toLoggedMessage } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { createPlanModePlugin, NOT_IN_PLAN_MODE_MESSAGE } from '@nexus/plugin-plan-mode';
import type { ConversationState, Event } from '@nexus/wire';
import { emptyConversation, reduceConversation } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { historyFrames } from './conversation-history.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';

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

const DANGER: PluginEntry = {
  plugin: {
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
  },
};

const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
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
  async function assemble(turns: readonly ScriptedTurn[], plugins: readonly PluginEntry[] = []) {
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
        { name: 'exit_plan_mode', status: 'failed', error: `Error: ${NOT_IN_PLAN_MODE_MESSAGE}` },
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

  /**
   * **[#324](https://github.com/DemianLi/nexus-agent/issues/324) 翻了面。** 以前子代理停在核准點、按停止收卡；照 dsh，
   * 子代理的核准政策在委派時釘成 `never`，它不停下來。`danger` 的本體沒被呼叫到，卡從子代理日誌的 `tool/call` 開、
   * 由它的 `tool/result` 收成失敗，紅字是 `policy-never` 那句；root 的 `task` 照常完成。
   */
  it('子代理叫到要核准的工具：不停下來，卡掛在子代理底下、失敗、紅字是「沒有人被問到」', async () => {
    const run = await assemble(
      [
        DELEGATE,
        { content: '子代理動手。', toolCalls: [{ name: 'danger', args: {} }] },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
      [DANGER, WORKER],
    );
    try {
      await run.say('派出去');
      expect(run.pump.awaitingInput).toBe(false);
      expect(baseToolFrames(run.frames, 'danger')).toEqual([]);
      const cards = toolEntries(run.frames);
      const danger = cards.find((card) => card.name === 'danger');
      expect(danger).toMatchObject({
        status: 'failed',
        attribution: { kind: 'subagent', name: 'worker' },
      });
      expect(danger?.error).toMatch(/沒有人被問到/);
      expect(cards.find((card) => card.name === 'task')).toMatchObject({ status: 'done' });
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
      { name: 'write_file', status: 'failed', error: '被擋下', text: '被擋下' },
    ]);
  });
});

/**
 * 結果文字：成功那一側也交出來，而且**即時與重播是同一串**
 * （[#439](https://github.com/DemianLi/nexus-agent/issues/439)）。
 *
 * 抽字的規則兩條路共用（`tool-result-text.ts`）。各寫一份的話，同一張卡會「即時一個樣、
 * 重新整理另一個樣」——而且兩邊各自的測試都會綠。
 */
describe('結果文字：即時與重播同一串（#439）', () => {
  /** 兩行，才看得出「只取一塊」跟「把每塊接起來」在單行上分不出差別。 */
  const BODY = '回聲：第一行\n回聲：第二行';

  function frame(method: string, namespace: string[], data: unknown) {
    return { type: 'event' as const, seq: 0, method, params: { namespace, timestamp: 0, data } };
  }

  /** 兩塊文字：抽字的規則對它是「不給」，把幾塊接起來的規則對它是「給一串」。 */
  const TWO_BLOCKS = [
    { type: 'text', text: '第一塊' },
    { type: 'text', text: '第二塊' },
  ];

  /** 日誌寫一對成功的 `tool/call`／`tool/result`；基座的 frame 要不要跟由參數排。 */
  async function play(
    base: 'none' | 'late',
    content: unknown = BODY,
    toolText?: { maxBytes: number },
  ) {
    const record = () => {
      const log = pump.sessionLog;
      log.append('tool/call', { callId: 'c1', name: 'echo', arguments: '{"message":"嗨"}' });
      log.append('tool/result', {
        callId: 'c1',
        isError: false,
        message: toLoggedMessage(
          new ToolMessage({ content: content as string, tool_call_id: 'c1', name: 'echo' }),
        ),
      });
    };
    async function* stream() {
      record();
      if (base === 'late') {
        yield frame('tools', ['tools:x'], {
          event: 'tool-started',
          tool_call_id: 'c1',
          tool_name: 'echo',
          input: '{"message":"嗨"}',
        });
        yield frame('tools', ['tools:x'], {
          event: 'tool-finished',
          tool_call_id: 'c1',
          output: { status: 'success', content: '本體說好了' },
        });
      }
      yield frame('lifecycle', [], { event: 'completed', graph_name: 'root' });
    }
    const agent = {
      streamEvents: async () => stream(),
      getState: async () => ({ values: {} }),
      updateState: async () => ({}),
    };
    const pump = new ThreadPump(
      agent as unknown as PumpAgent,
      'text',
      undefined,
      undefined,
      toolText,
    );
    const frames: Event[] = [];
    const line = new AbortController();
    const draining = (async () => {
      for await (const next of pump.subscribe(['tools', 'lifecycle'], line.signal))
        frames.push(next);
    })();
    await pump.submit({ kind: 'message', text: '回聲' });
    await until(() => frames.some(isRootDone));
    line.abort();
    await draining;
    return { frames, events: pump.sessionLog.events };
  }

  it('基座一顆都沒發：pump 合成的那顆收卡也帶文字', async () => {
    const { frames } = await play('none');
    expect(toolEntries(frames)).toMatchObject([{ name: 'echo', status: 'done', text: BODY }]);
    expect(toolEntries(frames)[0]?.error).toBeUndefined();
  });

  it('基座那顆先到：補一顆更正把文字帶上，`output` 一路都不上線', async () => {
    const { frames } = await play('late');
    expect(toolEntries(frames)).toMatchObject([{ status: 'done', text: BODY }]);
    // **序列化的 ToolMessage 不再出現在任何一顆 frame 上**：它是基座搬移過的預覽，
    // 文字改由 `message` 交出來（#439）。
    const payloads = frames
      .filter((next) => next.method === 'tools')
      .map((next) => next.params.data as Record<string, unknown>);
    expect(payloads.some((data) => 'output' in data)).toBe(false);
  });

  it('**重播抽出來的是同一串**：同一份日誌，兩條路的卡上文字相等', async () => {
    const { frames, events } = await play('late');
    const live = toolEntries(frames)[0]?.text;
    const replayed = toolEntries(historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES))[0]?.text;
    expect(live).toBe(BODY);
    expect(replayed).toBe(live);
  });

  /**
   * **上限是設定來的，而且兩條路吃同一份**（[#538](https://github.com/DemianLi/nexus-agent/issues/538)）。
   *
   * 這一條跟上面那條同一個主題的第二半：不只「抽字的規則」要共用，**截字的上限**也要——
   * 兩邊各讀各的設定的話，同一張卡會「即時一個樣、重新整理另一個樣」，而那是這整個 describe
   * 存在的理由。
   *
   * **最後那一行是對照組**：同一份日誌在預設上限底下一個字都不截，所以上面的差別只可能來自
   * 那個參數，不是因為內容本來就長到會被某個寫死的數字截掉。
   */
  it('上限從設定來：即時與重播截在同一個位置', async () => {
    const long = 'x'.repeat(2_000);
    const small = 300;
    const { frames, events } = await play('late', long, { maxBytes: small });

    const live = toolEntries(frames)[0]?.text;
    expect(live).toBeDefined();
    expect(Buffer.byteLength(live!, 'utf8')).toBeLessThanOrEqual(small);
    expect(live).toContain('沒有送出來');

    const replayed = toolEntries(historyFrames(events, small))[0]?.text;
    expect(replayed).toBe(live);

    expect(toolEntries(historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES))[0]?.text).toBe(long);
  });

  /**
   * **這一條才讓「共用同一個抽字函式」承重。** 上面那條的內容是單塊，「只取一塊」與「把幾塊
   * 接起來」對它的答案一樣，所以兩邊各寫一份規則也會綠。多塊的內容兩種規則答案相反：
   * 一邊不給，一邊給一串我們自己拼的字。
   */
  it('多塊的內容：兩條路都不給文字，不是一邊給一邊不給', async () => {
    const { frames, events } = await play('late', TWO_BLOCKS);
    const live = toolEntries(frames)[0];
    const replayed = toolEntries(historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES))[0];
    expect(live).toMatchObject({ status: 'done' });
    expect(live?.text).toBeUndefined();
    expect(replayed?.text).toBeUndefined();
  });
});

/**
 * 給專屬卡的 `meta`：**即時與重播是同一份**（[#617](https://github.com/DemianLi/nexus-agent/issues/617)
 * 驗收 5、6）。
 *
 * 同上一組的理由：截的規則兩條路共用（`tool-result-text.ts` 的 `capToolResultMeta`），各寫一份的話
 * 同一張卡會「即時一個樣、重新整理另一個樣」。
 */
describe('meta：即時與重播同一份（#617）', () => {
  const META = {
    path: '/a.ts',
    offset: 1,
    lines: [{ number: 1, text: 'const a = 1;' }],
    totalLines: 1,
    lang: 'ts',
  };

  /** 兩塊文字：抽字的規則對它不給文字，所以卡上的 `message` 兩邊都沒有、只差 `meta`。 */
  const TWO_BLOCKS = [
    { type: 'text', text: '第一塊' },
    { type: 'text', text: '第二塊' },
  ];

  function frame(method: string, namespace: string[], data: unknown) {
    return { type: 'event' as const, seq: 0, method, params: { namespace, timestamp: 0, data } };
  }

  /**
   * 日誌寫一對 `tool/call`／`tool/result`（帶 `meta`），基座的 frame 何時跟由參數排：
   *
   * - `none`：基座一顆都沒發，pump 自己收卡。
   * - `first`：基座那一對**先**轉發出去，日誌的判定之後才到——走補發更正那條。
   */
  async function play(
    base: 'none' | 'first',
    {
      content = '讀好了' as unknown,
      meta = META as unknown,
      isError = false,
      toolText,
    }: {
      content?: unknown;
      /** `'absent'`：這一格整個不放（`undefined` 會被預設值吃掉，日誌也不收 `undefined`）。 */
      meta?: unknown;
      isError?: boolean;
      toolText?: { maxBytes: number };
    } = {},
  ) {
    const record = () => {
      const log = pump.sessionLog;
      log.append('tool/call', { callId: 'c1', name: 'read_file', arguments: '{}' });
      log.append('tool/result', {
        callId: 'c1',
        isError,
        message: toLoggedMessage(
          new ToolMessage({ content: content as string, tool_call_id: 'c1', name: 'read_file' }),
        ),
        ...(meta === 'absent' ? {} : { meta }),
      });
    };
    async function* stream() {
      if (base === 'first') {
        yield frame('tools', ['tools:x'], {
          event: 'tool-started',
          tool_call_id: 'c1',
          tool_name: 'read_file',
          input: '{}',
        });
        yield frame('tools', ['tools:x'], {
          event: 'tool-finished',
          tool_call_id: 'c1',
          output: { status: 'success', content: TWO_BLOCKS },
        });
      }
      record();
      yield frame('lifecycle', [], { event: 'completed', graph_name: 'root' });
    }
    const agent = {
      streamEvents: async () => stream(),
      getState: async () => ({ values: {} }),
      updateState: async () => ({}),
    };
    const pump = new ThreadPump(
      agent as unknown as PumpAgent,
      'meta',
      undefined,
      undefined,
      toolText,
    );
    const frames: Event[] = [];
    const line = new AbortController();
    const draining = (async () => {
      for await (const next of pump.subscribe(['tools', 'lifecycle'], line.signal))
        frames.push(next);
    })();
    await pump.submit({ kind: 'message', text: '讀' });
    await until(() => frames.some(isRootDone));
    line.abort();
    await draining;
    return { frames, events: pump.sessionLog.events };
  }

  it('基座一顆都沒發：pump 合成的那顆收卡帶 meta，重播出同一份', async () => {
    const { frames, events } = await play('none');
    expect(toolEntries(frames)).toMatchObject([{ status: 'done', meta: META }]);
    expect(toolEntries(historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES))[0]?.meta).toEqual(META);
  });

  it('**更正幀只差 meta 也要送**：基座那顆先轉發了，日誌那則抽不出文字，兩邊只差這一格', async () => {
    const { frames, events } = await play('first', { content: TWO_BLOCKS });
    const finishes = frames.filter(
      (next) =>
        next.method === 'tools' &&
        (next.params.data as { event?: unknown }).event === 'tool-finished',
    );
    // 基座那顆、再加一顆同 id 的更正。
    expect(finishes).toHaveLength(2);
    expect(finishes[1]?.params.data).toMatchObject({ tool_call_id: 'c1', meta: META });
    expect(toolEntries(frames)).toMatchObject([{ status: 'done', meta: META }]);
    expect(toolEntries(frames)[0]?.text).toBeUndefined();
    expect(toolEntries(historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES))[0]?.meta).toEqual(META);
  });

  it('失敗的不帶，兩條路都是', async () => {
    const { frames, events } = await play('none', { isError: true });
    expect(toolEntries(frames)[0]).toMatchObject({ status: 'failed' });
    expect(toolEntries(frames)[0]?.meta).toBeUndefined();
    expect(
      toolEntries(historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES))[0]?.meta,
    ).toBeUndefined();
  });

  it('格式 16 以前的日誌（沒有 meta 這一格）：卡照收、沒有 meta', async () => {
    const { frames, events } = await play('none', { meta: 'absent' });
    expect(toolEntries(frames)).toMatchObject([{ status: 'done', text: '讀好了' }]);
    expect(toolEntries(frames)[0]?.meta).toBeUndefined();
    const replayed = historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES).find(
      (next) =>
        next.method === 'tools' &&
        (next.params.data as { event?: unknown }).event === 'tool-finished',
    );
    expect(replayed?.params.data).not.toHaveProperty('meta');
  });

  describe('上限同文字，從設定來', () => {
    const SMALL = 400;
    const SEARCH = {
      shape: 'matches',
      files: Array.from({ length: 10 }, (_, i) => ({
        path: `/f${i}.ts`,
        matches: [{ lineNumber: 1, line: 'x'.repeat(60) }],
      })),
      truncated: false,
      total: 10,
    };

    it('搜尋超過：從尾巴整組砍、truncated、total 不動、至少留一項；兩條路一樣', async () => {
      const { frames, events } = await play('none', {
        meta: SEARCH,
        toolText: { maxBytes: SMALL },
      });
      const live = toolEntries(frames)[0]?.meta as typeof SEARCH;
      expect(Buffer.byteLength(JSON.stringify(live), 'utf8')).toBeLessThanOrEqual(SMALL);
      expect(live.truncated).toBe(true);
      expect(live.total).toBe(10);
      expect(live.files.length).toBeGreaterThan(0);
      expect(live.files.length).toBeLessThan(10);
      expect(live.files).toEqual(SEARCH.files.slice(0, live.files.length));
      expect(toolEntries(historyFrames(events, SMALL))[0]?.meta).toEqual(live);
      // 對照組：同一份日誌在預設上限底下原樣上線。
      expect(toolEntries(historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES))[0]?.meta).toEqual(
        SEARCH,
      );
    });

    it('一項自己就超過的搜尋照樣留那一項，不給一張空卡', async () => {
      const one = {
        ...SEARCH,
        files: [SEARCH.files[0], SEARCH.files[1]].map((file) => ({
          ...file,
          matches: [{ lineNumber: 1, line: 'y'.repeat(SMALL) }],
        })),
        total: 2,
      };
      const { frames } = await play('none', { meta: one, toolText: { maxBytes: SMALL } });
      expect(toolEntries(frames)[0]?.meta).toMatchObject({
        truncated: true,
        total: 2,
        files: [one.files[0]],
      });
    });

    it('讀檔與 diff 超過：整格不給；兩條路一樣', async () => {
      const read = { ...META, lines: [{ number: 1, text: 'z'.repeat(SMALL) }] };
      const { frames, events } = await play('none', { meta: read, toolText: { maxBytes: SMALL } });
      expect(toolEntries(frames)[0]).toMatchObject({ status: 'done', text: '讀好了' });
      expect(toolEntries(frames)[0]?.meta).toBeUndefined();
      expect(toolEntries(historyFrames(events, SMALL))[0]?.meta).toBeUndefined();
      expect(toolEntries(historyFrames(events, DEFAULT_TOOL_TEXT_MAX_BYTES))[0]?.meta).toEqual(
        read,
      );

      const diff = { diffs: [{ path: '/a.ts', oldText: null, newText: 'z'.repeat(SMALL) }] };
      const edited = await play('none', { meta: diff, toolText: { maxBytes: SMALL } });
      expect(toolEntries(edited.frames)[0]?.meta).toBeUndefined();
    });
  });
});
