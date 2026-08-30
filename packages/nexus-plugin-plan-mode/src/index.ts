/**
 * `@nexus/plugin-plan-mode`——計劃模式：先探索與設計，把完成的計劃交出去等人批准。
 *
 * 這個套件的來歷不太一樣：它不是從我們的計劃書長出來的，是**從 dsh 長出來的**。
 * [#16](https://github.com/DemianLi/nexus-agent/issues/16) 原本列的兩個強化方向
 * （每步多一次 LLM 呼叫的自我批判、顯式意圖分類）在 dsh 全樹**都不存在**——
 * `reflection` 的命中全是 TypeScript 型別反射，`intent classif` 零命中。它對「先想
 * 再做」的答案是**計劃模式**（`packages/plan/plan-mode/`），配上 todo 與 goal：
 * 讓模型自己承擔規劃、把狀態外顯，人可以介入。`TodoListMiddleware` 已經蓋掉 todo
 * 那塊，計劃模式這塊我們一片空白，所以補的是這一塊。細節見
 * [#116](https://github.com/DemianLi/nexus-agent/issues/116)。
 *
 * 對讀日期 2026-08-30，dsh `cd5ef8148158c3a752a658978873241fdf8e2bbc`。
 *
 * ## 三個零件，照 dsh 的分工
 *
 * | 零件 | dsh | 這裡 |
 * | --- | --- | --- |
 * | 指引 | `plan:policy` 提示詞段落，順序 500，未激活不貢獻文本 | {@link PLAN_MODE_MIDDLEWARE_NAME} 的 `wrapModelCall`，未啟用時原樣穿過 |
 * | 退出工具 | `exit_plan_mode`，兩種狀態都在 schema 裡，模式外執行會失敗 | {@link EXIT_PLAN_MODE_TOOL_NAME}，同樣一律註冊、模式外拒絕 |
 * | 模式狀態 | `plan/mode` 只記日誌的會話事件 ＋ `foldPlanMode` 純折疊 | middleware 的 `stateSchema` ＋ checkpointer——**見下面的偏離** |
 *
 * ## 偏離：模式狀態不走事件日誌
 *
 * **表達不出來的是 dsh 那個特定形狀，不是「持久的模式狀態」本身。** LangGraph JS 原生
 * 就做這件事：`AgentMiddleware.stateSchema` 的文件明寫 “Middleware state is persisted
 * between multiple invocations”。走不了 dsh 那條的原因是水管：
 *
 * - **plugin 拿不到 `SessionLog`。** 它活在入口層（`apps/harness` 的 `cli.ts`、
 *   `wire-handler.ts`、`thread-pump.ts`），十二個註冊點沒有一個通到它——`lifecycle`
 *   只管關機，`telemetry` 是出口不是入口。
 * - **`SessionEventType` 是 `@nexus/core` 的封閉 union**，沒有 dsh 那種宣告合併，而
 *   [#101](https://github.com/DemianLi/nexus-agent/issues/101) 已經明文把「加會話事件
 *   種類」排除在包自有不變量之外。
 *
 * 所以退到最接近的實作：`stateSchema` ＋ checkpointer。**這個退法丟掉了什麼**——
 * dsh 用純折疊換到的是「恢復、fork、壓縮都不必即時鏡像就還原得回來」，checkpointer
 * 換不到同一份保證：`eval/runner.ts` 根本沒有 checkpointer（state 在兩次 invoke 之間
 * 不留），CLI 與 `serve.ts` 是 `MemorySaver`（process 內，重啟就沒）。
 * 壓縮那一條有測試釘著（`apps/harness/src/plan-mode.test.ts`），另外兩條是入口層的
 * 事實，不是這個套件補得掉的。
 *
 * ## 這個套件預設是惰性的
 *
 * 沒有開啟路徑——`/plan` 那種命令要先有 CLI 的 command 註冊機制（今天 `cli.ts` 只有
 * 一句硬編碼的 `text === '/exit'`），那是另一張卡。所以唯一的開關是
 * {@link PlanModePluginOptions.startActive}，而它的預設是關。
 */

import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type { AgentMiddleware, NexusPlugin, PluginRegistry } from '@nexus/core';
import { createMiddleware } from 'langchain';
import { z } from 'zod';

/** 這個 plugin 宣告的能力名。要相依它的 plugin 把這個字串放進自己的 `requires`。 */
export const PLAN_MODE_CAPABILITY = 'plan-mode';

/** 註冊出來的工具名。組裝點要把它排進 `toolOrder` 時用得到。 */
export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode';

/** middleware 的名字。**同名會取代基座 stack 裡的同名者**，所以帶著前綴。 */
export const PLAN_MODE_MIDDLEWARE_NAME = 'nexusPlanMode';

/**
 * 模式狀態在 agent state 裡的 key。
 *
 * **匯出它是為了測試與未來的開啟路徑**，不是給別人隨手改的：這個 key 由
 * {@link PLAN_MODE_MIDDLEWARE_NAME} 的 `stateSchema` 宣告，沒掛這個 plugin 時它不存在。
 */
export const PLAN_MODE_STATE_KEY = 'planModeActive';

/**
 * 沒給 `guidance` 時夾進 system prompt 的那一段。
 *
 * 照 dsh 的範例段落（`packages/plan/plan-mode/README.zh.md` 的配置示例）改寫：說清楚
 * 現在在計劃模式、先探索與設計、完成後經 `exit_plan_mode` 交出去。**它是部署持有的**，
 * 所以是一個可以整段換掉的預設值而不是寫死的字串。
 */
export const DEFAULT_PLAN_GUIDANCE =
  '你現在在計劃模式。先探索與設計，不要動手改東西；' +
  `計劃完成後用 ${EXIT_PLAN_MODE_TOOL_NAME} 把完整的計劃交出去等人批准。`;

/**
 * `exit_plan_mode` 給模型看的描述。
 *
 * 照 dsh 的 schema（`docs/tool-catalog.zh.md` 的 `@deepseek-ai/dsh-plan-mode` 條目）：
 * 只在計劃模式下用、送完整的 markdown、以一個為計劃命名的 `#` 標題開頭、被要求繼續
 * 規劃時反饋會從工具結果回來。
 */
export const EXIT_PLAN_MODE_DESCRIPTION =
  '只在計劃模式下使用。提交計劃供人評審，獲准後離開計劃模式。' +
  '送完整的 Markdown 計劃，以一個為計劃命名的 # 標題開頭。' +
  '對方可以批准（從你的下一步起執行），也可以要求你繼續規劃——' +
  '那時反饋會從這個工具的結果回來，改完再提交一次。';

/** 模式外呼叫 `exit_plan_mode` 時回給模型的話。 */
export const NOT_IN_PLAN_MODE_MESSAGE = `現在不在計劃模式，${EXIT_PLAN_MODE_TOOL_NAME} 沒有東西可以離開，所以沒有執行。`;

/** 計劃被批准、離開計劃模式時回給模型的話。 */
export const PLAN_APPROVED_MESSAGE = '計劃已獲准，計劃模式關閉了。從下一步起可以執行。';

export interface PlanModePluginOptions {
  /**
   * 計劃模式生效時夾進 system prompt 的指引。省略即 {@link DEFAULT_PLAN_GUIDANCE}。
   *
   * **它是部署持有的原樣文本**，照 dsh：這個套件不替部署決定要怎麼講話。
   */
  readonly guidance?: string;
  /**
   * 這個組裝一開始就在計劃模式裡嗎。省略即**否**。
   *
   * **在收不了核准決定的入口把它打開，等於把那一輪鎖死。** `exit_plan_mode` 是需要
   * 核准的工具，而 CLI 與 `eval/runner.ts` 傳的是 `HEADLESS_APPROVALS`
   * （[#113](https://github.com/DemianLi/nexus-agent/issues/113)），核准閘門在那裡
   * 走 `policy-never`、確定性地拒絕。於是模型提了計劃、被拒、還在計劃模式，
   * 而它**沒有第二條路出去**——今天沒有任何開啟／關閉的命令。整輪只剩指引。
   *
   * 所以這個選項今天的用途有兩個，都不是「在 CLI 上跑起來」：**測試**要走真的那條路
   * 而不是直接戳 state，以及 **`serve.ts` 那種真的按得下去的入口**。
   */
  readonly startActive?: boolean;
}

/** 這一次呼叫在 middleware 眼裡的形狀。基座的型別是泛的，這裡只取用得到的欄位。 */
interface PlanModeState {
  readonly [PLAN_MODE_STATE_KEY]?: boolean;
}

/**
 * 造計劃模式的 middleware。
 *
 * 三件事在同一個 middleware 裡，因為它們共用同一個 state key：
 *
 * 1. **`stateSchema`** 宣告 {@link PLAN_MODE_STATE_KEY}，由 checkpointer 持久化。
 * 2. **`wrapModelCall`** 在模式生效時把指引接到 system prompt **後面**。
 *    用 `concat` 不用取代——`@nexus/plugin-memory` 與基座的摘要器都在同一份
 *    system prompt 上加東西，取代會把它們吃掉（`dynamicSystemPromptMiddleware`
 *    正是取代，所以刻意不用它）。模式沒生效時原樣穿過，**一個 token 都不多**。
 * 3. **`wrapToolCall`** 擋掉模式外的 `exit_plan_mode`。
 *
 * @param guidance - 模式生效時夾的那一段。
 * @param startActive - state 的初值。
 * @returns 可以交給 `registry.middleware.use()` 的 middleware。
 */
function createPlanModeMiddleware(guidance: string, startActive: boolean): AgentMiddleware {
  return createMiddleware({
    name: PLAN_MODE_MIDDLEWARE_NAME,
    stateSchema: z.object({
      [PLAN_MODE_STATE_KEY]: z.boolean().default(startActive),
    }),
    wrapModelCall: (request, handler) => {
      const state = request.state as PlanModeState;
      if (state[PLAN_MODE_STATE_KEY] !== true) return handler(request);
      // 兩條路是同一件事的兩個入口：`systemMessage` 在的時候接在它後面，不在的時候
      // 由 `systemPrompt` 這個字串欄位承接。基座兩個都讀，給錯那一個等於沒講。
      const { systemMessage } = request;
      return handler(
        systemMessage === undefined
          ? { ...request, systemPrompt: guidance }
          : { ...request, systemMessage: systemMessage.concat(`\n${guidance}`) },
      );
    },
    wrapToolCall: (request, handler) => {
      const call = request.toolCall as { name?: string; id?: string };
      if (call.name !== EXIT_PLAN_MODE_TOOL_NAME) return handler(request);
      const state = request.state as PlanModeState;
      if (state[PLAN_MODE_STATE_KEY] === true) return handler(request);
      return new Command({
        update: {
          messages: [
            {
              type: 'tool',
              content: NOT_IN_PLAN_MODE_MESSAGE,
              tool_call_id: call.id ?? '',
            },
          ],
        },
      });
    },
  }) as AgentMiddleware;
}

/**
 * 造 `exit_plan_mode` 工具。
 *
 * **它只會被呼叫到一次成功的路徑**：模式外的呼叫在 middleware 的 `wrapToolCall` 就
 * 被擋掉了，需要核准這件事則由核准閘門處理。所以這裡剩下的只有「關掉模式、回一句話」。
 *
 * 回的是 `Command` 而不是字串：這是 LangGraph 原生的「工具改狀態」，`update` 裡同時
 * 帶 state 的新值與這次呼叫的 `ToolMessage`。**`ToolMessage` 不能省**——少了它，
 * 那個 `tool_call` 永遠沒有回覆，下一輪的訊息序列是壞的。
 *
 * @returns 可以交給 `registry.tools.register()` 的工具。
 */
function createExitPlanModeTool(): StructuredTool {
  // `as unknown as StructuredTool`：回 `Command` 的工具，`tool()` 推出來的回傳型別參數
  // 是那個 `Command` 的具體形狀，對不上 registry 收的泛型 `StructuredTool`。這是型別
  // 推斷的縫，不是行為的縫——`Command` 是 LangGraph 明文支援的工具回傳值。
  return tool(
    (_args: { plan: string }, config: { toolCall?: { id?: string } }) =>
      new Command({
        update: {
          [PLAN_MODE_STATE_KEY]: false,
          messages: [
            {
              type: 'tool',
              content: PLAN_APPROVED_MESSAGE,
              tool_call_id: config.toolCall?.id ?? '',
            },
          ],
        },
      }),
    {
      name: EXIT_PLAN_MODE_TOOL_NAME,
      description: EXIT_PLAN_MODE_DESCRIPTION,
      schema: z.object({
        plan: z.string().describe('完整的計劃，Markdown，以一個為計劃命名的 # 標題開頭。'),
      }),
    },
  ) as unknown as StructuredTool;
}

/**
 * 建一個計劃模式 plugin。
 *
 * 四個註冊點，各有各的理由：
 *
 * - **`capabilities`**：讓別人 `requires` 得到。
 * - **`middleware`（`prepend: true`）**：**排在核准閘門之前是必要的，不是偏好。**
 *   `fold.ts` 的順序是「`prepend` 的在前、核准閘門接著、其餘依註冊順序」，所以不
 *   `prepend` 的話，一次模式外的 `exit_plan_mode` 會先撞上核准閘門——headless 入口
 *   回的是「沒有人被問到」，而真正的原因是「你不在計劃模式」。順序決定模型看到哪一句。
 * - **`tools`**：`exit_plan_mode` 走 `registry.tools.register()`，**不用
 *   `AgentMiddleware` 自帶的 `tools`**。那條路繞過 `toolOrder`——`fold.ts` 的
 *   `orderTools` 只排 `registry.tools.effective()` 裡的東西，而工具呈現順序是我們
 *   自建的機制（dsh 那邊註冊順序造成過真實 CI flake），繞過它等於把那個保護放掉。
 * - **`approvals.gate`**：`exit_plan_mode` 回 `ask`。**「人批准計劃」與「人批准這次
 *   工具呼叫」是同一件事**，所以不另建一套評審通道——接回
 *   [#113](https://github.com/DemianLi/nexus-agent/issues/113) 已經有的那個：web 按得
 *   下去，CLI 與 eval 走 `policy-never`。
 *
 * **工具一律註冊，不看 `startActive`。** 照 dsh：模式沒啟用時 `exit_plan_mode` 仍然
 * 留在面向模型的 schema 裡，「這樣狀態轉換不會在規劃策略變更之外額外造成工具目錄變動」。
 * 代價是 `startActive: false` 的組裝裡它是活的 schema、死的執行路徑。
 *
 * @param options - 見 {@link PlanModePluginOptions}。
 * @returns 可以放進組裝點清單的 plugin。
 */
export function createPlanModePlugin(options: PlanModePluginOptions = {}): NexusPlugin {
  const guidance = options.guidance ?? DEFAULT_PLAN_GUIDANCE;
  const startActive = options.startActive ?? false;

  return {
    name: 'plan-mode',
    apply(registry: PluginRegistry): void {
      registry.capabilities.provide(PLAN_MODE_CAPABILITY);
      registry.middleware.use(createPlanModeMiddleware(guidance, startActive), {
        prepend: true,
      });
      registry.tools.register(createExitPlanModeTool());
      registry.approvals.gate((exec, next) =>
        exec.name === EXIT_PLAN_MODE_TOOL_NAME
          ? { kind: 'ask', reason: '計劃要有人看過才算獲准' }
          : next(),
      );
    },
  };
}
