/**
 * **差分測試**（[#1286](https://github.com/DemianLi/nexus-agent/issues/1286)）：`present` 的交付寫入從「訂閱自己那份日誌、
 * 等同 `callId` 的 `tool/result`」搬到 `tools/result` 的一位監聽者，**日誌必須逐筆相同、順序相同**。
 *
 * 這個檔先在搬之前的實作上跑綠，搬完一字不改仍綠。期望值是寫死的字面值，不從實作裡算。
 *
 * 比的是整份日誌上跟工具呼叫有關的那幾種事件（`tool/call`、`tool/result`、`deliverables/presented`）的**次序**與
 * 各自的 `callId`／判定／檔案，而不只是「有沒有交付」——搬完之後排進 microtask 的時刻提早了幾行
 * （從日誌發佈 `tool/result` 的那一刻，移到圍堵派發 `tools/result` 的那一刻），平行呼叫之間的相對次序是它最可能走樣的地方。
 *
 * 案例：
 *
 * - 單次成功；
 * - 同一則 AI 訊息裡平行叫兩次 `present`；
 * - `present` 與別的工具平行；
 * - 本體拒絕（找不到檔）→ 沒有交付；
 * - 外層 middleware 把本體的成功改判成錯誤 → 沒有交付；
 * - root 與子代理用**同一個 `callId`** 各叫一次 `present` → 各自那份日誌各一筆，不串。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolMessage } from '@langchain/core/messages';
import { SessionRegistry } from '@nexus/core';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { PRESENT_TOOL_NAME } from '@nexus/plugin-present';
import { createMiddleware } from 'langchain';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import type { ScriptedTurn } from './scripted-model.js';

const shipped = await shippedPlugins();

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-source',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

/** 外層 middleware：`present` 的本體成功了，它把結果改判成錯誤（圍堵看得到的是最後這個）。 */
const FLIP_TO_ERROR: PluginEntry = {
  plugin: {
    name: 'flip-present-to-error',
    apply(registry) {
      registry.middleware.use(
        createMiddleware({
          name: 'flipPresentToError',
          wrapToolCall: async (request, handler) => {
            const result = await handler(request);
            if (request.toolCall.name !== PRESENT_TOOL_NAME) return result;
            return new ToolMessage({
              content: 'Error: 外層改判',
              tool_call_id: request.toolCall.id ?? '',
              name: PRESENT_TOOL_NAME,
              status: 'error',
            });
          },
        }) as never,
      );
    },
  },
};

/** 日誌上跟工具呼叫有關的那幾種事件，縮成可以逐筆比的形狀。 */
function trail(events: readonly SessionEvent[]): unknown[] {
  return events.flatMap((event): unknown[] => {
    switch (event.type) {
      case 'tool/call':
        return [['call', event.data.callId, event.data.name]];
      case 'tool/result':
        return [['result', event.data.callId, event.data.isError]];
      case 'deliverables/presented':
        return [
          ['presented', event.data.callId, event.data.files.map((file) => file.path).join(',')],
        ];
      default:
        return [];
    }
  });
}

interface Seen {
  readonly root: unknown[];
  readonly subagents: unknown[][];
}

async function run(
  turns: readonly ScriptedTurn[],
  options: { files?: readonly string[]; extra?: PluginEntry[] } = {},
): Promise<Seen> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-present-diff-'));
  roots.push(root);
  for (const name of options.files ?? ['report.md', 'notes.md']) {
    await writeFile(join(root, name), `# ${name}`);
  }
  const built = await createCliAgent(
    { live: false, workspace: root },
    withScriptedModel([...shipped, WORKER, ...(options.extra ?? [])], turns),
    root,
    {},
  );
  const sessions = new SessionRegistry('present-diff');
  const handle = built.attachSessions(sessions);
  try {
    await built.agent.invoke(toAgentInvocation('交付吧。'), {
      configurable: { thread_id: 'present-diff' },
    });
    // 交付排在下一個 microtask，這裡讓尾巴落定。
    await new Promise((resolve) => setImmediate(resolve));
    return {
      root: trail(sessions.root.events),
      subagents: sessions
        .list()
        .filter((entry) => entry.address.kind === 'subagent')
        .map((entry) => trail(entry.log.events)),
    };
  } finally {
    await handle.detach();
    await built.dispose();
  }
}

const present = (id: string, path: string) => ({
  id,
  name: PRESENT_TOOL_NAME,
  args: { files: [{ path }] },
});

describe('present 交付寫入：日誌逐筆相同', () => {
  it('單次成功：call → result → presented', async () => {
    const seen = await run([
      { content: '交付。', toolCalls: [present('p1', 'report.md')] },
      { content: '好了。' },
    ]);
    expect(seen.root).toEqual([
      ['call', 'p1', PRESENT_TOOL_NAME],
      ['result', 'p1', false],
      ['presented', 'p1', 'report.md'],
    ]);
  });

  it('同一則訊息裡平行叫兩次：每次的交付都在自己的 result 之後', async () => {
    const seen = await run([
      {
        content: '交付。',
        toolCalls: [present('p1', 'report.md'), present('p2', 'notes.md')],
      },
      { content: '好了。' },
    ]);
    expect(seen.root).toEqual(EXPECTED_PARALLEL);
  });

  it('與別的工具平行：交付的位置不變', async () => {
    const seen = await run([
      {
        content: '交付。',
        toolCalls: [present('p1', 'report.md'), { id: 'l1', name: 'ls', args: { path: '/' } }],
      },
      { content: '好了。' },
    ]);
    expect(seen.root).toEqual(EXPECTED_WITH_LS);
  });

  it('本體拒絕（找不到檔）：result 判錯誤、沒有交付', async () => {
    const seen = await run(
      [{ content: '交付。', toolCalls: [present('p1', 'missing.md')] }, { content: '好了。' }],
      { files: [] },
    );
    expect(seen.root).toEqual([
      ['call', 'p1', PRESENT_TOOL_NAME],
      ['result', 'p1', true],
    ]);
  });

  it('外層把成功改判成錯誤：result 判錯誤、沒有交付', async () => {
    const seen = await run(
      [{ content: '交付。', toolCalls: [present('p1', 'report.md')] }, { content: '好了。' }],
      { extra: [FLIP_TO_ERROR] },
    );
    expect(seen.root).toEqual([
      ['call', 'p1', PRESENT_TOOL_NAME],
      ['result', 'p1', true],
    ]);
  });

  it('root 與子代理用同一個 callId：各寫進自己那份，不串', async () => {
    const seen = await run([
      {
        content: '委派並交付。',
        toolCalls: [
          { id: 'task-1', name: 'task', args: { description: '交付', subagent_type: 'worker' } },
          present('dup', 'notes.md'),
        ],
      },
      { content: '子代理交付。', toolCalls: [present('dup', 'report.md')] },
      { content: '子代理收工。' },
      { content: '根收工。' },
    ]);
    expect(seen.subagents).toEqual([
      [
        ['call', 'dup', PRESENT_TOOL_NAME],
        ['result', 'dup', false],
        ['presented', 'dup', 'report.md'],
      ],
    ]);
    expect(seen.root).toEqual(EXPECTED_ROOT_DUP);
  });
});

/**
 * 平行叫的兩次，日誌上仍是一次接一次：圍堵在 `tool/call` 之後才進本體，而這個組裝裡同一則訊息的幾次呼叫是
 * 一次落定一次才輪到下一次（實測）。所以這一格量不到「兩次的 microtask 交錯」——那要在 plugin 單元測試裡用
 * 手排的順序量。
 */
const EXPECTED_PARALLEL: unknown[] = [
  ['call', 'p1', PRESENT_TOOL_NAME],
  ['result', 'p1', false],
  ['presented', 'p1', 'report.md'],
  ['call', 'p2', PRESENT_TOOL_NAME],
  ['result', 'p2', false],
  ['presented', 'p2', 'notes.md'],
];
const EXPECTED_WITH_LS: unknown[] = [
  ['call', 'p1', PRESENT_TOOL_NAME],
  ['result', 'p1', false],
  ['presented', 'p1', 'report.md'],
  ['call', 'l1', 'ls'],
  ['result', 'l1', false],
];
const EXPECTED_ROOT_DUP: unknown[] = [
  ['call', 'task-1', 'task'],
  ['result', 'task-1', false],
  ['call', 'dup', PRESENT_TOOL_NAME],
  ['result', 'dup', false],
  ['presented', 'dup', 'notes.md'],
];
