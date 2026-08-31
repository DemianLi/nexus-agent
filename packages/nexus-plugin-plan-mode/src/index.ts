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
 * 對讀日期 2026-08-31，dsh `0a53fb55bea101816fa226bb964ae2bed71c343b`。
 *
 * ## 三個零件，照 dsh 的分工
 *
 * | 零件 | dsh | 這裡 |
 * | --- | --- | --- |
 * | 指引 | `plan:policy` 提示詞段落，順序 500，未激活不貢獻文本 | {@link PLAN_MODE_MIDDLEWARE_NAME} 的 `wrapModelCall`，未啟用時原樣穿過 |
 * | 退出工具 | `exit_plan_mode`，兩種狀態都在 schema 裡，模式外執行會失敗 | {@link EXIT_PLAN_MODE_TOOL_NAME}，同樣一律註冊、模式外拒絕 |
 * | 模式狀態 | `plan/mode` 會話事件 ＋ `planProjectionDefinition` 這個帶版本的會話投影 | middleware 的 `stateSchema` ＋ checkpointer——**見下面的偏離** |
 *
 * ## 偏離：模式狀態不走事件日誌
 *
 * **上游在 2026-08-31 那次同步裡把這一塊換掉了，而換的方向讓這條偏離更遠不是更近。**
 * `foldPlanMode` 與 `planModeAtLastHeader` 兩個純函式已經刪掉，取代它們的是
 * `planProjectionDefinition`（`key: 'plan'`、`stateVersion: 3`、帶 `stateSchema` 與
 * `wire.view`）；`PlanModeController` 的 `static inject` 也從 `['tools','systemPrompt']`
 * 變成 `['tools','systemPrompt','sessionProjections']`——投影從可選子節點升成硬相依。
 * 也就是說 dsh 走的是「日誌是唯一真相、投影是它帶版本的快取」，我們的 checkpointer
 * 是**另一份真相**。下面那段結論不變，變的只是它對照的那個形狀。
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
 * ## 開啟路徑：`/plan`
 *
 * 上一版沒有開啟路徑，唯一的開關是 {@link PlanModePluginOptions.startActive}。
 * [#120](https://github.com/DemianLi/nexus-agent/issues/120) 補上了 dsh 的那一個：
 * `/plan` 進、`/plan off` 出，走 [#118](https://github.com/DemianLi/nexus-agent/issues/118)
 * 落地的 `registry.commands` 通道。
 *
 * ### 偏離：命令改的是 state，而 state 只有 invoke 期間寫得動
 *
 * dsh 的 handler 當場就把選擇寫死（`session.append('plan/mode', { active })`）——它的
 * 模式狀態是日誌事件，命令那一側寫得動。我們的模式狀態在 graph state 裡，而
 * **LangGraph JS 沒有「在 invoke 之外寫 state」這件事**：handler 跑在圖外面，`Command`
 * 只有工具與節點回得出來。
 *
 * 所以退到最接近的實作：**plugin 內持一格 pending intent，middleware 的 `beforeAgent`
 * 在下一次 invoke 開頭把它交成 state update**。`beforeAgent` 是 dsh 那個
 * `agent/pre-step` 邊界提交的對應物，形狀是同一個。
 *
 * **這個退法丟掉了什麼**：dsh 的 `committed` 是「已經持久化了」，我們的 `committed`
 * 是「從下一輪起生效」。序列的 REPL 裡兩者分不出來——命令一定跑在兩輪之間，沒有任何
 * 觀察窗看得見模式還沒翻。**除非下一輪永遠不來**：那時人看到的「計劃模式開了」真的
 * 沒有落地過。這是這個退法誠實的殘餘。
 *
 * 順著同一個理由，那一格 **`pending` 是交出去之後才清的，不是送出的當下**——照 dsh
 * 的原話「Delete only after append succeeds so a failed durable write leaves the
 * selection retryable, not dropped.」：下一次觀察到 state 真的等於它，才算落地。
 *
 * ### 三值，不是 dsh 的四值
 *
 * dsh 的 `set()` 回 `committed` / `queued` / `cancelled` / `noop`。**`queued` 沒有指涉
 * 物**：它是「輪還開著」時的結果，而我們的 REPL 一行一輪、執行器也是一次一個，命令
 * 永遠跑在兩輪之間。另外三個都到得了——`cancelled` 是 `/plan` 之後緊接著 `/plan off`
 * （中間沒有一輪），`noop` 是同一個方向按第二次。
 *
 * 順帶省掉的是 dsh 在 `noop` 分支裡那段 `loggedActive` 的再確認：它要那段，是因為
 * `queued` 存在時「已經是那個狀態」與「已經排隊要變成那個狀態」在措辭上必須分開。
 *
 * ### 兩件沒做的，也是偏離
 *
 * - **`/plan <message>`**：dsh 收自由訊息，用 `agent.steer()` 把它插進對話。
 *   deepagents / LangChain JS / LangGraph JS 沒有「從圖外插一則訊息進下一輪」的表達；
 *   在 `CommandResult` 上加一格 steer 又會弄糊 `command/done` 的語意，以及
 *   `@nexus/plugin-commands` 配套入口那條序列性規則。所以 {@link PLAN_COMMAND_HINT}
 *   是 `[off]`——收不下的東西不寫進提示。
 * - **`input.images`**：dsh 的命令收圖片附件，我們沒有 attachment store
 *   （`@nexus/core` 的 `commands.ts` 已經記著這一格是缺不是省）。
 */

import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type { AgentMiddleware, CommandResult, NexusPlugin, PluginRegistry } from '@nexus/core';
import { createMiddleware } from 'langchain';
import { z } from 'zod';

import {
  parsePlanCommandArgs,
  PLAN_ALREADY_ACTIVE_MESSAGE,
  PLAN_ALREADY_INACTIVE_MESSAGE,
  PLAN_ARGS_ERROR_MESSAGE,
  PLAN_COMMAND_DESCRIPTION,
  PLAN_COMMAND_HINT,
  PLAN_COMMAND_NAME,
  PLAN_ENTER_CANCELLED_MESSAGE,
  PLAN_ENTERED_MESSAGE,
  PLAN_LEAVE_CANCELLED_MESSAGE,
  PLAN_LEFT_MESSAGE,
} from './command.js';

// `/plan` 的詞彙是這個套件的公開介面的一部分（測試與組裝點都讀得到），所以整段轉出去。
export * from './command.js';

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
   * **[#120](https://github.com/DemianLi/nexus-agent/issues/120) 之後這個風險換了形狀，
   * 沒有消失。** `/plan off` 是那條路了——但它只在**打得到命令的入口**存在，也就是
   * CLI 的 REPL；`serve.ts` 那條線上還沒有命令介面（見檔頭的非目標）。所以在 CLI 把
   * `startActive` 打開仍然是拿不到核准、只能靠 `/plan off` 自己爬出來，而在 web 上
   * 打開則仍然是「提了計劃、有人按批准」那條正路。
   *
   * 這個選項今天的用途因此還是那兩個：**測試**要走真的那條路而不是直接戳 state，
   * 以及 **`serve.ts` 那種真的按得下去的入口**。
   */
  readonly startActive?: boolean;
}

/** 這一次呼叫在 middleware 眼裡的形狀。基座的型別是泛的，這裡只取用得到的欄位。 */
interface PlanModeState {
  readonly [PLAN_MODE_STATE_KEY]?: boolean;
}

/** 一次 `/plan` 的結果。**三個值，沒有 `queued`**——理由見檔頭。 */
export type PlanModeSelection = 'committed' | 'cancelled' | 'noop';

/** `beforeAgent` 交出去的那筆 state update。 */
type PlanModeUpdate = { readonly [PLAN_MODE_STATE_KEY]: boolean };

/**
 * 命令與 middleware 之間的那一格。
 *
 * 它存在的唯一理由是**兩邊不在同一個世界**：`/plan` 的 handler 跑在圖外面、寫不動
 * state，middleware 跑在圖裡面、讀得到也寫得動。這一格是它們唯一的接觸面。
 *
 * 兩個欄位各自回答一個問題：`committed` 是「上次看到 state 的時候它是什麼」，
 * `pending` 是「人選了什麼但還沒交出去」。**`active()` 是 `pending ?? committed`**，
 * 所以指引在選擇的那一刻就生效，不必等 `beforeAgent` 的 update 落地——這讓提示詞
 * 不依賴「同一次 invoke 裡 update 看不看得到」這個我們沒有保證的東西。
 */
interface PlanModeCell {
  /**
   * 選一個方向。
   * @param active - 要不要在計劃模式裡。
   * @returns 這一次選擇的結果。
   */
  select(active: boolean): PlanModeSelection;
  /**
   * 把 state 的實況吃回來。**每一個看得到 state 的 hook 都要叫**——`exit_plan_mode`
   * 在輪中途把模式關掉時，只有這件事讓那一格知道。
   * @param state - 這一刻的 agent state。
   */
  observe(state: PlanModeState): void;
  /** 這一刻該不該當作在計劃模式裡。 */
  active(): boolean;
  /** 還沒交出去的選擇，沒有時是 `undefined`。 */
  pendingUpdate(): PlanModeUpdate | undefined;
}

/**
 * 造那一格。
 *
 * **`pending` 是觀察到 state 真的等於它才清的，不是送出的當下。** 照 dsh 的
 * 「Delete only after append succeeds」：送出去而沒落地時，下一次 `beforeAgent` 會
 * 再送一次，而不是把人的選擇靜靜丟掉。
 *
 * @param startActive - `stateSchema` 的初值，也就是還沒看過 state 之前的 `committed`。
 * @returns 這一次組裝專屬的那一格。
 */
function createPlanModeCell(startActive: boolean): PlanModeCell {
  let committed = startActive;
  let pending: boolean | undefined;

  return {
    select(active) {
      const target = pending ?? committed;
      if (active === target) return 'noop';
      if (active === committed) {
        // 有一個反向的選擇還沒交出去，而人又選回來了——把它收回來就好。
        pending = undefined;
        return 'cancelled';
      }
      pending = active;
      return 'committed';
    },
    observe(state) {
      const observed = state[PLAN_MODE_STATE_KEY];
      if (observed === undefined) return;
      committed = observed;
      if (pending === observed) pending = undefined;
    },
    active() {
      return pending ?? committed;
    },
    pendingUpdate() {
      return pending === undefined ? undefined : { [PLAN_MODE_STATE_KEY]: pending };
    },
  };
}

/**
 * 跑一次 `/plan`。
 *
 * **參數不合法回 `error`，不是「不認得就當成進入」**：安靜吞掉打錯的參數，會讓
 * `/plan of` 看起來成功了而其實做了相反的事。這條關係同時是這個套件配套入口檢的那一條
 * （見 `invariant.ts`）。
 *
 * @param cell - 這次組裝的那一格。
 * @param rawInput - 命令名之後的原文。
 * @returns 直接印給人看的結果。
 */
function planCommandResult(cell: PlanModeCell, rawInput: string): CommandResult {
  const request = parsePlanCommandArgs(rawInput);
  if (request === undefined) return { kind: 'error', text: PLAN_ARGS_ERROR_MESSAGE };
  const entering = request === 'enter';
  switch (cell.select(entering)) {
    case 'committed':
      return { kind: 'success', text: entering ? PLAN_ENTERED_MESSAGE : PLAN_LEFT_MESSAGE };
    case 'cancelled':
      return {
        kind: 'success',
        text: entering ? PLAN_LEAVE_CANCELLED_MESSAGE : PLAN_ENTER_CANCELLED_MESSAGE,
      };
    case 'noop':
      return {
        kind: 'success',
        text: entering ? PLAN_ALREADY_ACTIVE_MESSAGE : PLAN_ALREADY_INACTIVE_MESSAGE,
      };
  }
}

/**
 * 造計劃模式的 middleware。
 *
 * 五件事在同一個 middleware 裡，因為它們共用同一個 state key：
 *
 * 1. **`stateSchema`** 宣告 {@link PLAN_MODE_STATE_KEY}，由 checkpointer 持久化。
 * 2. **`beforeAgent`** 把 `/plan` 選好而還沒落地的那一個交成 state update。**這是
 *    dsh `agent/pre-step` 邊界提交的對應物**，見檔頭那條偏離。
 * 3. **`wrapModelCall`** 在模式生效時把指引接到 system prompt **後面**。
 *    用 `concat` 不用取代——`@nexus/plugin-memory` 與基座的摘要器都在同一份
 *    system prompt 上加東西，取代會把它們吃掉（`dynamicSystemPromptMiddleware`
 *    正是取代，所以刻意不用它）。模式沒生效時原樣穿過，**一個 token 都不多**。
 * 4. **`wrapToolCall`** 擋掉模式外的 `exit_plan_mode`。
 * 5. **`afterAgent`** 把一輪跑完之後的 state 吃回那一格。少了它，`exit_plan_mode`
 *    在輪中途把模式關掉之後，下一次 `/plan off` 會回「關了」而不是「本來就沒開」。
 *
 * **每一個看得到 state 的 hook 都先 `observe`。** 那一格是圖外的人唯一的視角，而它
 * 只有在這些點上看得見真相。
 *
 * @param guidance - 模式生效時夾的那一段。
 * @param startActive - state 的初值。
 * @param cell - 命令與這個 middleware 之間的那一格。
 * @returns 可以交給 `registry.middleware.use()` 的 middleware。
 */
function createPlanModeMiddleware(
  guidance: string,
  startActive: boolean,
  cell: PlanModeCell,
): AgentMiddleware {
  return createMiddleware({
    name: PLAN_MODE_MIDDLEWARE_NAME,
    stateSchema: z.object({
      [PLAN_MODE_STATE_KEY]: z.boolean().default(startActive),
    }),
    beforeAgent: (state) => {
      cell.observe(state as PlanModeState);
      return cell.pendingUpdate();
    },
    afterAgent: (state) => {
      cell.observe(state as PlanModeState);
      return undefined;
    },
    wrapModelCall: (request, handler) => {
      cell.observe(request.state as PlanModeState);
      if (!cell.active()) return handler(request);
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
      cell.observe(request.state as PlanModeState);
      if (cell.active()) return handler(request);
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
 * 五個註冊點，各有各的理由：
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
 * - **`commands`**：`/plan` 走 `registry.commands.register()`。**命令不進模型**——它是
 *   人對工具說的話，結果直接印給打字的人看。dsh 那邊這一格掛在
 *   `ctx.inject(['commands'], …)` 底下（「命令註冊表被組進來時才啟用」），我們的
 *   `PluginRegistry` 每個註冊點永遠都在，所以直接註冊；**這是形狀差異不是偏離**，
 *   理由已經寫在 `@nexus/core` 的 `CommandRegistrationPoint` 上。
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
      // **這一格活在 `apply` 裡，不在 `createPlanModePlugin` 裡。** `load.ts` 一次組裝
      // 呼叫一次 `plugin.apply(tracked)`，所以放這裡就是一組裝一格。放到工廠函式的
      // 閉包裡的話，同一個 plugin 物件被兩次組裝共用時兩邊會串台——**而且串台不會拋**，
      // 只會讓其中一邊的 `/plan` 莫名其妙回「已經在計劃模式裡了」。
      const cell = createPlanModeCell(startActive);

      registry.capabilities.provide(PLAN_MODE_CAPABILITY);
      registry.middleware.use(createPlanModeMiddleware(guidance, startActive, cell), {
        prepend: true,
      });
      registry.tools.register(createExitPlanModeTool());
      registry.commands.register({
        name: PLAN_COMMAND_NAME,
        description: PLAN_COMMAND_DESCRIPTION,
        input: { hint: PLAN_COMMAND_HINT },
        handler: ({ rawInput }) => planCommandResult(cell, rawInput),
      });
      registry.approvals.gate((exec, next) =>
        exec.name === EXIT_PLAN_MODE_TOOL_NAME
          ? { kind: 'ask', reason: '計劃要有人看過才算獲准' }
          : next(),
      );
    },
  };
}
