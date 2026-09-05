/**
 * 工具超時的**行為**驗收——掛進真的 agent、走真的 `AbortSignal`
 * （[#162](https://github.com/DemianLi/nexus-agent/issues/162)）。
 *
 * 分類與措辭本身在 `@nexus/core` 的 `containment.test.ts`，那一層餵的是手做的
 * `DOMException`。**這一份存在是因為那顆例外是不是真的長那樣，只有基座說了算**：預算的
 * 載體是工具上的 `defaultConfig: { timeout }`，`ensureConfig` 把它變成
 * `AbortSignal.timeout(ms)` 併進 `signal`，然後 `tool()` 在 abort 事件上 reject
 * `getAbortSignalError(signal)`——中間任何一段換了，上面那一層照樣全綠。
 *
 * **這裡刻意不掛任何 plugin 來提供圍堵**：它由 `foldRegistry` 打底
 * （[#159](https://github.com/DemianLi/nexus-agent/issues/159)），一條「掛了 plugin 才觀察到」
 * 的測試證不到今天的產品路徑。
 */

import { tool } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/**
 * 一顆會睡 `bodyMs` 的工具，`budgetMs` 給了就宣告預算。
 *
 * **本體一定 `await` 真的計時器**：純 microtask 的迴圈會把計時器餓死，而那是探針的產物
 * 不是基座的行為（`eval/runner.ts` 檔頭記過同一件事）。
 */
function sleeper(name: string, bodyMs: number, budgetMs?: number) {
  return tool(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, bodyMs));
      return `${name} 做完了`;
    },
    {
      name,
      description: `睡 ${bodyMs}ms`,
      schema: z.object({}),
      ...(budgetMs === undefined ? {} : { defaultConfig: { timeout: budgetMs } }),
    },
  );
}

/** 跑一輪：模型叫一次那顆工具，然後收工。回傳那則 ToolMessage。 */
async function runOnce(
  toolToUse: ReturnType<typeof sleeper>,
): Promise<BaseMessage & { status?: string }> {
  const plugin: NexusPlugin = {
    name: 'timeout-fixture',
    apply(registration) {
      registration.tools.register(toolToUse);
    },
  };
  const { agent, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        { content: '動手。', toolCalls: [{ name: toolToUse.name, args: {} }] },
        { content: '收工。' },
        { content: '再收一次。' },
      ],
    }) as never,
    plugins: [plugin],
  });
  try {
    const result = (await agent.invoke(toAgentInvocation('動手'))) as {
      messages: readonly BaseMessage[];
    };
    const toolMessage = result.messages.filter((message) => message.getType() === 'tool').at(-1);
    if (toolMessage === undefined) throw new Error('這一輪沒有 ToolMessage');
    return toolMessage as BaseMessage & { status?: string };
  } finally {
    await dispose();
  }
}

/**
 * 同 {@link runOnce}，但那顆工具要人核准，而且人在核准點想了 `thinkMs` 才批准。
 *
 * @param toolToUse - 要跑的工具。
 * @param thinkMs - 停在核准點多久。
 * @returns 恢復之後最後那則 ToolMessage。
 */
async function runGated(
  toolToUse: ReturnType<typeof sleeper>,
  thinkMs: number,
): Promise<(BaseMessage & { status?: string }) | undefined> {
  const plugin: NexusPlugin = {
    name: 'gated-fixture',
    apply(registration) {
      registration.tools.register(toolToUse);
      registration.approvals.gate((execution, next) =>
        execution.name === toolToUse.name ? { kind: 'ask', reason: '看一下' } : next(),
      );
    },
  };
  const { agent, dispose } = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        { content: '動手。', toolCalls: [{ name: toolToUse.name, args: {} }] },
        { content: '收工。' },
        { content: '再收一次。' },
      ],
    }) as never,
    checkpointer: new MemorySaver(),
    plugins: [plugin],
  });
  const config = { configurable: { thread_id: `gated-${toolToUse.name}` } } as never;
  try {
    const paused = (await agent.invoke(toAgentInvocation('動手'), config)) as {
      __interrupt__?: unknown;
    };
    expect(paused.__interrupt__).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, thinkMs));
    const after = (await agent.invoke(
      new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never,
      config,
    )) as { messages: readonly BaseMessage[] };
    return after.messages.filter((entry) => entry.getType() === 'tool').at(-1) as
      (BaseMessage & { status?: string }) | undefined;
  } finally {
    await dispose();
  }
}

describe('工具超時', () => {
  it('超過自己宣告的預算 → 模型收到的話說得出等了多久，而且 run 跑完了', async () => {
    const message = await runOnce(sleeper('slow', 500, 120));
    const text = String(message.content);
    expect(text).toContain('工具 slow 超時');
    expect(text).toContain('120ms 預算');
    // **數字要接近預算，不是「有一個數字」**：回報 0、或回報整場 run 的牆鐘，都該紅。
    const elapsed = Number(/等了 (\d+)ms/.exec(text)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(500);
    expect(message.status).toBe('error');
    // 基座原本那句英文是這張卡要換掉的東西。
    expect(text).not.toContain('The operation was aborted');
  }, 20000);

  it('對照組一：預算夠寬就正常做完，文字一字不動', async () => {
    const message = await runOnce(sleeper('fast', 20, 5000));
    expect(String(message.content)).toBe('fast 做完了');
    expect(message.status).toBe('success');
  }, 20000);

  it('對照組二：本體自己拋錯不被誤標成超時', async () => {
    const boom = tool(
      () => {
        throw new Error('連不上');
      },
      { name: 'boom', description: 'boom', schema: z.object({}), defaultConfig: { timeout: 5000 } },
    );
    const message = await runOnce(boom as never);
    expect(String(message.content)).toBe('工具 boom 執行失敗：連不上');
    expect(String(message.content)).not.toContain('超時');
  }, 20000);

  /**
   * **這一格釘住「沒有統一預設」這個決定。** dsh 的 `bash`／`read`／`write`／`edit` 都
   * 刻意不宣告預算，`timeoutMs === undefined` 就不武裝任何截止時間。哪天有人給了統一
   * 預設，這條會依那個預設的大小而紅。
   */
  it('對照組三：沒宣告預算的工具跑多久都不被打斷', async () => {
    const message = await runOnce(sleeper('nobudget', 400));
    expect(String(message.content)).toBe('nobudget 做完了');
    expect(message.status).toBe('success');
  }, 20000);

  /**
   * **對照組四：人在核准點想了多久，不算在工具頭上。**
   *
   * 計時器開在圍堵那一層，而圍堵是最外層的 `wrapToolCall`——核准閘門在它裡面
   * （`containment.ts` 檔頭：射程涵蓋內層每一個 middleware）。照這個排法讀，一個人在
   * 核准點想了 700ms 會被算成「工具等了 700ms」，而預算只有幾百毫秒。
   *
   * **量出來不是這樣**：`interrupt()` 讓那個節點整個重跑，所以恢復之後 `wrapToolCall`
   * 是**重新進來的**——圍堵的計時器與 `ensureConfig` 武裝的 `AbortSignal.timeout` 一起
   * 重新開始。
   *
   * **拆成兩條，因為它們釘的是兩個不同的東西。** 第一條走成功路徑，釘的是**基座的**
   * `AbortSignal` 有沒有重新武裝；第二條走超時路徑，釘的是**我們的**計時器有沒有跟著
   * 重新開始。只有第二條會在有人把 `startedAt` 提到 `wrapToolCall` 外面時變紅——第一條
   * 根本走不到 `formatToolTimeout`，所以那個突變它接不到（量過）。
   */
  it('對照組四之一：核准點上人想得比預算久，工具照樣正常做完', async () => {
    const message = await runGated(sleeper('gated', 30, 300), 700);
    expect(String(message?.content)).toBe('gated 做完了');
    expect(message?.status).toBe('success');
  }, 20000);

  it('對照組四之二：核准後真的超時了，回報的數字不含人想的那 700ms', async () => {
    const message = await runGated(sleeper('gated-slow', 500, 200), 700);
    const text = String(message?.content);
    expect(text).toContain('工具 gated-slow 超時');
    const elapsed = Number(/等了 (\d+)ms/.exec(text)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    // **上限是這一條的全部價值**：人想了 700ms、工具本體 500ms。計時器沒有跟著節點重跑
    // 的話，這個數字會是 1200 以上。
    expect(elapsed).toBeLessThan(700);
  }, 20000);
});
