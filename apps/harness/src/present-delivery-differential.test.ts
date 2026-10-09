/**
 * **差分測試**（[#1286](https://github.com/DemianLi/nexus-agent/issues/1286)）：`present` 的交付寫入從「訂閱自己那份日誌、
 * 等同 `callId` 的 `tool/result`」搬到 `tools/result` 的一位監聽者。**三種事件各自的內容逐筆相同，只有次序從
 * `call → result → presented` 變成 dsh 的 `call → presented → result`。**
 *
 * 這個檔在 `0eee059e` 先立在搬之前的實作上跑綠（舊次序）；搬完之後**只翻了「預期次序」那幾格**（每一組 `presented` 與同
 * `callId` 的 `result` 對調），案例、夾具、比對的欄位一字未動。期望值是寫死的字面值，不從實作裡算。前四顆 commit 是
 * 討論會議 session 的方案 A（保留舊次序）；A 改 B 的決議見 #1286 的 PM 留言。
 *
 * 比的是整份日誌上跟工具呼叫有關的那幾種事件（`tool/call`、`tool/result`、`deliverables/presented`）的**次序**與
 * 各自的 `callId`／判定／檔案，而不只是「有沒有交付」——平行呼叫之間的相對次序是它最可能走樣的地方。
 *
 * 案例：
 *
 * - 單次成功；
 * - 同一則 AI 訊息裡平行叫兩次 `present`；
 * - `present` 與別的工具平行；
 * - 本體拒絕（找不到檔）→ 沒有交付；
 * - 外層 middleware 把本體的成功改判成錯誤 → 沒有交付；
 * - root 與子代理用**同一個 `callId`** 各叫一次 `present` → 各自那份日誌各一筆，不串；
 * - 背景子代理叫 `present` → 交付寫進它自己那份（它自己編的圖，要確認也走得到 `tools/result` 的派發）。
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
import { ScriptedChatModel } from './scripted-model.js';
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

/**
 * 背景子代理：自己編一張圖、由圖外的迴圈拉起來（#738），要確認它的工具呼叫也走得到 `tools/result` 的派發。
 * 它自己的模型腳本：叫一次 `present`，再收工。
 */
const BACKGROUND_WORKER: PluginEntry = {
  plugin: {
    name: 'background-worker-source',
    apply(registry) {
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
        model: new ScriptedChatModel({
          turns: [
            {
              content: '交付。',
              toolCalls: [
                { id: 'bg-p1', name: PRESENT_TOOL_NAME, args: { files: [{ path: 'report.md' }] } },
              ],
            },
            { content: '做完了。' },
          ],
        }) as never,
      });
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
  options: { files?: readonly string[]; extra?: PluginEntry[]; background?: boolean } = {},
): Promise<Seen> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-present-diff-'));
  roots.push(root);
  for (const name of options.files ?? ['report.md', 'notes.md']) {
    await writeFile(join(root, name), `# ${name}`);
  }
  const built = await createCliAgent(
    {
      live: false,
      workspace: root,
      ...(options.background === true && { backgroundSubagents: { maxActive: 2 } }),
    },
    withScriptedModel(
      [...shipped, ...(options.background === true ? [] : [WORKER]), ...(options.extra ?? [])],
      turns,
    ),
    root,
    {},
  );
  const sessions = new SessionRegistry('present-diff');
  const handle = built.attachSessions(sessions);
  try {
    await built.agent.invoke(toAgentInvocation('交付吧。'), {
      configurable: { thread_id: 'present-diff' },
    });
    if (options.background === true) {
      // 背景子代理在圖外跑：等它那一份日誌上出現 present 的結果（最多 8 秒）。
      const settled = () =>
        sessions
          .list()
          .some(
            (entry) =>
              entry.address.kind === 'subagent' &&
              entry.log.events.some((event) => event.type === 'tool/result'),
          );
      for (let waited = 0; !settled() && waited < 8000; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    // 交付排在下一個 microtask，這裡讓尾巴落定。
    await new Promise((resolve) => setImmediate(resolve));
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
  it('單次成功：call → presented → result（dsh 的次序）', async () => {
    const seen = await run([
      { content: '交付。', toolCalls: [present('p1', 'report.md')] },
      { content: '好了。' },
    ]);
    expect(seen.root).toEqual([
      ['call', 'p1', PRESENT_TOOL_NAME],
      ['presented', 'p1', 'report.md'],
      ['result', 'p1', false],
    ]);
  });

  it('同一則訊息裡平行叫兩次：每次的交付都在自己的 result 之前', async () => {
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
        ['presented', 'dup', 'report.md'],
        ['result', 'dup', false],
      ],
    ]);
    expect(seen.root).toEqual(EXPECTED_ROOT_DUP);
  });

  it('背景子代理叫 present：交付寫進它自己那份（serve 預設就是背景）', async () => {
    const seen = await run(
      [
        {
          content: '委派。',
          toolCalls: [
            {
              id: 'bg-task',
              name: 'subagent',
              args: { description: '交付', subagent_type: 'worker', run_in_background: true },
            },
          ],
        },
        { content: '根收尾。' },
      ],
      { extra: [BACKGROUND_WORKER], background: true },
    );
    expect(seen.subagents).toEqual(EXPECTED_BACKGROUND);
  });
});

/**
 * 平行叫的兩次，日誌上仍是一次接一次：`present` 沒宣告 `concurrencySafe`，工具屏障（`tool-barrier.ts`，#711）把它當獨佔——
 * 前面的落定它才開始、它落定後面的才開始，**跟別的工具、跟自己都一樣**，與 `maxParallelToolCalls` 設多少無關。所以同一個
 * agent 裡兩次 `present` 的 microtask 不可能交錯；這一格量的是「次序不變」，不是交錯。
 */
const EXPECTED_PARALLEL: unknown[] = [
  ['call', 'p1', PRESENT_TOOL_NAME],
  ['presented', 'p1', 'report.md'],
  ['result', 'p1', false],
  ['call', 'p2', PRESENT_TOOL_NAME],
  ['presented', 'p2', 'notes.md'],
  ['result', 'p2', false],
];
const EXPECTED_WITH_LS: unknown[] = [
  ['call', 'p1', PRESENT_TOOL_NAME],
  ['presented', 'p1', 'report.md'],
  ['result', 'p1', false],
  ['call', 'l1', 'ls'],
  ['result', 'l1', false],
];
const EXPECTED_ROOT_DUP: unknown[] = [
  ['call', 'task-1', 'task'],
  ['result', 'task-1', false],
  ['call', 'dup', PRESENT_TOOL_NAME],
  ['presented', 'dup', 'notes.md'],
  ['result', 'dup', false],
];

const EXPECTED_BACKGROUND: unknown[][] = [
  [
    ['call', 'bg-p1', PRESENT_TOOL_NAME],
    ['presented', 'bg-p1', 'report.md'],
    ['result', 'bg-p1', false],
  ],
];
