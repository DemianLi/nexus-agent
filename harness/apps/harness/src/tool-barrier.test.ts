/**
 * 同一步工具呼叫的獨佔屏障（[#711](https://github.com/DemianLi/nexus-agent/issues/711) 第 2 步）的驗收：一律走
 * `createNexusAgent` 的產品路徑，量每顆呼叫的起訖時序。
 *
 * 零憑證、零外部連線：模型是 `ScriptedChatModel`，工具是會睡一下、把起訖記進時序表的探針。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import {
  CONCURRENCY_SAFE_METADATA_KEY,
  DEFAULT_PARALLEL_SAFE_TOOLS,
  isConcurrencySafe,
} from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

interface Timeline {
  readonly log: string[];
  inFlight: number;
  max: number;
}

/** 一顆睡 `ms` 毫秒的探針；`safe` 決定有沒有宣告可重疊。起訖記成 `start:<標籤>`／`end:<標籤>`。 */
function probeTool(name: string, safe: boolean, timeline: Timeline, ms = 40) {
  return tool(
    async ({ label }: { label: string }) => {
      timeline.log.push(`start:${label}`);
      timeline.inFlight += 1;
      timeline.max = Math.max(timeline.max, timeline.inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      timeline.inFlight -= 1;
      timeline.log.push(`end:${label}`);
      return `done ${label}`;
    },
    {
      name,
      description: '睡一下。',
      schema: z.object({ label: z.string() }),
      ...(safe ? { metadata: { [CONCURRENCY_SAFE_METADATA_KEY]: true } } : {}),
    },
  );
}

function plugin(name: string, ...tools: ReturnType<typeof probeTool>[]): PluginEntry {
  return {
    plugin: {
      name,
      apply: (registry) => {
        for (const each of tools) registry.tools.register(each);
      },
    },
  };
}

/** 一步照順序吐 `calls`，回時序與 state 裡 ToolMessage 的順序。 */
async function runStep(
  calls: readonly { name: string; label: string }[],
  tools: readonly ReturnType<typeof probeTool>[],
) {
  const scripted = calls.map((call, at) => ({
    name: call.name,
    args: { label: call.label },
    id: `c${at}`,
  }));
  const { agent, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [{ content: '', toolCalls: scripted }, { content: '好。' }],
    }),
    plugins: [plugin('probes', ...tools)],
  });
  try {
    const state = (await agent.invoke(toAgentInvocation('一起跑。'))) as {
      messages: BaseMessage[];
    };
    const order = state.messages
      .filter((message): message is ToolMessage => ToolMessage.isInstance(message))
      .map((message) => message.tool_call_id);
    return { order, expected: scripted.map((call) => call.id) };
  } finally {
    await dispose();
  }
}

const newTimeline = (): Timeline => ({ log: [], inFlight: 0, max: 0 });

describe('同一步的獨佔屏障（#711 第 2 步）', { timeout: 30_000 }, () => {
  it('[宣告, 獨佔, 宣告]：獨佔等前一顆收尾才開始，後一顆等獨佔收尾才開始；永遠只有一顆在途', async () => {
    const timeline = newTimeline();
    const { order, expected } = await runStep(
      [
        { name: 'safe_a', label: 'r1' },
        { name: 'excl', label: 'e' },
        { name: 'safe_a', label: 'r2' },
      ],
      [probeTool('safe_a', true, timeline), probeTool('excl', false, timeline)],
    );
    expect(timeline.log).toEqual(['start:r1', 'end:r1', 'start:e', 'end:e', 'start:r2', 'end:r2']);
    expect(timeline.max).toBe(1);
    expect(order).toEqual(expected);
  });

  it('兩顆都宣告：照舊重疊（屏障不拖慢平行的那一類）', async () => {
    const timeline = newTimeline();
    await runStep(
      [
        { name: 'safe_a', label: 'a' },
        { name: 'safe_b', label: 'b' },
      ],
      [probeTool('safe_a', true, timeline), probeTool('safe_b', true, timeline)],
    );
    expect(timeline.max).toBe(2);
  });

  it('兩顆沒宣告的外掛工具（含同名兩次）：不重疊，照模型給的順序', async () => {
    const timeline = newTimeline();
    const { order, expected } = await runStep(
      [
        { name: 'plain', label: '1' },
        { name: 'plain', label: '2' },
        { name: 'plain', label: '3' },
      ],
      [probeTool('plain', false, timeline)],
    );
    expect(timeline.log).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
    expect(order).toEqual(expected);
  });

  it('沒宣告的外掛工具夾在中間，把前後兩個宣告的隔開；開頭兩顆宣告的仍然重疊', async () => {
    const timeline = newTimeline();
    await runStep(
      [
        { name: 'safe_a', label: 'a' },
        { name: 'safe_b', label: 'b' },
        { name: 'plain', label: 'x' },
        { name: 'safe_a', label: 'c' },
      ],
      [
        probeTool('safe_a', true, timeline),
        probeTool('safe_b', true, timeline),
        probeTool('plain', false, timeline),
      ],
    );
    // a、b 重疊；x 等兩者都收尾；c 等 x。
    expect(timeline.log.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
    expect(timeline.log.slice(2, 4).sort()).toEqual(['end:a', 'end:b']);
    expect(timeline.log.slice(4)).toEqual(['start:x', 'end:x', 'start:c', 'end:c']);
  });

  it('宣告只認剛好是 true：寫 "true"、1 都算獨佔（fail-closed，同 dsh）', () => {
    for (const declared of ['true', 1, {}, undefined, false]) {
      expect(
        isConcurrencySafe({ metadata: { [CONCURRENCY_SAFE_METADATA_KEY]: declared } }, 'x'),
      ).toBe(false);
    }
    expect(isConcurrencySafe({ metadata: { [CONCURRENCY_SAFE_METADATA_KEY]: true } }, 'x')).toBe(
      true,
    );
  });

  it('基座工具靠名字表：read_file 與委派重疊，grep／glob／ls／write_file／edit_file／execute 獨佔', () => {
    for (const name of ['read_file', 'task', 'subagent']) {
      expect(isConcurrencySafe(undefined, name), name).toBe(true);
    }
    for (const name of ['grep', 'glob', 'ls', 'write_file', 'edit_file', 'execute']) {
      expect(isConcurrencySafe(undefined, name), name).toBe(false);
    }
    expect([...DEFAULT_PARALLEL_SAFE_TOOLS].sort()).toEqual(['read_file', 'subagent', 'task']);
  });

  describe('核准中斷（PM 2026-10-08 在 #711 拍板的第 3 條）', () => {
    /** a 不問、b 與 c 要核准；三顆都是沒宣告的獨佔工具。回 agent 與觀測。 */
    async function gated() {
      const ran: string[] = [];
      const asked: string[] = [];
      const names = ['a', 'b', 'c'];
      const { agent, dispose } = await createNexusAgent({
        model: new ScriptedChatModel({
          turns: [
            { content: '', toolCalls: names.map((name) => ({ name, args: {} })) },
            { content: '收工。' },
            { content: '再收一次工。' },
          ],
        }),
        checkpointer: new MemorySaver(),
        plugins: [
          {
            plugin: {
              name: 'spy',
              apply: (registry) => {
                for (const name of names) {
                  registry.tools.register(
                    tool(
                      () => {
                        ran.push(name);
                        return `${name} 跑過了`;
                      },
                      { name, description: name, schema: z.object({}) },
                    ),
                  );
                }
              },
            },
          },
          {
            plugin: {
              name: 'gate',
              apply: (registry) => {
                registry.approvals.gate((exec, next) => {
                  asked.push(exec.name);
                  return exec.name === 'b' || exec.name === 'c'
                    ? { kind: 'ask', reason: `${exec.name} 要人看過` }
                    : next();
                });
              },
            },
          },
        ],
      });
      return { agent, dispose, ran, asked };
    }

    const interruptsOf = (state: unknown) =>
      ((state as { __interrupt__?: { id: string; value: unknown }[] }).__interrupt__ ?? []) as {
        id: string;
        value: { actionRequests?: { name: string }[] };
      }[];

    it('一次一顆卡：b 中斷時 c 什麼都不做（閘門沒看過它），逐顆答完，ToolMessage 仍照 tool_calls 的順序', async () => {
      const { agent, dispose, ran, asked } = await gated();
      try {
        const config = { configurable: { thread_id: 'barrier-approval' } };
        const first = await agent.invoke(toAgentInvocation('動手'), config);
        // 前面那顆（a）跑完，b 掛出一張卡；c 在屏障上等，b 中斷時它跟著退出，沒進閘門、沒進工具。
        expect(interruptsOf(first).map((each) => each.value.actionRequests?.[0]?.name)).toEqual([
          'b',
        ]);
        expect(ran).toEqual(['a']);
        expect(asked).toEqual(['a', 'b']);

        // 產品路徑的 resume 逐 interrupt_id 送：答 b 只放行 b，c 退出後重跑，掛出自己的卡，而不是被 b 的決定偷渡。
        const second = await agent.invoke(
          new Command({
            resume: { [interruptsOf(first)[0]!.id]: { decisions: [{ type: 'approve' }] } },
          }) as never,
          config,
        );
        expect(interruptsOf(second).map((each) => each.value.actionRequests?.[0]?.name)).toEqual([
          'c',
        ]);
        expect(ran).toEqual(['a', 'b']);
        // c 的閘門判斷只在它真正開跑那一次發生：退出的那次沒有。
        expect(asked.filter((name) => name === 'c')).toHaveLength(1);

        const third = await agent.invoke(
          new Command({
            resume: { [interruptsOf(second)[0]!.id]: { decisions: [{ type: 'reject' }] } },
          }) as never,
          config,
        );
        expect(interruptsOf(third)).toEqual([]);
        expect(ran).toEqual(['a', 'b']);
        const tools = (third.messages as BaseMessage[]).filter((message): message is ToolMessage =>
          ToolMessage.isInstance(message),
        );
        expect(tools.map((message) => message.tool_call_id)).toEqual(
          tools.map((_, at) => `call_1_${at}`),
        );
        expect(tools.map((message) => message.text)).toEqual([
          expect.stringContaining('a 跑過了'),
          expect.stringContaining('b 跑過了'),
          expect.stringContaining('拒絕了 "c"'),
        ]);
      } finally {
        await dispose();
      }
    });
  });

  it('真的檔案工具：[read_file, edit_file, read_file]——改在第一讀之後、第二讀看得到改過的內容；兩顆讀不同檔照常重疊', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-barrier-fs-'));
    try {
      await writeFile(join(dir, 'a.txt'), '舊的一行\n');
      await writeFile(join(dir, 'b.txt'), '另一個檔\n');
      const file = '/a.txt';
      const { agent, dispose } = await createNexusAgent({
        model: new ScriptedChatModel({
          turns: [
            {
              content: '',
              toolCalls: [
                { name: 'read_file', args: { file_path: file }, id: 'r1' },
                {
                  name: 'edit_file',
                  args: { file_path: file, old_string: '舊的', new_string: '新的' },
                  id: 'e1',
                },
                { name: 'read_file', args: { file_path: file }, id: 'r2' },
                { name: 'read_file', args: { file_path: '/b.txt' }, id: 'r3' },
              ],
            },
            { content: '好。' },
          ],
        }),
        plugins: [],
        backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
      });
      try {
        const state = (await agent.invoke(toAgentInvocation('改一下。'))) as {
          messages: BaseMessage[];
        };
        const tools = state.messages.filter((message): message is ToolMessage =>
          ToolMessage.isInstance(message),
        );
        expect(tools.map((message) => message.tool_call_id)).toEqual(['r1', 'e1', 'r2', 'r3']);
        expect(tools.map((message) => message.status ?? 'success')).toEqual([
          'success',
          'success',
          'success',
          'success',
        ]);
        expect(tools[0]?.text).toContain('舊的一行');
        expect(tools[2]?.text).toContain('新的一行');
        expect(tools[3]?.text).toContain('另一個檔');
        expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('新的一行\n');
      } finally {
        await dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
