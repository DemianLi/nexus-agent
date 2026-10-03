/**
 * **`present` 在真的圖、真的 pump 與歷史路由上跑一次**——[#441](https://github.com/DemianLi/nexus-agent/issues/441)
 * 的端到端驗收。
 *
 * `@nexus/plugin-present` 自己的測試走 registry 那一層，證得了工具檢查什麼、什麼時候寫；證不了的是：
 *
 * 1. 圍堵真的替它寫了那顆 `tool/result`，而交付落在它之後——「結果落定成功才寫」在真的呼叫順序上成立。
 * 2. **即時與重新整理產出同一顆 `custom` frame**：web 開著看到的，重新整理之後還在。
 * 3. **子代理的交付兩條路都不送**：它寫進子代理那一份，而歷史只讀 root——即時送了的話，重新整理就不見了。
 * 4. 沒有工作區（沒掛 sandbox-policy）時，工具在、叫了被拒。
 * 5. 圖自己發的 `custom` frame 不上線：那一格只放 pump 從日誌合成的東西。
 *
 * **走產品組裝**（#670）：agent 是 `createCliAgent` 組的（出貨清單、組裝點建的 backend 與沙箱控制器），模型換成清單上的腳本提供者，
 * 測試自己的 plugin（子代理來源、寫 `custom` channel 的工具）從 `plugins` 帶進去。以前這裡自己抄一份組裝，兩邊同不同形沒有東西守。
 *
 * **零憑證、零外部連線**：模型是腳本，工作區是暫存目錄，測試不碰真的 `~/.nexus-agent`。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tool } from '@langchain/core/tools';
import type { InvariantError, PluginEntry, SessionEvent, SessionRegistry } from '@nexus/core';
import {
  PRESENT_NO_WORKSPACE_MESSAGE,
  PRESENT_TOOL_NAME,
  presentOffWorkspaceMessage,
} from '@nexus/plugin-present';
import type { DeliverablesPresentedPayload, Event } from '@nexus/wire';
import {
  CONTEXT_MEASURE,
  createWireClient,
  DELIVERABLES_PRESENTED,
  INBOX,
  MODEL_USAGE,
  SESSION_STATS,
  TITLE,
  TODOS,
  TOKEN_USAGE,
  emptyConversation,
  reduceAll,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCliAgent } from './assembly-root.js';
import {
  TEST_BROWSER_AUTH,
  createMountPlugin,
  loopbackRequest,
  shippedPlugins,
  withScriptedModel,
} from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const shipped = await shippedPlugins();

const BASE_URL = 'http://present.test';
const THREAD_ID = 'present';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** 一個子代理的來源：委派那幾條要有人可以委派。 */
const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-source',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

/** 一顆用 `config.writer` 往圖的 `custom` channel 寫東西的工具。 */
const WRITER: PluginEntry = {
  plugin: {
    name: 'custom-writer',
    apply(registry) {
      registry.tools.register(
        tool(
          (_input: Record<string, never>, config?: unknown) => {
            (config as { writer?: (chunk: unknown) => void } | undefined)?.writer?.({
              secret: '不該上線',
            });
            return '寫了。';
          },
          {
            name: 'custom_writer',
            description: '往 custom channel 寫一顆。',
            schema: z.object({}),
          },
        ),
      );
    },
  },
};

interface Outcome {
  /** 即時收到的每一顆 frame，照順序。 */
  readonly live: readonly Event[];
  /** 這一輪之後拿到的歷史 frame。 */
  readonly history: readonly Event[];
  readonly sessions: SessionRegistry;
  readonly violations: readonly string[];
}

/**
 * 經 wire 跑一輪：開下行、送一句、抽到 root 收工，再拿歷史。
 *
 * @param turns - 模型腳本。
 * @param options - `workspace` 為否時不給 backend、不掛 sandbox-policy（沒給 `--workspace` 的組裝）。
 */
async function run(
  turns: readonly ScriptedTurn[],
  options: { workspace?: boolean; files?: Record<string, string>; extra?: PluginEntry[] } = {},
): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-present-e2e-'));
  roots.push(root);
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await writeFile(join(root, name), content);
  }
  const workspace = options.workspace ?? true;
  const violations: string[] = [];
  // **產品組裝**（#670）：出貨清單、組裝點建的 backend 與沙箱控制器、答題管道都是 `createCliAgent` 給的，這裡只換模型、
  // 帶進測試自己的 plugin。`workspace` 為否就是沒給 `--workspace`——產品組裝在那種情況下不建 backend、不掛 sandbox-policy。
  const built = await createCliAgent(
    { live: false, ...(workspace && { workspace: root }) },
    withScriptedModel([...shipped, WORKER, ...(options.extra ?? [])], turns),
    root,
    { onInvariantViolation: (error: InvariantError) => void violations.push(error.message) },
  );
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      attachSessions: (registry, backgroundPort) => {
        sessions = registry;
        return built.attachSessions(registry, backgroundPort);
      },
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const live: Event[] = [];
  try {
    const events = await client.openEvents(THREAD_ID);
    await client.runStart(THREAD_ID, '交付吧。');
    for (;;) {
      const next = await events.next();
      if (next.done === true) break;
      live.push(next.value);
      const data = next.value.params.data as { event?: string; graph_name?: string };
      if (next.value.method === 'lifecycle' && data.graph_name === 'root') {
        if (data.event === 'completed' || data.event === 'failed') break;
      }
    }
    // 交付排在下一個 microtask，而它在 root 收工之前就落定了；這裡只是讓尾巴的 frame 都進佇列。
    await new Promise((resolve) => setImmediate(resolve));
    const page = await client.threadHistory(THREAD_ID);
    if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
    await events.return?.(undefined);
    if (sessions === undefined) throw new Error('attachSession 沒被叫到');
    return { live, history: page.result.events, sessions, violations };
  } finally {
    await handler.close();
  }
}

/**
 * 一串 frame 裡的交付那幾顆的 `data`。**按名字篩**：同一個 channel 上還有用量表的那兩種（#528），每次模型呼叫
 * 都有。
 */
function deliveriesIn(frames: readonly Event[]): unknown[] {
  return frames
    .filter((frame) => frame.method === 'custom')
    .map((frame) => frame.params.data as { name?: string; payload?: unknown })
    .filter((data) => data.name === DELIVERABLES_PRESENTED);
}

/** 某顆工具那張卡的 `tool_call_id`（第一張）。 */
function callIdOf(frames: readonly Event[], name: string): string | undefined {
  const started = frames.find((frame) => {
    const data = frame.params.data as { event?: string; tool_name?: string };
    return frame.method === 'tools' && data.event === 'tool-started' && data.tool_name === name;
  });
  return (started?.params.data as { tool_call_id?: string } | undefined)?.tool_call_id;
}

/** 一串 frame 裡某顆工具的收尾那一顆。 */
function finishedOf(frames: readonly Event[], name: string): Record<string, unknown> | undefined {
  const callId = callIdOf(frames, name);
  const finished = frames.filter((frame) => {
    const data = frame.params.data as { event?: string; tool_call_id?: string };
    return (
      frame.method === 'tools' && data.event === 'tool-finished' && data.tool_call_id === callId
    );
  });
  return finished.at(-1)?.params.data as Record<string, unknown> | undefined;
}

/** 卡片收成成功：收尾那一顆在，而且沒有標 `failed`（成功的那顆不帶這一格）。 */
function expectSucceeded(frames: readonly Event[], name: string): void {
  const finished = finishedOf(frames, name);
  expect(finished).toBeDefined();
  expect(finished?.['failed']).not.toBe(true);
}

function presentCall(files: readonly { path: string; description?: string }[]) {
  return { name: PRESENT_TOOL_NAME, args: { files } };
}

function eventsOf(sessions: SessionRegistry, type: SessionEvent['type']): SessionEvent[] {
  return sessions
    .list()
    .flatMap((entry) => entry.log.events.filter((event) => event.type === type));
}

describe('present 在真的圖上', () => {
  it('root 交付成功：即時與重新整理同一顆 custom frame，落在那張工具卡收尾之後', async () => {
    const outcome = await run(
      [
        {
          content: '交付。',
          toolCalls: [presentCall([{ path: 'report.md', description: '報告' }])],
        },
        { content: '好了。' },
      ],
      { files: { 'report.md': '# 報告' } },
    );

    const live = deliveriesIn(outcome.live);
    // callId 對得上同一輪那張 `present` 工具卡——web 靠它把交付接回那張卡。
    const callId = callIdOf(outcome.live, PRESENT_TOOL_NAME);
    expect(callId).toBeDefined();
    // `seq` 是那顆 `deliverables/presented` 在 root 日誌裡的位置（#452）：web 拿 `(seq, index)`
    // 當讀檔路由的座標。**從日誌取、不寫死**——寫死一個數字的話，兩條路一起指錯也照樣綠，
    // 而這條測試的全部價值就在「即時與重新整理是同一顆」。
    const presentedSeq = outcome.sessions.root.events.find(
      (event) => event.type === 'deliverables/presented',
    )?.seq;
    expect(presentedSeq).toBeDefined();
    const expected: { name: string; payload: DeliverablesPresentedPayload } = {
      name: DELIVERABLES_PRESENTED,
      payload: {
        callId: callId!,
        seq: presentedSeq!,
        files: [{ path: 'report.md', description: '報告' }],
      },
    };
    expect(live).toEqual([expected]);
    expect(deliveriesIn(outcome.history)).toEqual([expected]);
    // 卡片是成功的，而交付落在它收尾之後——結果落定成功才寫。
    expectSucceeded(outcome.live, PRESENT_TOOL_NAME);
    const order = (frames: readonly Event[]) =>
      frames
        .filter(
          (frame) =>
            frame.method === 'custom' ||
            (frame.method === 'tools' &&
              (frame.params.data as { event?: string }).event === 'tool-finished'),
        )
        .map((frame) => frame.method);
    expect(order(outcome.live).at(-1)).toBe('custom');
    expect(order(outcome.history).at(-1)).toBe('custom');
    // 日誌上：交付在配對的 `tool/result` 之後。
    const events = outcome.sessions.root.events;
    const resultSeq = events.find(
      (event) => event.type === 'tool/result' && event.data.callId === callId,
    )?.seq;
    const delivery = events.find((event) => event.type === 'deliverables/presented');
    expect(delivery?.seq).toBeGreaterThan(resultSeq ?? Infinity);
    expect(outcome.violations).toEqual([]);
    // **折疊器把它折成獨立的一格**（#441 第二刀，由原本「不讀它」那條翻面）：即時與歷史各折出同一格，
    // 落在那張 `present` 工具卡之後；拿掉這一格，剩下的畫面（包括決定評分按鈕位置的輪尾）跟沒有這顆
    // frame 時一模一樣。
    const without = (frames: readonly Event[]) =>
      frames.filter(
        (frame) =>
          frame.method !== 'custom' ||
          (frame.params.data as { name?: unknown }).name !== DELIVERABLES_PRESENTED,
      );
    const folded = [outcome.live, outcome.history].map((frames) => {
      const state = reduceAll(emptyConversation(), frames);
      const at = state.entries.findIndex((entry) => entry.kind === 'deliverables');
      const card = state.entries.findIndex(
        (entry) => entry.kind === 'tool' && entry.callId === callId,
      );
      expect(at).toBeGreaterThan(card);
      expect(card).toBeGreaterThanOrEqual(0);
      // `turnStart` 是 `entries` 的索引，多一格就跟著多 1；輪尾標在哪一則由 `entries` 逐格比。
      const bare = reduceAll(emptyConversation(), without(frames));
      expect({
        ...state,
        entries: state.entries.filter((entry) => entry.kind !== 'deliverables'),
        turnStart: bare.turnStart,
      }).toEqual(bare);
      expect(state.turnStart).toBe(bare.turnStart + 1);
      return state.entries.filter((entry) => entry.kind === 'deliverables');
    });
    const entry = {
      kind: 'deliverables',
      id: `deliverables:${callId!}`,
      callId: callId!,
      // 同上：座標從日誌取。折出來的那一格帶的就是 frame 上那一個。
      seq: presentedSeq!,
      files: [{ path: 'report.md', description: '報告' }],
    };
    expect(folded).toEqual([[entry], [entry]]);
  });

  it('找不到檔案：卡片失敗、沒有交付', async () => {
    const outcome = await run([
      { content: '交付。', toolCalls: [presentCall([{ path: 'missing.md' }])] },
      { content: '好了。' },
    ]);
    expect(finishedOf(outcome.live, PRESENT_TOOL_NAME)).toMatchObject({ failed: true });
    expect(deliveriesIn(outcome.live)).toEqual([]);
    expect(deliveriesIn(outcome.history)).toEqual([]);
    expect(eventsOf(outcome.sessions, 'deliverables/presented')).toEqual([]);
    expect(outcome.violations).toEqual([]);
  });

  // **不在工作區磁碟上的路徑一律拒**（#951）。讀端（`deliverable-files.ts`）只對工作區做 `realpath`，路由那幾格
  // 它讀不到；檢查端走折後的 backend，以前會看見檔案、記下交付，於是下載永遠失敗。這一組在產品組裝上量：plugin 自己的
  // 測試用的是裸 `FilesystemBackend`，沒有路由，改不改都綠。
  describe.each([
    ['會話歷史', '/conversation_history/notes.md', []],
    ['工具結果暫存', '/large_tool_results/notes.md', []],
    // plugin 用 `backend.mount()` 掛的路由：同一個 bug 換個前綴，所以也要擋。
    ['plugin 掛的路由', '/mounted/notes.md', [createMountPlugin('/mounted/')]],
  ] as const)('路由上的檔：%s', (_label, path, extra) => {
    it('檔案寫得進去也 present 不了：卡片失敗、沒有交付', async () => {
      const outcome = await run(
        [
          {
            content: '先寫。',
            toolCalls: [{ name: 'write_file', args: { file_path: path, content: '# 內容' } }],
          },
          { content: '交付。', toolCalls: [presentCall([{ path }])] },
          { content: '好了。' },
        ],
        { extra: [...extra] },
      );
      // 前提：那個檔真的寫進去了——不然拒絕的理由是「找不到」而不是「不在磁碟上」，這一格就沒有量到它要量的。
      expectSucceeded(outcome.live, 'write_file');
      expect(finishedOf(outcome.live, PRESENT_TOOL_NAME)).toMatchObject({
        failed: true,
        message: `Error: ${presentOffWorkspaceMessage(path)}`,
      });
      expect(deliveriesIn(outcome.live)).toEqual([]);
      expect(deliveriesIn(outcome.history)).toEqual([]);
      expect(eventsOf(outcome.sessions, 'deliverables/presented')).toEqual([]);
      expect(outcome.violations).toEqual([]);
    });
  });

  it('子代理交付：寫進子代理那一份，即時與重新整理都不送', async () => {
    const outcome = await run(
      [
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '交付', subagent_type: 'worker' } }],
        },
        { content: '子代理交付。', toolCalls: [presentCall([{ path: 'report.md' }])] },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
      { files: { 'report.md': '# 報告' } },
    );
    // 前提：子代理那一份真的有一筆交付——不然下面兩條沒有東西可擋。
    const subagentDeliveries = outcome.sessions
      .list()
      .filter((entry) => entry.address.kind === 'subagent')
      .flatMap((entry) =>
        entry.log.events.filter((event) => event.type === 'deliverables/presented'),
      );
    expect(subagentDeliveries).toHaveLength(1);
    expect(
      outcome.sessions.root.events.some((event) => event.type === 'deliverables/presented'),
    ).toBe(false);
    expect(deliveriesIn(outcome.live)).toEqual([]);
    expect(deliveriesIn(outcome.history)).toEqual([]);
    expect(outcome.violations).toEqual([]);
  });

  it('沒有工作區：工具在，叫了回 dsh 那一句', async () => {
    const outcome = await run(
      [
        { content: '交付。', toolCalls: [presentCall([{ path: 'report.md' }])] },
        { content: '好了。' },
      ],
      { workspace: false },
    );
    expect(finishedOf(outcome.live, PRESENT_TOOL_NAME)).toMatchObject({
      failed: true,
      message: `Error: ${PRESENT_NO_WORKSPACE_MESSAGE}`,
    });
    expect(deliveriesIn(outcome.live)).toEqual([]);
  });

  it('圖自己發的 custom frame 不上線', async () => {
    const outcome = await run(
      [
        { content: '寫。', toolCalls: [{ name: 'custom_writer', args: {} }] },
        { content: '好了。' },
      ],
      { extra: [WRITER] },
    );
    // 前提：那顆工具真的跑了。
    expectSucceeded(outcome.live, 'custom_writer');
    // 線上的 `custom` 只剩 pump 從日誌合成的那幾種（這一段是用量表的、開輪時清空的待辦清單、會話累計、送出佇列與
    // 第一句開跑時的標題），工具寫的那一顆一個字都沒上來。
    const custom = outcome.live.filter((frame) => frame.method === 'custom');
    expect(custom.length).toBeGreaterThan(0);
    for (const frame of custom) {
      expect([
        MODEL_USAGE,
        CONTEXT_MEASURE,
        TODOS,
        TOKEN_USAGE,
        SESSION_STATS,
        INBOX,
        TITLE,
      ]).toContain((frame.params.data as { name?: unknown }).name);
    }
    expect(JSON.stringify(custom)).not.toContain('不該上線');
  });
});
