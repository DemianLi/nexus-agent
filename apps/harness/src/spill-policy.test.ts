/**
 * 工具結果外溢層（[#719](https://github.com/DemianLi/nexus-agent/issues/719)）。
 *
 * **判準是模型面與日誌上的東西，不是內部呼叫**：模型收到的那一則有多大、暗號在不在、全文照定位讀不讀得回、日誌記的是
 * 哪一則。組裝一律是真的 `createNexusAgent` 加真的主機目錄（`tool-result-stash.ts`），不用會失敗的替身。
 */

import { mkdtemp, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { estimateTextTokens, SessionRegistry } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { tool } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { fromLoggedMessage } from '@nexus/core';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import { toolResultAsSeen } from './conversation-restore.js';
import { stashSessionDirName } from './tool-result-stash.js';

const HEAD_MARK = 'HEAD-MARK-4417';
const MIDDLE_MARK = 'MIDDLE-SECRET-9021';
const TAIL_MARK = 'TAIL-MARK-2288';
const BUDGET = 3_000;

/** 每行都不一樣的文字（一種字重複幾萬次 o200k 會壓成很少的 token，量不出預算）。 */
function lines(count: number, middleAt?: number): string {
  return Array.from({ length: count }, (_, index) =>
    index === 0
      ? `${HEAD_MARK} 第 ${index} 行`
      : index === count - 1
        ? `${TAIL_MARK} 第 ${index} 行`
        : index === middleAt
          ? `${MIDDLE_MARK} 第 ${index} 行`
          : `line ${index} alpha beta gamma delta ${index * 7919}`,
  ).join('\n');
}

/** 約 40,000 字元、遠超 3,000 token，但低於基座 80,000 字元那條線，所以只有這一層會動它。 */
const BIG = lines(1_000, 500);

function bulkPlugin(payload: string, name = 'bulk'): PluginEntry {
  return {
    plugin: {
      name: `${name}-host`,
      apply: (registry) => {
        registry.tools.register(
          tool(() => payload, { name, description: '拿一坨東西。', schema: z.object({}) }),
        );
      },
    },
  };
}

const withWorker: PluginEntry = {
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

function text(message: BaseMessage | undefined): string {
  const content = message?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/** 一輪 prompt 裡最後一則工具結果。 */
function lastToolResult(prompt: readonly BaseMessage[] | undefined): string {
  const tools = (prompt ?? []).filter((message) => message.getType() === 'tool');
  return text(tools.at(-1));
}

const LOCATOR = /stored at: (\/\S+?\.txt)\./u;

async function newRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spill-'));
}

interface Run {
  readonly prompts: readonly (readonly BaseMessage[])[];
  readonly logged: readonly string[];
  readonly root: string;
}

/** 拿一坨。 */
async function run(
  payload: string,
  options: {
    readonly maxInlineTokens?: number;
    readonly root?: string;
    readonly noStash?: boolean;
  } = {},
): Promise<Run> {
  const root = options.root ?? (await newRoot());
  const model = new ScriptedChatModel({
    turns: [{ content: '', toolCalls: [{ name: 'bulk', args: {} }] }, { content: '看完了。' }],
  });
  const { agent, attachSession, dispose } = await createNexusAgent({
    model,
    plugins: [bulkPlugin(payload)],
    checkpointer: new MemorySaver(),
    ...(options.noStash === true ? {} : { toolResultStash: { rootDir: root, session: SESSION } }),
    spillPolicy: { maxInlineTokens: options.maxInlineTokens ?? BUDGET },
  });
  const sessions = new SessionRegistry('spill');
  const detach = attachSession(sessions);
  try {
    await agent.invoke(toAgentInvocation('去拿一坨。'), {
      configurable: { thread_id: 'spill' },
    });
  } finally {
    detach();
    await dispose();
  }
  const logged = sessions.root.events.flatMap((event) =>
    event.type === 'tool/result' && event.data.message !== undefined
      ? [text(fromLoggedMessage(event.data.message))]
      : [],
  );
  return { prompts: model.prompts, logged, root };
}

const SESSION = 'spill-session';

/**
 * 「重開」：另組一個全新的 agent，只憑同一個根與同一把會話鑰匙，照通知裡的路徑 `read_file`。
 * 路徑從第一個 agent 通知的文字裡取，不是從磁碟目錄猜。
 */
async function readBack(root: string, seen: string, offset: number): Promise<string> {
  const located = LOCATOR.exec(seen);
  if (located === null) throw new Error(`預覽裡沒有定位：${seen.slice(-300)}`);
  const model = new ScriptedChatModel({
    turns: [
      {
        content: '',
        toolCalls: [{ name: 'read_file', args: { file_path: located[1], offset, limit: 5 } }],
      },
      { content: '看完了。' },
    ],
  });
  const { agent, dispose } = await createNexusAgent({
    model,
    plugins: [],
    toolResultStash: { rootDir: root, session: SESSION },
    spillPolicy: { maxInlineTokens: BUDGET },
  });
  try {
    await agent.invoke(toAgentInvocation('接著讀。'));
  } finally {
    await dispose();
  }
  return lastToolResult(model.prompts[1]);
}

describe('超過預算的結果換成預覽，全文照定位讀得回', () => {
  it('模型收到的那一則不超過預算，頭尾在、中間不在，通知指向全文', async () => {
    const { prompts } = await run(BIG);
    const seen = lastToolResult(prompts[1]);
    expect(estimateTextTokens(seen)).toBeLessThanOrEqual(BUDGET);
    expect(seen).toContain(HEAD_MARK);
    expect(seen).toContain(TAIL_MARK);
    expect(seen).not.toContain(MIDDLE_MARK);
    expect(seen).toMatch(
      /\(Omitted \d+ bytes\. Full formatted result stored at: \/large_tool_results\/[0-9a-f]{12}-bulk\.txt\. /u,
    );
  });

  it('重開之後全新組裝的 agent 照通知裡的路徑 read_file，讀得到被略掉的中間', async () => {
    const { prompts, root } = await run(BIG);
    expect(await readBack(root, lastToolResult(prompts[1]), 498)).toContain(MIDDLE_MARK);
  });

  it('剛好在預算內的原樣不動', async () => {
    const small = lines(20);
    expect(estimateTextTokens(small)).toBeLessThan(BUDGET);
    const { prompts, root } = await run(small);
    expect(lastToolResult(prompts[1])).toBe(small);
    // 沒外溢，會話目錄也不該憑空出現。
    expect(await readdir(root)).toEqual([]);
  });

  it('read_file 自己的結果不再外溢（否則模型永遠讀不完）', async () => {
    // 預算壓到剛好放得下通知：一頁 5 行的 read_file 也遠小於預算，所以改用很寬的一頁來驗「超過預算也放過」。
    const { prompts, root } = await run(BIG);
    const located = LOCATOR.exec(lastToolResult(prompts[1]));
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            { name: 'read_file', args: { file_path: located?.[1], offset: 0, limit: 2000 } },
          ],
        },
        { content: '看完了。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [],
      toolResultStash: { rootDir: root, session: SESSION },
      spillPolicy: { maxInlineTokens: 300 },
    });
    try {
      await agent.invoke(toAgentInvocation('整份讀。'));
    } finally {
      await dispose();
    }
    const page = lastToolResult(model.prompts[1]);
    expect(estimateTextTokens(page)).toBeGreaterThan(300);
    expect(page).not.toContain('Full formatted result stored at');
    expect(page).toContain(MIDDLE_MARK);
  });

  it('日誌記的是換過的那一則（預覽），不是全文', async () => {
    const { logged, prompts } = await run(BIG);
    const bulk = logged.find((entry) => entry.includes(HEAD_MARK));
    expect(bulk).toBeDefined();
    // 日誌記的與模型收到的逐字相同：續接時從日誌推回模型的就是同一則，路徑一定對得上。
    expect(bulk).toBe(lastToolResult(prompts[1]));
    expect(toolResultAsSeen(new ToolMessage({ content: bulk!, tool_call_id: 'c' })).text).toBe(
      bulk,
    );
    expect(bulk).toContain('Full formatted result stored at');
    expect(bulk).not.toContain(MIDDLE_MARK);
  });

  it('檔案落在會話目錄底下，目錄 0700、檔案 0600', async () => {
    const root = await newRoot();
    await run(BIG, { root });
    const { stat } = await import('node:fs/promises');
    const dir = join(root, stashSessionDirName(SESSION));
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{12}-bulk\.txt$/u);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, names[0]!))).mode & 0o777).toBe(0o600);
  });
});

describe('存不下就保留原結果', () => {
  it('沒有暫存處（沒有會話鑰匙）：不外溢，低於 8 萬字元的原樣交給模型', async () => {
    const { prompts } = await run(BIG, { noStash: true });
    expect(lastToolResult(prompts[1])).toBe(BIG);
  });

  it.skipIf(process.getuid?.() === 0)(
    '暫存根不可寫：低於 8 萬字元的原樣交給模型，不是「存不進去」',
    async () => {
      const root = await newRoot();
      await chmod(root, 0o500);
      try {
        const warnings: string[] = [];
        const model = new ScriptedChatModel({
          turns: [{ content: '', toolCalls: [{ name: 'bulk', args: {} }] }, { content: '好。' }],
        });
        const { agent, dispose } = await createNexusAgent({
          model,
          plugins: [bulkPlugin(BIG)],
          toolResultStash: { rootDir: root, session: 's', warn: (m) => warnings.push(m) },
          spillPolicy: { maxInlineTokens: BUDGET },
        });
        try {
          await agent.invoke(toAgentInvocation('拿。'));
        } finally {
          await dispose();
        }
        expect(lastToolResult(model.prompts[1])).toBe(BIG);
        expect(warnings.some((message) => message.includes('存不下'))).toBe(true);
      } finally {
        await chmod(root, 0o700);
      }
    },
  );

  it('預算小到連通知都放不下：保留原結果', async () => {
    const model = new ScriptedChatModel({
      turns: [{ content: '', toolCalls: [{ name: 'bulk', args: {} }] }, { content: '好。' }],
    });
    const root = await newRoot();
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [bulkPlugin(BIG)],
      toolResultStash: { rootDir: root, session: 's' },
      spillPolicy: { maxInlineTokens: 10 },
    });
    try {
      await agent.invoke(toAgentInvocation('拿。'));
    } finally {
      await dispose();
    }
    expect(lastToolResult(model.prompts[1])).toBe(BIG);
  });
});

describe('沒掛外溢層時回到基座那條線', () => {
  it('省略 spillPolicy：同一則 4 萬字元的結果原樣進模型', async () => {
    const model = new ScriptedChatModel({
      turns: [{ content: '', toolCalls: [{ name: 'bulk', args: {} }] }, { content: '好。' }],
    });
    const root = await newRoot();
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [bulkPlugin(BIG)],
      toolResultStash: { rootDir: root, session: 's' },
    });
    try {
      await agent.invoke(toAgentInvocation('拿。'));
    } finally {
      await dispose();
    }
    expect(lastToolResult(model.prompts[1])).toBe(BIG);
  });
});

describe('子代理', () => {
  it('子代理裡的工具超過預算一樣外溢，照定位讀得回', async () => {
    const root = await newRoot();
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '', toolCalls: [{ name: 'bulk', args: {} }] },
        { content: '子代理收工。' },
        { content: '好。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [bulkPlugin(BIG), withWorker],
      toolResultStash: { rootDir: root, session: 's' },
      spillPolicy: { maxInlineTokens: BUDGET },
    });
    try {
      await agent.invoke(toAgentInvocation('派人。'));
    } finally {
      await dispose();
    }
    // 第三次呼叫模型是子代理拿到 bulk 結果之後的那一輪。
    const seen = lastToolResult(model.prompts[2]);
    expect(seen).toContain('Full formatted result stored at');
    expect(seen).toContain(HEAD_MARK);
    expect(seen).not.toContain(MIDDLE_MARK);
    expect(ToolMessage.isInstance((model.prompts[2] ?? []).at(-1))).toBe(true);
  });
});
