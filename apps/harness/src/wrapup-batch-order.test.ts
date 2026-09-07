/**
 * 收尾指示**夾在哪兩則之間**：把今天真的送出去的那個順序釘成現況，並把「我們在靠端點
 * 寬容」這筆賭注寫下來。
 *
 * 圖是 [#190](https://github.com/DemianLi/nexus-agent/issues/190)，這一份是它第三條查項
 * （第 7 格的 `additionalContexts` 契約）掉出來的
 * [#202](https://github.com/DemianLi/nexus-agent/issues/202)。**那條查項的前提是錯的**：
 * 表上寫著「今天零生產者踩得到它」，而生產者今天就在樹上。
 *
 * **這個檔案不改任何行為。** `wrapupCommand` 一個字沒動。
 *
 * ## 危險本身
 *
 * `packages/nexus-plugin-goal/src/tools.ts` 的 `wrapupCommand` 回的 `Command` 帶著兩則
 * 訊息：自己那顆 `ToolMessage`，**後面當場接一則 `HumanMessage`**。模型那一輪若同時叫了
 * 第二顆工具，這則 `HumanMessage` 就**插進兩顆工具結果中間**。
 *
 * 這正是 dsh 明著否決的做法：`additionalContexts` 是「ferried on the returned result for
 * the loop's **active-batch FIFO**」（`references/deepseek-harness/packages/core/tools/src/
 * index.ts:1727`，SHA `d347e703908d0406b7a7ef80e3a0e594d86b2215`）——**批次結算完才排隊
 * 送**，不是當場插。那份 clone 不進版控且**會凍在 clone 當下**，重對前先自己
 * `git -C references/deepseek-harness fetch` 再對 SHA。
 *
 * ## 路徑閘門是量出來的，不是猜的
 *
 * 收尾指示**只在續行輪注入**：`tools.ts` 那句 `authority.kind !== 'goal-round'` 之後只回
 * 文字，所以**人打字那一輪碰不到這條路**。第一版探針就是跑在人打字那一輪，**沒有重現**
 * ——那是路徑閘門，不是危險不存在。下面那一條因此要走 pump ＋ 續行旗標，讓真的自己排的
 * 那一輪發生。
 *
 * ## 判決：不是今天的 bug，是一筆沒有人記著的賭注
 *
 * dsh 給的理由（工具呼叫與結果的鄰接性）**在我們今天打的端點上不成立**——它不驗這件事。
 * 2026-09-07 實測，先架本機端點攔請求正文（不燒 key），確認 `@langchain/openai`
 * **原封不動送出**交錯順序 `tool(a) → user → tool(b)`；然後三組序列打真端點：
 *
 * | | 序列 | 結果 |
 * | --- | --- | --- |
 * | A｜我們今天送的 | `tool(a) → user → tool(b)` | **收下了** |
 * | B｜對調 | `tool(a) → tool(b) → user` | 收下了 |
 * | C｜刪除 | `tool(a) → tool(b)` | 收下了 |
 *
 * **射程說死**：`https://integrate.api.nvidia.com/v1` 這一個端點、
 * `nvidia/nemotron-3-super-120b-a12b` 這一顆模型、`@langchain/openai` 這一個 adapter、
 * 2026-09-07 這一天。**沒量的：OpenAI 本家、Anthropic——這裡沒有第二把 key，不猜。**
 *
 * 所以不改行為。**但那是端點的寬容，不是我們的正確性**，而在這個檔案存在之前，沒有任何
 * 東西記著我們在靠它。換供應商那天它會變成一個**在真模型那一輪才炸、看起來像模型壞掉**
 * 的錯誤。
 *
 * ## 換端點或加第二個供應商時，這一格要重看——而且順序不能省
 *
 * 1. **先**架本機端點攔請求正文，確認那個 adapter 真的把交錯順序原封不動送出去。
 * 2. **再**打上面 A／B／C 三組對照。
 *
 * 第 1 步省掉的話 live 什麼都證不到：adapter 自己把順序整理過時，端點收下的是它整理後的
 * 樣子，而我們會以為那是我們送的。**這三組刻意不進 CI**——CI 不放模型 secret
 * （[#31](https://github.com/DemianLi/nexus-agent/issues/31)），它是手動、換端點時才跑的
 * 程序，所以只寫在這裡。
 *
 * ## 這張卡只做 characterization，那是決定，不是漏掉
 *
 * 順帶加一條「`update_goal` 收尾不得與其他工具同批」的檢查**刻意不做**：那是行為改動（會
 * 拒絕一個今天跑得動的批次），而**今天沒有任何證據說那個批次是壞的**。留到有端點真的拒絕
 * 那天——屆時下面這條 characterization **反過來寫就是它的驗收句**（絆索要翻面不要刪）。
 *
 * 照 dsh 改成批次結算後 FIFO 這條路**也不做**：它解的是我們碰不到的拒絕，而且**我們這側
 * 沒有批次結算的縫可以掛**——`Command` 當初被選上正是因為這個（`tools.ts` 檔頭那筆已登記
 * 的對讀）。
 *
 * ## 下面釘的是位置，不是數量，而且它釘的是現況不是理想
 *
 * `toHaveLength(n)` 那種斷言加一則訊息、把 n 加一就綠了，改的人什麼都不用讀
 * （[#195](https://github.com/DemianLi/nexus-agent/issues/195) 判過的空轉絆索）。所以下面
 * 量的是**那則注入訊息夾在哪兩則之間**，用角色 ＋ 工具名 ＋ 記號拼出來的指紋。
 *
 * **不要把它「修」成你以為應該的樣子。** 它綠著代表機制沒變；它紅了代表有人動了收尾這條
 * 路，**那正是回來重讀 #202 與上面那筆賭注的時刻**。
 */

import { MemorySaver } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import { GOAL_WRAPUP_MARKER } from '@nexus/core';
import type { SessionLog } from '@nexus/core';
import { createGoalPlugin } from '@nexus/plugin-goal';
import { createGoalInvariantPlugin } from '@nexus/plugin-goal/invariant';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import type { GoalDriverPort } from './goal-driver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedModelState, ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

/**
 * 腳本：人講一句 → 模型建目標 → **續行那一輪把 `update_goal(complete)` 與 `ls` 叫在同一批**
 * → 收工。
 *
 * 第二顆工具是 `ls`，也就是實測那一次用的那顆——**基座自己帶進來的真工具**，不是這個檔案
 * 為了湊出批次而掛的假貨。危險要成立就得有第二顆結果排在後面，而那顆結果得是產品路徑上
 * 真的會出現的東西。
 */
const TURNS: readonly ScriptedTurn[] = [
  {
    content: '',
    toolCalls: [{ name: 'create_goal', args: { objective: '把 CI 修綠', max_goal_rounds: 2 } }],
  },
  { content: '建好了。' },
  {
    content: '',
    toolCalls: [
      { name: 'update_goal', args: { goal_id: 'goal-1', revision: 1, action: 'complete' } },
      { name: 'ls', args: {} },
    ],
  },
  { content: '做完了，這是結果。' },
];

/** 等排程器把它那一串排完。同 `goal-driver-pump.test.ts`。 */
async function settle(pump: ThreadPump): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await pump.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));
    if (!pump.running) {
      await pump.whenIdle();
      await new Promise((resolve) => setImmediate(resolve));
      if (!pump.running) return;
    }
  }
}

/**
 * 一則訊息在指紋裡長什麼樣。
 *
 * **只認角色、工具名與記號，不看內容。** `ls` 的結果會經過基座那條 tool-result-stash
 * 的路，內容不是我們作主的東西；收尾指示的原文則由 `renderWrapupContext` 決定，改一個字
 * 就會讓一條講順序的絆索紅在別的地方。**這條絆索講的是位置，所以指紋也只帶身分。**
 */
function fingerprint(message: BaseMessage): string {
  const type = message.getType();
  if (type === 'tool') return `tool:${String((message as { name?: string }).name)}`;
  if (type === 'ai') {
    const calls = (message as { tool_calls?: { name: string }[] }).tool_calls ?? [];
    return `ai:[${calls.map((call) => call.name).join(', ')}]`;
  }
  const marker = message.additional_kwargs[GOAL_WRAPUP_MARKER] as { action?: string } | undefined;
  if (type === 'human' && marker != null) return `human:goal-wrapup(${String(marker.action)})`;
  return type;
}

/**
 * 找出**帶著收尾指示的那一份 prompt**，回它從那一批 AI 訊息起算的指紋。
 *
 * ## 為什麼不是 `prompts.at(-1)`
 *
 * 這樣找拆得開兩種失敗，而它們的出路完全不同：**一份 prompt 都沒帶記號**代表那則訊息在
 * tool node 到 `state.messages` 之間被吃掉了（`Command` 那條路斷了）；**帶了但夾錯位置**
 * 才是順序變了。`at(-1)` 把兩種壓成同一顆紅，而且腳本哪天多一輪就會靜靜地讀到別的批次。
 *
 * **不吃參數是刻意的。** 可以餵一份手寫訊息清單的 helper 證明的是指紋算得對，不是這條絆索
 * 焊在真組裝上（同 `approval-gate-order.test.ts` 那條）。
 */
function wrapupBatch(state: ScriptedModelState): string[] {
  const prompt = state.prompts.find((batch) =>
    batch.some((message) => message.additional_kwargs[GOAL_WRAPUP_MARKER] != null),
  );
  if (prompt === undefined) {
    throw new Error(
      '模型讀到的每一份 prompt 裡都沒有帶 `GOAL_WRAPUP_MARKER` 的訊息。\n' +
        '這不是順序變了，是**收尾指示根本沒到模型手上**：`wrapupCommand` 回的 `Command` ' +
        '要穿過 tool node 與 middleware 才進得了 `state.messages`，中間有人吃掉了它。\n' +
        '先去看 `packages/nexus-plugin-goal/src/tools.ts` 的 `wrapupCommand`，' +
        '以及那句 `authority.kind !== "goal-round"` 的閘門——續行輪沒排成的話這條路也不會走到。',
    );
  }
  const start = prompt.findIndex(
    (message) =>
      message.getType() === 'ai' &&
      ((message as { tool_calls?: unknown[] }).tool_calls ?? []).length > 1,
  );
  return prompt.slice(start).map(fingerprint);
}

/**
 * 今天真的送給模型的那個序列。**收尾指示夾在自己的工具結果與 `ls` 的結果中間。**
 *
 * 這一行是 characterization：它記的是現況，不是我們認為對的形狀。dsh 那側對的形狀會是
 * `ai → tool:update_goal → tool:ls → human:goal-wrapup(complete)`——**哪天真的改成那樣，
 * 這裡就照著改，然後回頭把檔頭那筆賭注一起收掉。**
 */
const TOOL_HUMAN_TOOL = [
  'ai:[update_goal, ls]',
  'tool:update_goal',
  'human:goal-wrapup(complete)',
  'tool:ls',
];

/** 這條絆索響的時候，讀的人該往哪裡去。 */
const ORDER_CHANGED_GUIDANCE =
  '收尾指示在批次裡的位置變了。\n' +
  '**先確認這是不是你打算改的**——這一行釘的是現況（見檔頭），不是理想形狀。\n' +
  '(a) 你把 `wrapupCommand` 那兩則訊息對調了：那是這條絆索的預檢突變，' +
  '它該紅，把期望值改回來或說明為什麼要改。\n' +
  '(b) 你在改成 dsh 那種批次結算後 FIFO：那就把期望值換成' +
  '`ai → tool:update_goal → tool:ls → human:goal-wrapup(complete)`，' +
  '並把檔頭那筆「我們在靠端點寬容」的賭注一起刪掉——它那天就還完了。\n' +
  '(c) 都不是：那是有人動了 tool node 或 middleware，' +
  '而收尾指示送給模型的位置是它的副作用。那才是真的要查的事。';

describe('自主收尾與另一顆工具同批時，收尾指示插在兩顆結果中間', () => {
  it('模型下一輪讀到的就是 tool → human → tool，而伴生一個字都沒說', async () => {
    let serial = 0;
    const plugin = createGoalPlugin({ now: () => 100, newGoalId: () => `goal-${(serial += 1)}` });
    const state: ScriptedModelState = { turn: 0, boundToolNames: [], lastPrompt: [], prompts: [] };
    const violations: string[] = [];
    const { agent, dispose, attachSession, attachInvariants } = await createNexusAgent({
      model: new ScriptedChatModel({ turns: TURNS, shared: state }) as never,
      plugins: [plugin, createGoalInvariantPlugin()],
      checkpointer: new MemorySaver(),
      onInvariantViolation: (error) => void violations.push(error.message),
    });
    // 同 `wire-handler.ts`：port 要日誌，而日誌由 pump 建，而 pump 的建構參數是 port。
    const late: { log?: SessionLog } = {};
    const port: GoalDriverPort = {
      goal: () => plugin.serviceFor(late.log as SessionLog)?.get(),
      block: (ref, reason) => void plugin.serviceFor(late.log as SessionLog)?.block(ref, reason),
      disarm: () => void plugin.serviceFor(late.log as SessionLog)?.disarm(),
      flush: () => Promise.resolve(),
      warn: () => {},
    };
    const pump = new ThreadPump(agent as unknown as PumpAgent, 'wrapup-batch', port);
    late.log = pump.sessionLog;
    // **伴生接在參與者之前**，同 `wire-handler.ts` 那條線的順序：參與者一裝上去就可能記
    // 東西，而那些東西該被已經在看的檢查看到。
    const detachInvariants = attachInvariants(pump.sessions);
    const detachSession = attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '把 CI 修綠' });
      await settle(pump);

      expect(wrapupBatch(state), ORDER_CHANGED_GUIDANCE).toEqual(TOOL_HUMAN_TOOL);
      // **先證伴生在看，再證它沒說話。** `attachInvariants` 在一個 companion 都沒有時回
      // `undefined`（`agent-factory.ts`），所以少了這一句，一個沒掛檢查的組裝也會給出
      // 空陣列——那與「檢查跑了、什麼都沒發現」逐字相同。
      expect(detachInvariants, '不變量伴生根本沒接上，下面那句空陣列證不到任何事').toBeDefined();
      expect(violations, '伴生對這條路開口了——那是新的事，先去看它說了什麼').toEqual([]);
    } finally {
      detachSession();
      detachInvariants?.();
      await dispose();
    }
  });
});
