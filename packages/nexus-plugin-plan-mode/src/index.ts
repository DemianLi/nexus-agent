/**
 * `@nexus/plugin-plan-mode`——計劃模式：先探索與設計，把完成的計劃交出去等人批准。
 *
 * 這個套件的來歷不太一樣：它不是從我們的計劃書長出來的，是**從 dsh 長出來的**。
 * [#16](https://github.com/DemianLi/nexus-agent/issues/16) 原本列的兩個強化方向
 * （每步多一次 LLM 呼叫的自我批判、顯式意圖分類）在 dsh 全樹**都不存在**——
 * `reflection` 的命中全是 TypeScript 型別反射，`intent classif` 零命中。它對「先想
 * 再做」的答案是**計劃模式**（`packages/plan/plan-mode/`），配上 todo 與 goal：
 * 讓模型自己承擔規劃、把狀態外顯，人可以介入。三件裡我們一件都沒有，所以先補的是這
 * 一件。細節見 [#116](https://github.com/DemianLi/nexus-agent/issues/116)。
 *
 * **這裡原本寫的是「`TodoListMiddleware` 已經蓋掉 todo 那塊」，那句話是假的。**
 * 基座的預設 middleware stack 不帶 todo（`apps/harness/src/baseline.test.ts` 第一條的
 * 全集斷言裡沒有 `write_todos`），`todoListMiddleware` 得自己掛。那句話是承重的——它在
 * 論證「所以補的是計劃模式這塊」——但前提錯了不影響結論：三件當時都缺。goal 由
 * [#126](https://github.com/DemianLi/nexus-agent/issues/126) 補上，todo 由
 * [#132](https://github.com/DemianLi/nexus-agent/issues/132) 補上（`@nexus/plugin-todo`，
 * 照 dsh 走會話事件而不是掛基座的 middleware）。
 *
 * 對讀日期 2026-09-12，dsh `d347e703908d0406b7a7ef80e3a0e594d86b2215`。
 *
 * ## 三個零件，照 dsh 的分工
 *
 * | 零件 | dsh | 這裡 |
 * | --- | --- | --- |
 * | 指引 | `plan:policy` 提示詞段落，順序 500，未激活不貢獻文本 | {@link PLAN_MODE_MIDDLEWARE_NAME} 的 `wrapModelCall`，未啟用時原樣穿過 |
 * | 退出工具 | `exit_plan_mode`，兩種狀態都在 schema 裡，模式外執行會失敗 | {@link EXIT_PLAN_MODE_TOOL_NAME}，同樣一律註冊、模式外拒絕 |
 * | 模式狀態 | `plan/mode` 會話事件 ＋ `planProjectionDefinition` 這個帶版本的會話投影 | `plan/mode` 會話事件 ＋ 這個 plugin 在 root 那份日誌上的折疊 |
 *
 * ## 模式狀態走事件日誌——原本的偏離，收回了
 *
 * **這一格曾經是一條登記過的偏離**：模式狀態住在 middleware 的 `stateSchema` 裡，由
 * checkpointer 持久化。登記的理由換過兩次，兩次都被後來的東西消耗掉：
 *
 * - 第一版是「plugin 拿不到 `SessionLog`」。錯的——`invariants` 那條路交出的一直是一份
 *   可寫的日誌，[#127](https://github.com/DemianLi/nexus-agent/issues/127) 才把它收窄；
 *   而 [#126](https://github.com/DemianLi/nexus-agent/issues/126) 加的 `sessions` 通道，
 *   名字就說它交出可寫的日誌，goal 走的正是它。
 * - 第二版是「日誌耐久了，但沒有讀方」——[#173](https://github.com/DemianLi/nexus-agent/pull/173)
 *   讓日誌活過行程，[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的
 *   `--resume` 讀得回它。
 *
 * 最後那一件讓這條偏離有了看得見的代價：只開門 A 的話，重開之後沙箱模式回來、計劃模式
 * 悄悄回到關著——人選的兩個「比較嚴」的模式，一個留得住一個留不住。所以 #251 的第二刀
 * 把它搬回 dsh 的形狀：
 *
 * - **`plan/mode { active }`**，整份值不是切換，最後一顆就是答案。寫者兩個：`/plan`（人）
 *   與 `exit_plan_mode`（模型，計劃獲准之後）。**都只寫 root 那一份。**
 * - **折疊由這個 plugin 經 `registry.sessions` 接上 root 那份日誌**，同 `@nexus/plugin-goal`。
 *   接上的時候觀察面會先重播既有事件，所以續接回來的日誌折得出上一次最後的模式。
 * - **它不在 `session/end-seed` 歸零。** 那顆標記之前的開頭屬於上一個生命週期，讀「當前
 *   這一段」的人要在那裡重設；模式相反——跨重啟留得住正是它搬進日誌的理由。
 *
 * 退法丟掉過的東西也跟著回來了：`eval/runner.ts` 沒有 checkpointer、CLI 與 `serve.ts` 的
 * `MemorySaver` 重啟就沒，這些以前都讓模式留不住；模式住在日誌上之後，它們都碰不到它。
 * 壓縮那一條的測試照舊留著（`apps/harness/src/plan-mode.test.ts`）——它釘的是一句宣稱，
 * 不是一個機制。
 *
 * **與 dsh 仍然不一樣的地方**：dsh 的投影是 core 那一層帶版本的快取（`sessionProjections`），
 * 我們沒有那一層，折疊就寫在這個 plugin 裡——形狀差異，不是偏離，同 goal。
 *
 * ## 沒有日誌的組裝
 *
 * 模式住在日誌上，所以**沒接會話日誌的組裝寫不動它**：`/plan` 回
 * {@link PLAN_NOT_ATTACHED_MESSAGE}，`exit_plan_mode` 回 {@link PLAN_NOT_ATTACHED_TOOL_MESSAGE}，
 * 模式就停在 {@link PlanModePluginOptions.startActive} 那一格。CLI 與 `serve.ts` 都接線；
 * eval 不掛這個 plugin。
 *
 * ## 開啟路徑：`/plan`
 *
 * 上一版沒有開啟路徑，唯一的開關是 {@link PlanModePluginOptions.startActive}。
 * [#120](https://github.com/DemianLi/nexus-agent/issues/120) 補上了 dsh 的那一個：
 * `/plan` 進、`/plan off` 出，走 [#118](https://github.com/DemianLi/nexus-agent/issues/118)
 * 落地的 `registry.commands` 通道。
 *
 * **handler 當場就把選擇寫進日誌**（`log.append('plan/mode', { active })`），同 dsh。以前的
 * 形狀是「plugin 持一格 pending intent，下一次 `beforeAgent` 把它交成 state update」——那是
 * 模式住在 graph state 時的退法（LangGraph 沒有「在 invoke 之外寫 state」這件事），它誠實的
 * 殘餘是「人看到開了，而下一輪永遠不來的話它沒落地過」。模式搬進日誌之後那一格沒有存在的
 * 理由，跟著收掉了。
 *
 * **當場寫的前提是命令跑在兩輪之間。** dsh 在輪還開著時把選擇排著、到下一個
 * `agent/pre-step` 才提交，免得模式在一輪中間翻面。我們不需要那一格：REPL 一行一輪；
 * `serve.ts` 那條線的發派面在 run 飛在半空、停在核准點、或另一個命令在跑時一律拒收
 * （`apps/harness/src/wire-handler.ts` 的 `handleSlash`，
 * [#123](https://github.com/DemianLi/nexus-agent/issues/123)），絆索在
 * `apps/harness/src/slash-wire.test.ts`。那道閘哪天放寬成排隊，這裡就要長回 dsh 那一格。
 *
 * ### 兩值，不是 dsh 的四值
 *
 * dsh 的 `set()` 回 `committed` / `queued` / `cancelled` / `noop`。`queued` 與 `cancelled`
 * 都要「輪還開著、選擇排著還沒提交」才成立——`cancelled` 就是把排著的那一個收回來。命令
 * 永遠跑在兩輪之間、選擇當場提交，兩個都沒有指涉物。（上一版留著 `cancelled`：它那時指的是
 * 「pending intent 還沒被 `beforeAgent` 交出去」，那一格已經不在了。）所以 `/plan` 之後緊接著
 * `/plan off` 是兩次 `committed`，日誌上兩顆 `plan/mode`。
 *
 * ### 沒做的，也是偏離
 *
 * - **`/plan <message>`**：dsh 收自由訊息，用 `agent.steer()` 把它插進對話。
 *   deepagents / LangChain JS / LangGraph JS 沒有「從圖外插一則訊息進下一輪」的表達；
 *   在 `CommandResult` 上加一格 steer 又會弄糊 `command/done` 的語意，以及
 *   `@nexus/plugin-commands` 配套入口那條序列性規則。所以 {@link PLAN_COMMAND_HINT}
 *   是 `[off]`——收不下的東西不寫進提示。
 * - **切換的旁白**：dsh 在人切換模式、而上一份請求標頭描述的是另一個模式時，往對話裡插一句
 *   「The user switched this session to plan mode.」（`loggedActiveAtLastHeader`）。我們沒有
 *   `request/header` 這一顆，也沒有從圖外插訊息的路（同上一條）；模型從下一次請求的
 *   system prompt 看得出來——指引在或不在。
 * - **`input.images`**：dsh 的命令收圖片附件，我們沒有 attachment store
 *   （`@nexus/core` 的 `commands.ts` 已經記著這一格是缺不是省）。
 */

import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type {
  AgentMiddleware,
  CommandResult,
  NexusPlugin,
  PluginRegistry,
  SessionEvent,
  SessionLog,
  SessionSubject,
} from '@nexus/core';
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
  PLAN_ENTERED_MESSAGE,
  PLAN_LEFT_MESSAGE,
  PLAN_NOT_ATTACHED_MESSAGE,
  planAmbiguousMessage,
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

/**
 * 計劃獲准了，但這一份組裝沒接會話日誌，模式寫不下來。
 *
 * **不能回 {@link PLAN_APPROVED_MESSAGE}**：模式沒關，指引下一步還會在，回「關了」是在騙
 * 模型。也不能回 {@link NOT_IN_PLAN_MODE_MESSAGE}——它明明在計劃模式裡。
 */
export const PLAN_NOT_ATTACHED_TOOL_MESSAGE =
  '計劃獲准了，但計劃模式沒有接上會話日誌，模式關不掉。這是組裝的問題，不是計劃的問題。';

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
   * **日誌上一顆 `plan/mode` 都沒有時**，這個組裝在不在計劃模式裡。省略即**否**。
   *
   * 模式的真相在日誌上，這一格只是折疊的初值：一份新的會話從它起算，一份續接回來、但上一次
   * 從沒切過模式的會話（例如 v3 寫的檔）也從它起算；**一份日誌上有過 `plan/mode` 的會話，
   * 最後那一顆說了算，這一格管不到**。沒接會話日誌的組裝，模式就一直是這一格。
   *
   * **在收不了核准決定的入口把它打開，等於把那一輪鎖死。** `exit_plan_mode` 是需要
   * 核准的工具，而 CLI 與 `eval/runner.ts` 傳的是 `HEADLESS_APPROVALS`
   * （[#113](https://github.com/DemianLi/nexus-agent/issues/113)），核准閘門在那裡
   * 走 `policy-never`、確定性地拒絕。於是模型提了計劃、被拒、還在計劃模式，唯一出去的路是
   * 人打 `/plan off`（[#120](https://github.com/DemianLi/nexus-agent/issues/120)）。在 web 上
   * 打開則是「提了計劃、有人按批准」那條正路。
   *
   * **這個選項今天剩下的用途是測試**：要走真的那條路而不是直接往日誌裡寫。
   */
  readonly startActive?: boolean;
}

/**
 * 一份 root 日誌上的模式。
 *
 * `log` 是寫的那一份，`active()` 是讀的那一份——**兩者是同一份日誌**，讀的那一半是觀察面
 * 折出來的，所以 `append` 之後 `active()` 當場就是新的值（觀察面同步送，見
 * `@nexus/core` 的 `SessionSubject.observe`）。
 */
interface PlanModeSession {
  readonly log: SessionLog;
  active(): boolean;
}

/**
 * 從一串事件讀出最後一次的模式。
 *
 * 給讀日誌的人用——CLI 的續接披露、測試。**不看 `session/end-seed`**：模式跨得過那顆
 * 標記，理由見檔頭。
 *
 * @param events - 一份日誌的事件。
 * @returns 最後一顆 `plan/mode` 的值；一顆都沒有時是 `undefined`，由呼叫端決定初值。
 */
export function recordedPlanMode(events: readonly SessionEvent[]): boolean | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'plan/mode') return event.data.active;
  }
  return undefined;
}

/**
 * 接上一份 root 日誌，開始折它的模式。
 *
 * @param subject - `registry.sessions` 交出來的那一份。
 * @param startActive - 日誌上沒有 `plan/mode` 時的初值。
 * @returns 這一份日誌上的模式。
 */
function trackPlanMode(subject: SessionSubject, startActive: boolean): PlanModeSession {
  let active = startActive;
  subject.observe((event) => {
    // **刻意不看 `session/end-seed`。** 別的配套入口在那裡重設開關；這一格要熬過它。
    if (event.type === 'plan/mode') active = event.data.active;
  });
  return { log: subject.log, active: () => active };
}

/**
 * 跑一次 `/plan`。
 *
 * **參數不合法回 `error`，不是「不認得就當成進入」**：安靜吞掉打錯的參數，會讓
 * `/plan of` 看起來成功了而其實做了相反的事。這條關係同時是這個套件配套入口檢的那一條
 * （見 `invariant.ts`），所以參數先判——不管有沒有接上日誌，打錯的參數都落定成 `error`。
 *
 * @param sessions - 這次組裝接著的 root 日誌；剛好一份才動得了。
 * @param rawInput - 命令名之後的原文。
 * @returns 直接印給人看的結果。
 */
function planCommandResult(sessions: readonly PlanModeSession[], rawInput: string): CommandResult {
  const request = parsePlanCommandArgs(rawInput);
  if (request === undefined) return { kind: 'error', text: PLAN_ARGS_ERROR_MESSAGE };
  if (sessions.length === 0) return { kind: 'error', text: PLAN_NOT_ATTACHED_MESSAGE };
  if (sessions.length > 1) return { kind: 'error', text: planAmbiguousMessage(sessions.length) };
  const session = sessions[0] as PlanModeSession;
  const entering = request === 'enter';
  if (session.active() === entering) {
    return {
      kind: 'success',
      text: entering ? PLAN_ALREADY_ACTIVE_MESSAGE : PLAN_ALREADY_INACTIVE_MESSAGE,
    };
  }
  session.log.append('plan/mode', { active: entering });
  return { kind: 'success', text: entering ? PLAN_ENTERED_MESSAGE : PLAN_LEFT_MESSAGE };
}

/**
 * 造計劃模式的 middleware。
 *
 * 兩件事在同一個 middleware 裡，因為它們讀同一格模式：
 *
 * 1. **`wrapModelCall`** 在模式生效時把指引接到 system prompt **後面**。
 *    用 `concat` 不用取代——`@nexus/plugin-memory` 與基座的摘要器都在同一份
 *    system prompt 上加東西，取代會把它們吃掉（`dynamicSystemPromptMiddleware`
 *    正是取代，所以刻意不用它）。模式沒生效時原樣穿過，**一個 token 都不多**。
 * 2. **`wrapToolCall`** 擋掉模式外的 `exit_plan_mode`。
 *    **這是 dsh `tools/execute` 位置的一個佔用者**；索引見
 *    `apps/harness/src/interception-index.test.ts`。
 *
 * 以前還有 `stateSchema`、`beforeAgent` 與 `afterAgent` 三件：模式住在 graph state 時，
 * 前者宣告那一格、後兩者在圖外的命令與圖內的 state 之間搬值。模式搬進日誌之後三件都沒有
 * 東西可做——**`beforeAgent` 也因此不再佔住 dsh 的 `agent/pre-step`**，那一格空了（見索引）。
 *
 * **它只掛在 root 上**：`fold.ts` 不把 plugin 的 middleware 攤給 subagent，所以這兩件事
 * 讀的永遠是 root 那一份的模式。
 *
 * @param guidance - 模式生效時夾的那一段。
 * @param active - 這一刻在不在計劃模式裡。
 * @returns 可以交給 `registry.middleware.use()` 的 middleware。
 */
function createPlanModeMiddleware(guidance: string, active: () => boolean): AgentMiddleware {
  return createMiddleware({
    name: PLAN_MODE_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) => {
      if (!active()) return handler(request);
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
      if (active()) return handler(request);
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

/** 這一次工具呼叫落在哪一份日誌上——認得出來而且是這個 plugin 接著的 root 那一份才有。 */
type PlanModeLookup =
  | { readonly kind: 'ok'; readonly session: PlanModeSession }
  | { readonly kind: 'not-attached' }
  | { readonly kind: 'not-root' };

/**
 * 造 `exit_plan_mode` 工具。
 *
 * **它只會被呼叫到一次成功的路徑**：root 上模式外的呼叫在 middleware 的 `wrapToolCall` 就
 * 被擋掉了，需要核准這件事則由核准閘門處理。所以這裡剩下的是「往日誌寫一顆
 * `plan/mode { active: false }`、回一句話」。
 *
 * **日誌問的是這次呼叫的 config，不是組裝的閉包**（同 `@nexus/plugin-goal` 的工具，理由見
 * `@nexus/core` 的 `sessions.ts`）。在 subagent 裡被呼叫時，`forCall` 認出來的是那個
 * subagent 自己的日誌，而計劃模式不管那一份——那裡的 middleware 也不在（`fold.ts` 不攤），
 * 所以擋的就是這裡：回 {@link NOT_IN_PLAN_MODE_MESSAGE}。**不標 `rootOnly`**：那會換掉
 * subagent 看到的工具目錄，而 dsh 的「工具目錄不隨模式變動」講的正是這一件。
 *
 * @param lookup - 認這次呼叫的日誌。
 * @returns 可以交給 `registry.tools.register()` 的工具。
 */
function createExitPlanModeTool(lookup: (config: unknown) => PlanModeLookup): StructuredTool {
  return tool(
    (_args: { plan: string }, config: unknown) => {
      const found = lookup(config);
      if (found.kind === 'not-attached') return PLAN_NOT_ATTACHED_TOOL_MESSAGE;
      if (found.kind === 'not-root' || !found.session.active()) return NOT_IN_PLAN_MODE_MESSAGE;
      found.session.log.append('plan/mode', { active: false });
      return PLAN_APPROVED_MESSAGE;
    },
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
 * 六個註冊點，各有各的理由：
 *
 * - **`capabilities`**：讓別人 `requires` 得到。
 * - **`sessions`**：接上 root 那份日誌、折它的 `plan/mode`。**只管 root**，同 goal：模式是
 *   人對這個會話選的，subagent 沒有人可以選。
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
 * **工具一律註冊，不看模式。** 照 dsh：模式沒啟用時 `exit_plan_mode` 仍然留在面向模型的
 * schema 裡，「這樣狀態轉換不會在規劃策略變更之外額外造成工具目錄變動」。代價是模式關著的
 * 時候它是活的 schema、死的執行路徑。
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
      // **這兩格活在 `apply` 裡，不在 `createPlanModePlugin` 裡。** `load.ts` 一次組裝
      // 呼叫一次 `plugin.apply(tracked)`，所以放這裡就是一組裝一份。放到工廠函式的閉包裡
      // 的話，同一個 plugin 物件被兩次組裝共用時兩邊會串台——`serve.ts` 每個 thread 組裝
      // 一次，串台就是一個 thread 的 `/plan` 開到另一個 thread 的模式上，**而且不會拋**。
      //
      // 陣列不是單一格，理由同 goal：「剛好一份」是一個假設，`attachSession` 被呼叫兩次時
      // 由命令當場說出來（`planAmbiguousMessage`）。表是給工具用的——工具問的是「這次呼叫
      // 的那份日誌」，命令問的是「這次組裝的那一份」。兩者同生同滅。
      const attachedHere: PlanModeSession[] = [];
      const sessionsHere = new Map<SessionLog, PlanModeSession>();
      registry.sessions.join((subject) => {
        if (subject.address.kind !== 'root') return;
        const session = trackPlanMode(subject, startActive);
        attachedHere.push(session);
        sessionsHere.set(subject.log, session);
        return () => {
          sessionsHere.delete(subject.log);
          const at = attachedHere.indexOf(session);
          if (at >= 0) attachedHere.splice(at, 1);
        };
      });

      // middleware 只在 root 上跑，所以問組裝的那一份就對。接了不只一份時退回初值：命令那側
      // 會把「挑不出來」講出來，這裡猜一份的話指引會照著別人的模式夾。
      const active = (): boolean =>
        attachedHere.length === 1 ? (attachedHere[0] as PlanModeSession).active() : startActive;

      registry.capabilities.provide(PLAN_MODE_CAPABILITY);
      registry.middleware.use(createPlanModeMiddleware(guidance, active), { prepend: true });
      registry.tools.register(
        createExitPlanModeTool((config) => {
          const found = registry.sessions.forCall(config);
          if (found.kind === 'not-attached') return { kind: 'not-attached' };
          if (found.kind !== 'ok') return { kind: 'not-root' };
          const session = sessionsHere.get(found.log);
          return session === undefined ? { kind: 'not-root' } : { kind: 'ok', session };
        }),
      );
      registry.commands.register({
        name: PLAN_COMMAND_NAME,
        description: PLAN_COMMAND_DESCRIPTION,
        input: { hint: PLAN_COMMAND_HINT },
        handler: ({ rawInput }) => planCommandResult(attachedHere, rawInput),
      });
      registry.approvals.gate((exec, next) =>
        exec.name === EXIT_PLAN_MODE_TOOL_NAME
          ? { kind: 'ask', reason: '計劃要有人看過才算獲准' }
          : next(),
      );
    },
  };
}
