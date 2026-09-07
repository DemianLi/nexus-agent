/**
 * 核准 waterfall 的**順序**：第二位 gate 出現時要有東西響，而且今天那個危險長什麼樣。
 *
 * 圖是 [#190](https://github.com/DemianLi/nexus-agent/issues/190)，這一份是它的候選 4
 * 掉出來的 [#199](https://github.com/DemianLi/nexus-agent/issues/199)，由
 * [#198](https://github.com/DemianLi/nexus-agent/issues/198) 判出來：**第 5 格不建 dsh 那
 * 一層「只能拒絕」的 guard，改成一條絆索。** 這個檔案不改任何行為。
 *
 * ## 危險本身
 *
 * `PreToolListener` 的 `next()` **不呼叫就是把後面的人整個短路掉**——那是照 dsh 的
 * waterfall 語義刻意提供的能力（`packages/nexus-core/src/approval.ts:60-70`、
 * `registry.ts:248-256` 兩處都寫著）。於是一位排在前面、回 `{ kind: 'allow' }` 而不呼叫
 * `next()` 的 gate，會把排在它後面的每一位整條吃掉。
 *
 * **今天不是缺陷**：預設組裝裡只有一位 gate（下面第一層就是在釘這件事），而它從不回
 * `allow`。但那是**組裝的巧合**，不是機制擋住的。
 *
 * ## 結局是「計劃被批准了」，不是「核准被跳過」
 *
 * 被吃掉的那位是 plan-mode 的 `exit_plan_mode` 閘門
 * （`packages/nexus-plugin-plan-mode/src/index.ts:514`）。它被短路之後，工具**真的跑完**，
 * 而 `createExitPlanModeTool()` 回的 `Command` 帶著 `{ [PLAN_MODE_STATE_KEY]: false }`——
 * 所以模式關掉、模型從下一步起可以動手，**而沒有任何人看過那份計劃**。
 *
 * plan-mode 檔頭那句「人批准計劃與人批准這次工具呼叫是同一件事，所以不另建評審通道」
 * 被整條拆掉，**而畫面上完全正常**：沒有例外、沒有拒絕訊息、沒有中斷。這就是為什麼第二層
 * 量的是 `planModeActive`，不是「閘門有沒有被呼叫」。
 *
 * ## 順序由 plugin 載入順序決定，plan-mode 自己管不著
 *
 * `approvals` 這個註冊點**只有 `append`**（`packages/nexus-core/src/registry.ts:787`），
 * 沒有 `middleware.use({ prepend })` 或 `permissions` 那種槓桿。想排到前面的人只要在
 * 清單裡排前面就行，被排到後面的人沒有任何辦法。**這張卡不給 `approvals` 加 `prepend`**
 * （#199 的射程），只是把這件事釘住。
 *
 * ## 為什麼不照抄 dsh
 *
 * dsh 那一格是 `ctx.tools.guard()`，型別是
 * `ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`
 * （`references/deepseek-harness/packages/core/tools/src/index.ts:704`，SHA
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`）——**限制不是一套執行期政策，是一個窄回傳
 * 型別**：沒有 `allow` 可回，也沒有 `next` 可跳，所以「誰都不能強制放行」是型別保證的。
 * 便宜得很，但它解的是我們今天還沒有的問題（多位互不信任的 gate 作者），照抄會多一個
 * 註冊點與一套作用域規則。**#198 判：不建。** 那份 clone 不進版控且**會凍在 clone 當下**，
 * 要重對自己 `git -C references/deepseek-harness fetch` 再對 SHA。
 *
 * ## 更正 #198 的一句話
 *
 * #198 的答案裡寫著：「寬鬆 gate 在前時，`interrupt` 必須還在、`planModeActive` 必須還是
 * `true`」。**那句今天跑會紅**——下面第二層量到的就是 `interrupt=false planModeActive=false`。
 * 它是「**建了那一層之後**」的驗收句，而 #198 判的正是不建。正確的說法是本檔第二層那三行：
 * **釘住今天的實際值**。這是 #190 的第七次自我更正，對象是上一張卡的**答案**，不是它的判決。
 *
 * ## 射程：只到 `DEFAULT_PLUGINS`
 *
 * 第一層只釘 `apps/harness/src/cli.ts` 的那一份**預設組裝**。`--plugins` 載入的模組
 * （`approval.fixture.ts` 那一類）**刻意在柵欄外**：那條路上的清單由呼叫端自己決定，釘它
 * 等於宣告我們管得住別人的組裝——管不住，而且假裝管得住比不管更糟。**不要把這條絆索讀成
 * 「所有組裝都覆蓋到了」。**
 */

import { MemorySaver } from '@langchain/langgraph';
import { formatOrigin, loadPlugins } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import {
  PLAN_MODE_STATE_KEY,
  EXIT_PLAN_MODE_TOOL_NAME,
  createPlanModePlugin,
} from '@nexus/plugin-plan-mode';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { DEFAULT_PLUGINS } from './cli.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/* -------------------------------------------------------------------------- */
/* 第一層：預設組裝裡的核准 gate 是誰掛的                                        */
/* -------------------------------------------------------------------------- */

/**
 * 預設組裝裡每一位核准 gate 的身分，**依 waterfall 順序**。
 *
 * ## 釘身分不釘數量
 *
 * `toHaveLength(1)` 是 [#195](https://github.com/DemianLi/nexus-agent/issues/195) 判過的
 * 空轉絆索：註冊第二位、把 1 改成 2 就綠了，改的人什麼都不用讀。**改一份身分清單會逼人
 * 看內容**，而下面那則失敗訊息就在那裡等他。
 *
 * ## 為什麼是有序陣列，不是名字的 `Set`
 *
 * `new Set(['plan-mode', 'plan-mode']).size` 是 1——**一位與 plan-mode 同名的第二位 gate
 * 會從名字集合裡整個消失**。`formatOrigin` 是 `${id} (${name})`（`plugin.ts:104`），而 `id`
 * 是逐個掛載唯一的，所以陣列版連同名的那種也擋得住；順帶還釘住了**順序**，而順序正是這張
 * 卡的整個主題。
 *
 * ## `#0` 那個序號是可以釘的
 *
 * `plugin.ts` 明說自動 id 的 `<name>#<序號>` **不承諾跨清單穩定**。那條警告講的是**同名**
 * 條目之間的相對位置：計數器是 per-name 的（`createEchoPlugin()` 排在 index 0，plan-mode
 * 仍然是 `#0`），所以插入別的 plugin 動不到它。**它會移動的唯一情形，是清單裡多了一個同名
 * 的 plugin——那本來就是該響的事。**
 */
const EXPECTED_APPROVAL_GATES: readonly string[] = ['plan-mode#0 (plan-mode)'];

/**
 * 這條絆索響的時候，讀的人該往哪裡去。
 *
 * **不是「數字不對」。** 失敗訊息要帶著那個真正的問題與三個出路，否則下一個人會把期望值
 * 改成他量到的、然後什麼都沒讀就走了。
 */
const NEW_GATE_GUIDANCE =
  '預設組裝的核准 gate 換人了。這不是把期望值改一改就好的事——\n' +
  '要回答的問題是：**這位新的 gate 會不會回 `{ kind: "allow" }` 而不呼叫 `next()`？**\n' +
  '會的話，排在它後面的每一位都被整條吃掉，包括 plan-mode 的 `exit_plan_mode` 閘門，\n' +
  '結局是「計劃被批准了」而不是「核准被跳過」——本檔第二層那三行實測就是那個結局。\n' +
  '三個出路：(a) 讓它一定呼叫 `next()`；(b) 真的建 dsh 那種只能拒絕的 guard 層\n' +
  '（#198 判過不建，要推翻請開新卡）；(c) 明著接受並把它加進上面那份清單。\n' +
  '`approvals` 只有 `append`（registry.ts:787），排在前面的人贏，被排到後面的沒有辦法。';

describe('預設組裝裡的核准 gate', () => {
  /**
   * **這一條刻意不吃參數。**
   *
   * 寫成 `origins(plugins = DEFAULT_PLUGINS)` 再拿別的清單去「驗」它，證明的是斷言邏輯會動，
   * 而**不是這條絆索焊在產品那份清單上**——那就是 #195 那個空轉絆索換一件衣服。所以下面
   * 直接讀 `DEFAULT_PLUGINS`，預檢的三個突變是真的去改 `cli.ts` 再還原。
   *
   * 這一條**同時擋得住規矩的第二位**（有呼叫 `next()` 的那種）。那是刻意的：絆索的工作是
   * 「有人來了，回答上面那個問題」，不是「偵測強制允許」。只擋沒禮貌的那種，順序這個危險
   * 就整個漏掉了——而全樹唯一的第二位 gate（`apps/harness/src/approval.fixture.ts:29`）
   * 正是規矩的那種，這個形狀早就存在。
   */
  it('恰好是 plan-mode 一位，依 waterfall 順序', async () => {
    const { registry, dispose } = await loadPlugins([...DEFAULT_PLUGINS]);
    try {
      const gates = registry.approvals.listeners().map((entry) => formatOrigin(entry.origin));
      expect(gates, NEW_GATE_GUIDANCE).toEqual(EXPECTED_APPROVAL_GATES);
    } finally {
      await dispose();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 第二層：把順序這個危險釘成可執行的實測                                        */
/* -------------------------------------------------------------------------- */

/**
 * 一位回 `{ kind: 'allow' }` 而**不呼叫 `next()`** 的 gate。
 *
 * 這不是假想的壞人：`{ kind: 'allow' }` 是 `PreToolDecision` 三格之一，不呼叫 `next()`
 * 是 waterfall 明著提供的能力。**寫成 factory 而不是共用一個常數**，是因為 plugin 物件
 * 會被載入路徑登記身分，三組對照各建一份才不會悄悄共用。
 */
function permissiveGatePlugin(): NexusPlugin {
  return {
    name: 'probe-permissive',
    apply(registry) {
      registry.approvals.gate(() => ({ kind: 'allow' }));
    },
  };
}

/** 一份會呼叫 `exit_plan_mode`、獲准之後再收工的腳本。 */
function planScript(): ScriptedChatModel {
  return new ScriptedChatModel({
    turns: [
      {
        content: '我先規劃。',
        toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: '# 計劃\n\n先看再改。' } }],
      },
      { content: '開始動手。' },
    ],
  });
}

/**
 * 跑一輪真組裝，回傳這兩個量湊成的一行。
 *
 * **兩個量一起回、不分開斷言**，是因為它們講的是同一件事的兩半：停下來問了沒、以及計劃
 * 模式最後是開是關。分開斷言時失敗訊息只講得出其中一半。
 *
 * 每一組**自己建一份 `ScriptedChatModel`**：三組吃掉的輪次不一樣（control 停在中斷，第二
 * 輪根本沒被用到；permissive-first 把工具跑完，第二輪被吃掉），共用一份會讓後跑的那組拿到
 * 一個已經被吃掉輪次的腳本。
 */
async function measure(plugins: readonly NexusPlugin[], threadId: string): Promise<string> {
  const { agent, dispose } = await createNexusAgent({
    model: planScript(),
    checkpointer: new MemorySaver(),
    plugins: [...plugins],
  });
  try {
    const result = await agent.invoke(toAgentInvocation('幫我改一下。'), {
      configurable: { thread_id: threadId },
    });
    const active = (result as Record<string, unknown>)[PLAN_MODE_STATE_KEY];
    return `interrupt=${result.__interrupt__ !== undefined} planModeActive=${String(active)}`;
  } finally {
    await dispose();
  }
}

/**
 * 三組對照，**釘住今天的實際值**。
 *
 * ## 第二行釘的是我們剛剛判定為危險的行為，這是故意的
 *
 * `permissive-first` 那一行**不是期望的行為**，是 characterization——把現況釘成一句可執行的
 * 話。**不要把它「修」成你以為應該的樣子**：它綠著代表機制沒變，它紅了代表有人建了那一層、
 * 或改了 waterfall 的短路語義，**那正是回來重讀 #199 與 #198 的時刻**。
 *
 * 真的建了之後，**這三行反過來寫就是那件事的驗收句**（絆索要翻面不要刪）：屆時
 * `permissive-first` 該與另外兩行一模一樣。
 *
 * ## 為什麼要有第三行
 *
 * `plan-first` 是**對調**，不是刪掉。刪掉寬鬆那位只證明「它不能省」；**對調才證明是順序在
 * 決定**——同一組 plugin、同一份腳本，只換排列，結局就從「沒人看過計劃」變回「停下來等人」。
 */
const ROWS = [
  {
    label: 'control：只有 plan-mode',
    threadId: 'gate-order-control',
    plugins: () => [createPlanModePlugin({ startActive: true })],
    outcome: 'interrupt=true planModeActive=true',
  },
  {
    label: 'permissive-first：寬鬆 gate 排在 plan-mode 之前',
    threadId: 'gate-order-permissive-first',
    plugins: () => [permissiveGatePlugin(), createPlanModePlugin({ startActive: true })],
    // **刻意的**：計劃被批准了，而沒有任何人看過它。見上面那段 JSDoc。
    outcome: 'interrupt=false planModeActive=false',
  },
  {
    label: 'plan-first：同一組人，只把順序對調',
    threadId: 'gate-order-plan-first',
    plugins: () => [createPlanModePlugin({ startActive: true }), permissiveGatePlugin()],
    outcome: 'interrupt=true planModeActive=true',
  },
] as const;

describe('核准 waterfall 的順序決定計劃有沒有被人看過', () => {
  it.each(ROWS.map((row) => [row.label, row] as const))('%s', async (_label, row) => {
    expect(await measure(row.plugins(), row.threadId)).toBe(row.outcome);
  });
});
