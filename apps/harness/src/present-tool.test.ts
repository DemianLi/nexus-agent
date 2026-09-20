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
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，工作區是暫存目錄，測試不碰真的 `~/.nexus-agent`。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { InvariantError, NexusPlugin, SessionEvent, SessionRegistry } from '@nexus/core';
import { PRESENT_NO_WORKSPACE_MESSAGE, PRESENT_TOOL_NAME } from '@nexus/plugin-present';
import type { DeliverablesPresentedPayload, Event } from '@nexus/wire';
import {
  createWireClient,
  DELIVERABLES_PRESENTED,
  emptyConversation,
  reduceAll,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { DEFAULT_PLUGINS } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { createSandboxPolicyPlugin } from './sandbox-policy.js';
import { SandboxModeController } from './sandbox-mode.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://present.test';
const THREAD_ID = 'present';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** 一個子代理的來源：委派那幾條要有人可以委派。 */
const WORKER: NexusPlugin = {
  name: 'worker-source',
  apply(registry) {
    registry.subagents.register({ name: 'worker', description: '幹活的。' });
  },
};

/** 一顆用 `config.writer` 往圖的 `custom` channel 寫東西的工具。 */
const WRITER: NexusPlugin = {
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
        { name: 'custom_writer', description: '往 custom channel 寫一顆。', schema: z.object({}) },
      ),
    );
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
  options: { workspace?: boolean; files?: Record<string, string>; extra?: NexusPlugin[] } = {},
): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-present-e2e-'));
  roots.push(root);
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await writeFile(join(root, name), content);
  }
  const workspace = options.workspace ?? true;
  const sandboxMode = new SandboxModeController('workspace-write');
  const violations: string[] = [];
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [
      ...DEFAULT_PLUGINS,
      WORKER,
      ...(options.extra ?? []),
      ...(workspace ? [createSandboxPolicyPlugin(sandboxMode, root)] : []),
    ],
    ...(workspace && {
      backend: new ContainedFilesystemBackend({
        rootDir: root,
        mode: sandboxMode.source,
        grants: sandboxMode,
      }),
    }),
    onInvariantViolation: (error: InvariantError) => void violations.push(error.message),
  });
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      attachInvariants: built.attachInvariants,
      attachSession: (registry) => {
        sessions = registry;
        return built.attachSession(registry);
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

/** 一串 frame 裡的交付那幾顆的 `data`。 */
function deliveriesIn(frames: readonly Event[]): unknown[] {
  return frames
    .filter((frame) => frame.method === 'custom')
    .map((frame) => frame.params.data as { name?: string; payload?: unknown });
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
    const expected: { name: string; payload: DeliverablesPresentedPayload } = {
      name: DELIVERABLES_PRESENTED,
      payload: { callId: callId!, files: [{ path: 'report.md', description: '報告' }] },
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
      frames.filter((frame) => frame.method !== 'custom');
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
    expect(outcome.live.filter((frame) => frame.method === 'custom')).toEqual([]);
  });
});
