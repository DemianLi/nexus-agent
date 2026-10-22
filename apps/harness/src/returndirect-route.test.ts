/**
 * **基座形狀**：`returnDirect` 的路由只看「最後一則 ToolMessage 的 `name`」（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)）。
 *
 * `@nexus/plugin-plan-mode` 靠這個形狀做到「只有人關掉審核才收這一輪」（`EXIT_PLAN_MODE_RETURN_DIRECT` 的 JSDoc）：
 * 工具設 `returnDirect: true`，**其餘結局的結果不帶 `name`**，路由就不收。這個行為是 langchain 內部的條件邊
 * （`ReactAgent.js:359-365`，`langchain@1.5.10` 的 `#createToolsRouter`），沒有公開契約。
 * **這一檔用沒有 plan-mode 的最小 agent 把它釘住**——升版後形狀變了，紅在這裡，而不是紅在 plan-mode 的一堆情境測試裡讓人猜原因。
 *
 * 幾件事：
 *
 * 1. 最後一則有 `name`、且在 returnDirect 名單 → 走 exitNode：`afterAgent` 跑、不再叫模型。
 * 2. 最後一則沒有 `name` → 照常回頭叫模型（今天的行為）。
 * 3. 同一批全是 returnDirect → 都走 exitNode，收一次。
 * 4. **混批**（returnDirect 帶 `name` 與普通工具同一批）加上任何 `beforeModel` → langgraph 擲 `InvalidUpdateError`。這是
 *    plan-mode 在批裡不只一個呼叫時把 `exit_plan_mode` 的 `name` 拿掉的原因（登記的偏離，理由 1）；dsh 是批內任何一個收就收。
 * 5. 版號釘死：換版本要重新確認 (1)–(4) 之後才改這個常數。
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createAgent, createMiddleware } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

/** 驗證過的 langchain 版本。路由的來源行號 `ReactAgent.js:359-365` 是這一版的。 */
const VERIFIED_LANGCHAIN_VERSION = '1.5.10';

type Mode = 'named' | 'unnamed';

/** 造 returnDirect 那顆：`named` 回普通字串（tool node 補上 `name`），`unnamed` 回自己造的不帶 `name` 的 ToolMessage。 */
function directTool(mode: Mode) {
  return tool(
    async (_input: { x: string }, config: unknown) => {
      if (mode === 'named') return '收了';
      const callId = (config as { toolCall?: { id?: string } }).toolCall?.id ?? '';
      return new ToolMessage({ content: '沒收', tool_call_id: callId });
    },
    {
      name: 'direct_tool',
      description: '測試用：returnDirect。',
      schema: z.object({ x: z.string() }),
      returnDirect: true,
    },
  );
}

const plainTool = tool(async () => '普通', {
  name: 'plain_tool',
  description: '測試用：普通工具。',
  schema: z.object({}),
});

interface Outcome {
  readonly modelCalls: number;
  readonly afterAgentRuns: number;
  readonly lastMessageType: string;
}

async function run(mode: Mode, turns: ScriptedTurn[], beforeModel = false): Promise<Outcome> {
  const model = new ScriptedChatModel({ turns });
  let afterAgentRuns = 0;
  const agent = createAgent({
    model,
    tools: [directTool(mode), plainTool],
    middleware: [
      createMiddleware({
        name: 'after-agent-spy',
        // step-inbox 同時掛 `beforeModel` 與 `afterAgent`：產品組裝上永遠是這個形狀。
        ...(beforeModel ? { beforeModel: () => undefined } : {}),
        afterAgent: () => {
          afterAgentRuns += 1;
          return undefined;
        },
      }),
    ],
  });
  const result = await agent.invoke({ messages: [{ role: 'user', content: '開始' }] });
  const last = (result.messages as { getType(): string }[]).at(-1)!;
  return { modelCalls: model.prompts.length, afterAgentRuns, lastMessageType: last.getType() };
}

function runWithBeforeModel(mode: Mode, turns: ScriptedTurn[]): Promise<Outcome> {
  return run(mode, turns, true);
}

const DIRECT_CALL = { name: 'direct_tool', args: { x: 'a' } };
const PLAIN_CALL = { name: 'plain_tool', args: {} };
const TAIL: ScriptedTurn = { content: '收工。' };

describe('returnDirect 的路由只看最後一則 ToolMessage 的 name（langchain@1.5.10 ReactAgent.js:359-365）', () => {
  it('釘死版號：升版時先重新確認下面三條', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pkg = require('langchain/package.json') as { version: string };
    expect(pkg.version).toBe(VERIFIED_LANGCHAIN_VERSION);
  });

  it('(1) 有 name、在名單、是最後一則 → 走 exitNode：afterAgent 跑一次，不再叫模型', async () => {
    const seen = await run('named', [{ content: '呼叫', toolCalls: [DIRECT_CALL] }, TAIL]);
    expect(seen).toEqual({ modelCalls: 1, afterAgentRuns: 1, lastMessageType: 'tool' });
  });

  it('(2) 結果不帶 name → 照常回頭叫模型（今天的行為）', async () => {
    const seen = await run('unnamed', [{ content: '呼叫', toolCalls: [DIRECT_CALL] }, TAIL]);
    expect(seen).toEqual({ modelCalls: 2, afterAgentRuns: 1, lastMessageType: 'ai' });
  });

  it('(3) 同一批全是 returnDirect → 都走 exitNode，收一次', async () => {
    const seen = await run('named', [
      { content: '並行', toolCalls: [DIRECT_CALL, DIRECT_CALL] },
      TAIL,
    ]);
    expect(seen).toEqual({ modelCalls: 1, afterAgentRuns: 1, lastMessageType: 'tool' });
  });

  it('(4) 同一批 returnDirect 與普通工具混著、又掛了 beforeModel → langgraph 擲 InvalidUpdateError（不論順序）', async () => {
    // 基座每個工具呼叫是各自的 Send，路由各判；一批裡有的去 exitNode（afterAgent）、有的回頭去 beforeModel，
    // 兩邊在同一個 super-step 都寫 `jumpTo`。plan-mode 因此在批裡不只一個呼叫時把 exit_plan_mode 的 `name` 拿掉。
    // 這一條紅了＝基座修好了或換了形狀，可以重新考慮是否保留那段 wrapToolCall。
    for (const calls of [
      [DIRECT_CALL, PLAIN_CALL],
      [PLAIN_CALL, DIRECT_CALL],
    ]) {
      await expect(
        runWithBeforeModel('named', [{ content: '並行', toolCalls: calls }, TAIL]),
      ).rejects.toThrow(/jumpTo/u);
    }
  });

  it('(4′) 同樣的混批，returnDirect 那顆的結果不帶 name → 跟全是普通工具一樣，不擲、照常繼續', async () => {
    const seen = await runWithBeforeModel('unnamed', [
      { content: '並行', toolCalls: [DIRECT_CALL, PLAIN_CALL] },
      TAIL,
    ]);
    expect(seen).toEqual({ modelCalls: 2, afterAgentRuns: 1, lastMessageType: 'ai' });
  });

  it('不帶 name 的結果在請求裡不會憑空多出 name（對照 plan-mode 補回 name 的前提）', async () => {
    const model = new ScriptedChatModel({
      turns: [{ content: '呼叫', toolCalls: [DIRECT_CALL] }, TAIL],
    });
    const agent = createAgent({ model, tools: [directTool('unnamed'), plainTool] });
    await agent.invoke({ messages: [{ role: 'user', content: '開始' }] });
    const second = model.prompts[1]!;
    const toolMessage = second.find((message) => ToolMessage.isInstance(message))!;
    expect((toolMessage as ToolMessage).name).toBeUndefined();
    expect(AIMessage.isInstance(second.at(-2))).toBe(true);
  });
});
