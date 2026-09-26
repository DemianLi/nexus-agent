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
 * ## 交出計劃走提問通道——曾經走核准，已照 dsh 改回（[#652](https://github.com/DemianLi/nexus-agent/issues/652)）
 *
 * **這一格曾經走核准**：plan-mode 註冊一位 `approvals.gate`，對 `exit_plan_mode` 回 `ask`，理由寫的是
 * 「人批准計劃與人批准這次工具呼叫是同一件事，所以不另建評審通道」。**那正是 dsh 明文否決的那條路**
 * （`.agents/notes/archived/feature/2026-07-07-plan-mode.md` 的 Alternatives，`477b4f4`）：核准的結果
 * 詞彙刻意封閉（允許／拒絕），拒絕帶不回意見，同意也長不出選項。而我們當時沒有照 AGENTS.md 把它登記成
 * 偏離。後果是計劃變成核准卡裡的工具參數，拒絕帶不回意見。
 *
 * 現在照 dsh（`packages/plan/plan-mode/src/index.ts:278-350`）：**工具本體自己問一題**，走提問通道，
 * 核准閘門不再管它。
 *
 * - 題目 {@link PLAN_REVIEW_QUESTION}，`detail` 帶計劃全文，兩個選項 {@link PLAN_APPROVE_LABEL} 與
 *   {@link PLAN_KEEP_PLANNING_LABEL}，`intent` 是 `plan-review`（純呈現用，答法同一般提問）。
 * - 選同意、沒有自由作答 → 回成功，**模式在下一個模型步驟之前才關**（見下一節）。
 * - 其他（選繼續規劃、或有自由作答）→ 拒絕，意見帶回給模型，模式留著。
 * - 人關掉這一題（`cancelled`）→ 拒絕，模型收到「停在這裡等使用者的訊息」，模式留著，**這一輪不停**。
 *   不是 `ask_user_question` 那句放棄訊息：那句叫模型別重問同一組，說的是它沒呼叫過的工具。
 * - 停止這一輪 → 由 `apps/harness` 的 `ThreadPump` 收回掛著的呼叫，工具本體不會再跑，中止保留它自己那句。
 * - **沒有人可以回答**（{@link CHANNEL_SERVICE} 說 `policy-never` 或 `no-channel`）→ 拒絕，請使用者自己切模式，
 *   同 dsh「沒有提問通道就拋錯」。CLI 與 eval 走這條。
 *
 * **怎麼問**：dsh 呼叫共用的 `userQuestions.ask()`，我們沒有那一層，這裡直接 `interrupt()`，酬載帶
 * `QUESTION_INTERRUPT_KIND`。那是 `@nexus/plugin-ask-user` 登記過的偏離（LangGraph 只有一顆中斷，
 * 所以一條通道加一個判別式）的延伸，不是新的一條；題目與回覆的形狀放在 `@nexus/core`，兩個生產者讀同一份。
 *
 * ### 模式在下一個模型步驟之前才關
 *
 * 照 dsh：同意之後不當場寫 `plan/mode`，排一格待關，到下一個 `agent/pre-step`（請求組起來之前）才寫。
 * 所以同一批工具裡其他呼叫照樣看到計劃模式開著，日誌上那顆 `plan/mode { active: false }` 落在
 * `exit_plan_mode` 的 `tool/result` 之後。載體是 {@link PLAN_MODE_MIDDLEWARE_NAME} 已經有的
 * `wrapModelCall`：它本來就在每次模型呼叫前問一次模式，在那裡先把待關交出去，不多一格圖節點。
 * **只認 root 那份日誌**：子代理的模型呼叫交不出 root 的待關。
 *
 * 待關只活在記憶體裡，同 dsh 的 `pendingIntents`：同意之後這一輪被停掉，它等到下一輪第一次模型呼叫才交出去；
 * 行程在那之前重開，它就沒了，模式留在開著。
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
 * `agent/pre-step` 才提交，免得模式在一輪中間翻面。命令那側我們不需要那一格：REPL 一行一輪；
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
 * **兩輪之間唯一可能排著的是 `exit_plan_mode` 的待關**（同意之後那一輪被停掉）。命令先把它丟掉再判：
 * 人在兩輪之間打的那一行比模型上一輪的同意新。所以那時 `/plan` 是「已經在計劃模式」、模式留著；
 * `/plan off` 照常關。
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
import { interrupt } from '@langchain/langgraph';
import type {
  AgentMiddleware,
  ApprovalChannel,
  CommandResult,
  NexusPlugin,
  PluginEntry,
  PluginRegistry,
  QuestionInterruptPayload,
  QuestionReply,
  SessionEvent,
  SessionLog,
  SessionSubject,
} from '@nexus/core';
import { CHANNEL_SERVICE, QUESTION_INTERRUPT_KIND, toolCallIdOf, toolRefusal } from '@nexus/core';
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
 * 這一份組裝沒接會話日誌：就算獲准，模式也寫不下來，所以**不送審**。
 *
 * 排在問人之前：問了、人按了同意、模式卻關不掉，是讓人白答一次。也不能回
 * {@link NOT_IN_PLAN_MODE_MESSAGE}——它明明在計劃模式裡。
 */
export const PLAN_NOT_ATTACHED_TOOL_MESSAGE =
  '計劃模式沒有接上會話日誌，就算獲准也關不掉模式，所以沒有送審。這是組裝的問題，不是計劃的問題。';

/** 計劃不是以 `#` 標題開頭。照 dsh，在問人之前擋。 */
export const PLAN_HEADING_REQUIRED_MESSAGE = `${EXIT_PLAN_MODE_TOOL_NAME} 要一份非空的 Markdown 計劃，以一個 # 標題開頭。`;

/** 沒有人可以回答。照 dsh「沒有提問通道就拋錯，請使用者自己切模式」。 */
export const PLAN_NO_REVIEWER_MESSAGE =
  '沒有提問通道可以審這份計劃（這個 session 沒有人在回答問題）。請使用者自己切換模式：/plan off。';

/** 計劃被同意時回給模型的話。模式在下一個模型步驟之前才關，見檔頭。 */
export const PLAN_APPROVED_MESSAGE = '計劃已獲准，離開計劃模式；從你的下一步起照計劃執行。';

/** 審核那一題的 id。照 dsh 的 `REVIEW_ID`。 */
export const PLAN_REVIEW_QUESTION_ID = 'plan-review';

/** 審核那一題的短標題。 */
export const PLAN_REVIEW_HEADER = '計劃審核';

/** 審核那一題問的話。 */
export const PLAN_REVIEW_QUESTION = '同意這份計劃並離開計劃模式？';

/** 同意的那個選項。**`intent.approve` 就是它**，UI 用名字認同意，不用位置。 */
export const PLAN_APPROVE_LABEL = '同意';

/** 繼續規劃的那個選項。 */
export const PLAN_KEEP_PLANNING_LABEL = '繼續規劃';

/** 選了繼續規劃、沒有寫意見。 */
export const PLAN_KEEP_PLANNING_MESSAGE = '使用者選擇繼續規劃；修改計劃後再提交一次。';

/**
 * 選了繼續規劃（或自由作答）時回給模型的話，帶著使用者的意見。
 *
 * @param feedback - 使用者寫的那句；空的時候是 {@link PLAN_KEEP_PLANNING_MESSAGE}。
 */
export function planFeedbackMessage(feedback: string): string {
  return feedback === ''
    ? PLAN_KEEP_PLANNING_MESSAGE
    : `使用者選擇繼續規劃；使用者的意見：${feedback}`;
}

/**
 * 人關掉了這一題、要自己說話。**不是失敗，也不是停止這一輪**：模型該停在這裡等下一則訊息。
 *
 * 不能用 `ask_user_question` 的放棄訊息：那句說的是「不要重問同一組」，指的是模型沒呼叫過的工具。
 * 也不標 `ASK_CANCELLED`：dsh 在這裡拋的是一般 `Error`，日誌上因此分得出它與 ask-user 的放棄。
 */
export const PLAN_REVIEW_DISMISSED_MESSAGE =
  '使用者關掉了計劃審核，要自己說話。留在計劃模式，停在這裡，等使用者的訊息。';

/** 這個 plugin 的設定。 */
export const planModeConfigSchema = z.strictObject({
  /**
   * 計劃模式生效時夾進 system prompt 的指引。省略即 {@link DEFAULT_PLAN_GUIDANCE}。
   *
   * **它是部署持有的原樣文本**，照 dsh：這個套件不替部署決定要怎麼講話。
   */
  guidance: z.string().default(DEFAULT_PLAN_GUIDANCE),
  /**
   * **日誌上一顆 `plan/mode` 都沒有時**，這個組裝在不在計劃模式裡。省略即**否**。
   *
   * 模式的真相在日誌上，這一格只是折疊的初值：一份新的會話從它起算，一份續接回來、但上一次
   * 從沒切過模式的會話（例如 v3 寫的檔）也從它起算；**一份日誌上有過 `plan/mode` 的會話，
   * 最後那一顆說了算，這一格管不到**。沒接會話日誌的組裝，模式就一直是這一格。
   *
   * **在沒有人可以回答的入口把它打開，模型交不出計劃。** `exit_plan_mode` 要問人，而 CLI 與
   * `eval/runner.ts` 傳的是 `HEADLESS_APPROVALS`（[#113](https://github.com/DemianLi/nexus-agent/issues/113)），
   * {@link CHANNEL_SERVICE} 在那裡是 `policy-never`，工具確定性地拒絕、請使用者自己切模式。唯一出去的路是
   * 人打 `/plan off`（[#120](https://github.com/DemianLi/nexus-agent/issues/120)）。在 web 上
   * 打開則是「提了計劃、有人按同意」那條正路。
   *
   * **這一格今天剩下的用途是測試**：要走真的那條路而不是直接往日誌裡寫。
   */
  startActive: z.boolean().default(false),
});

/** 驗過的設定。 */
export type PlanModeConfig = z.infer<typeof planModeConfigSchema>;

/** 工廠收的東西：schema 的輸入面，每一格都可以省略。 */
export type PlanModePluginOptions = z.input<typeof planModeConfigSchema>;

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
 * **排著的待關先丟掉再判**（見檔頭「兩值」那節最後一段）。
 *
 * @param sessions - 這次組裝接著的 root 日誌；剛好一份才動得了。
 * @param pendingExits - `exit_plan_mode` 同意之後排著、還沒交出去的待關。
 * @param rawInput - 命令名之後的原文。
 * @returns 直接印給人看的結果。
 */
function planCommandResult(
  sessions: readonly PlanModeSession[],
  pendingExits: Set<PlanModeSession>,
  rawInput: string,
): CommandResult {
  const request = parsePlanCommandArgs(rawInput);
  if (request === undefined) return { kind: 'error', text: PLAN_ARGS_ERROR_MESSAGE };
  if (sessions.length === 0) return { kind: 'error', text: PLAN_NOT_ATTACHED_MESSAGE };
  if (sessions.length > 1) return { kind: 'error', text: planAmbiguousMessage(sessions.length) };
  const session = sessions[0] as PlanModeSession;
  pendingExits.delete(session);
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
 * 1. **`wrapModelCall`** 先交出這次呼叫者排著的待關（`exit_plan_mode` 同意之後那一格，見檔頭），
 *    再在模式生效時把指引接到 system prompt **後面**。**這是 dsh `agent/pre-step` 位置的一個佔用者**：
 *    待關在請求組起來之前交出去，同 dsh。
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
 * **同一份實例掛在 root 與每個子代理上**（`fold.ts` 把 plugin 的 middleware 攤過去，
 * [#327](https://github.com/DemianLi/nexus-agent/issues/327)），所以兩件事都先問「這一次是誰」：
 * 照 dsh，`plan:policy` 段落與 `exit_plan_mode` 讀的都是**呼叫者自己的** session
 * （`packages/plan/plan-mode/src/index.ts:212-220`、`:292-294`）。子代理的 session 從沒進過計劃模式，
 * 所以 root 開著計劃模式時，子代理照樣拿不到指引，叫 `exit_plan_mode` 照樣在這一層被擋——走不到工具本體
 * 那句「沒有人可以回答」，模型看到的是「不在計劃模式」，同 dsh 的先後。
 *
 * @param guidance - 模式生效時夾的那一段。
 * @param active - 這一次呼叫的呼叫者在不在計劃模式裡；收的是 handler 形狀的 config。
 * @param settle - 交出這一次呼叫者排著的待關；不是 root、或沒有排著的，什麼都不做。
 * @returns 可以交給 `registry.middleware.use()` 的 middleware。
 */
function createPlanModeMiddleware(
  guidance: string,
  active: (config: unknown) => boolean,
  settle: (config: unknown) => void,
): AgentMiddleware {
  return createMiddleware({
    name: PLAN_MODE_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) => {
      const config = callConfigOf(request);
      settle(config);
      if (!active(config)) return handler(request);
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
      if (active(callConfigOf(request))) return handler(request);
      // **直接回訊息，不包進 `Command`**：圍堵從 `Command` 裡認這次呼叫的那則是比對
      // `tool_call_id`（`@nexus/core` 的 `readToolOutcome`），id 一旦對不上就讀成成功。
      return toolRefusal(NOT_IN_PLAN_MODE_MESSAGE, {
        callId: call.id ?? '',
        name: EXIT_PLAN_MODE_TOOL_NAME,
      });
    },
  }) as AgentMiddleware;
}

/**
 * middleware 的兩個鉤子都拿不到 handler 形狀的 config，只有 `runtime.configurable`；包回一層
 * `configurable` 就是 `registry.sessions.forCall` 要的那份，同 `@nexus/core` 的 `model-usage.ts`。
 */
function callConfigOf(request: unknown): unknown {
  return {
    configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
  };
}

/** 這一次工具呼叫落在哪一份日誌上——認得出來而且是這個 plugin 接著的 root 那一份才有。 */
type PlanModeLookup =
  | { readonly kind: 'ok'; readonly session: PlanModeSession }
  | { readonly kind: 'not-attached' }
  | { readonly kind: 'not-root' };

/**
 * 造 `exit_plan_mode` 工具。
 *
 * **先擋、再問、最後才排待關**，順序照 dsh（`packages/plan/plan-mode/src/index.ts:290-340`）：
 *
 * 1. 沒接會話日誌 → {@link PLAN_NOT_ATTACHED_TOOL_MESSAGE}（dsh 的「沒有呼叫方 agent」那一格）。
 * 2. 不在計劃模式、或不是 root 那一份 → {@link NOT_IN_PLAN_MODE_MESSAGE}。
 * 3. 計劃不是以 `#` 標題開頭 → {@link PLAN_HEADING_REQUIRED_MESSAGE}。
 * 4. 沒有人可以回答 → {@link PLAN_NO_REVIEWER_MESSAGE}。
 * 5. 問一題，照答案落定（三種結局見檔頭）。
 *
 * 每一條拒絕都是一則 `status: 'error'` 的 ToolMessage，不是 `throw`：有兩條發生在 **resume 之後**，
 * 那時拋出去的例外會從 LangGraph 的 stream mux 逸出（`@nexus/plugin-ask-user` 實測過同一件事）。
 * 都不帶碼：dsh 在這裡拋的是一般 `Error`。
 *
 * **`interrupt()` 不能包在 try/catch 裡**：它用拋例外傳播。resume 時整個本體從頭再跑一次、
 * `interrupt()` 直接回人的答案，所以前面那幾條檢查會再判一次，結果不變（它們讀的東西在兩輪之間動不了：
 * 停在提問上時斜線命令一律拒收，見 `apps/harness` 的 `wire-handler.ts`）。
 *
 * **日誌問的是這次呼叫的 config，不是組裝的閉包**（同 `@nexus/plugin-goal` 的工具，理由見
 * `@nexus/core` 的 `sessions.ts`）。在 subagent 裡被呼叫時，`forCall` 認出來的是那個
 * subagent 自己的日誌，而計劃模式不管那一份。產品組裝上那裡的 middleware 會先擋掉（#327），走不到這裡；
 * 這一格留著，是因為工具本體不該靠 middleware 在場才對。**不標 `rootOnly`**：那會換掉
 * subagent 看到的工具目錄，而 dsh 的「工具目錄不隨模式變動」講的正是這一件。
 *
 * @param lookup - 認這次呼叫的日誌。
 * @param channel - 這次組裝有沒有人可以回答。
 * @param queueExit - 同意之後排一格待關，由下一次模型呼叫交出去。
 * @returns 可以交給 `registry.tools.register()` 的工具。
 */
function createExitPlanModeTool(
  lookup: (config: unknown) => PlanModeLookup,
  channel: ApprovalChannel,
  queueExit: (session: PlanModeSession) => void,
): StructuredTool {
  return tool(
    async ({ plan }: { plan: string }, config: unknown) => {
      const callId = toolCallIdOf(config) ?? '';
      const refuse = (message: string) =>
        toolRefusal(message, { callId, name: EXIT_PLAN_MODE_TOOL_NAME });
      const found = lookup(config);
      if (found.kind === 'not-attached') return refuse(PLAN_NOT_ATTACHED_TOOL_MESSAGE);
      if (found.kind === 'not-root' || !found.session.active()) {
        return refuse(NOT_IN_PLAN_MODE_MESSAGE);
      }
      if (!/^#\s+\S/u.test(plan.trim())) return refuse(PLAN_HEADING_REQUIRED_MESSAGE);
      if (channel.kind !== 'human') return refuse(PLAN_NO_REVIEWER_MESSAGE);

      const payload: QuestionInterruptPayload = {
        kind: QUESTION_INTERRUPT_KIND,
        questions: [
          {
            id: PLAN_REVIEW_QUESTION_ID,
            header: PLAN_REVIEW_HEADER,
            question: PLAN_REVIEW_QUESTION,
            detail: plan,
            options: [
              { label: PLAN_APPROVE_LABEL, description: '離開計劃模式；從下一步起照計劃執行。' },
              { label: PLAN_KEEP_PLANNING_LABEL, description: '留在計劃模式；意見會回給模型。' },
            ],
            // 純呈現用：認得的 UI 畫成審核卡，不認得的照一般提問畫，答的都是上面兩個標籤之一。
            intent: { kind: 'plan-review', approve: PLAN_APPROVE_LABEL, callId },
          },
        ],
      };
      const reply = (await interrupt(payload)) as QuestionReply | undefined;

      if (reply?.cancelled === true) return refuse(PLAN_REVIEW_DISMISSED_MESSAGE);
      // 照 dsh：剛好一筆審核的答案、只選了同意、沒有自由作答，才算同意。其餘一律是繼續規劃，
      // 看不懂的回覆也是——那時沒有意見可帶，回的是沒有意見的那一句。
      const items = (Array.isArray(reply?.answers) ? reply.answers : []).filter(
        (entry) => entry.id === PLAN_REVIEW_QUESTION_ID,
      );
      const item = items.length === 1 ? items[0] : undefined;
      if (
        item?.selected.length !== 1 ||
        item.selected[0] !== PLAN_APPROVE_LABEL ||
        item.custom !== undefined
      ) {
        return refuse(planFeedbackMessage(item?.custom ?? ''));
      }
      queueExit(found.session);
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
 * 五個註冊點，各有各的理由：
 *
 * - **`capabilities`**：讓別人 `requires` 得到。
 * - **`sessions`**：接上 root 那份日誌、折它的 `plan/mode`。**只管 root**，同 goal：模式是
 *   人對這個會話選的，subagent 沒有人可以選。
 * - **`middleware`（`prepend: true`）**：**排在核准閘門之前是必要的，不是偏好。**
 *   `fold.ts` 的順序是「`prepend` 的在前、核准閘門接著、其餘依註冊順序」。這個 plugin 自己不再掛閘門，
 *   但別人的閘門可能把所有工具都攔下來（`approval.patch.yml` 那一類組裝）；不 `prepend` 的話，
 *   一次模式外的 `exit_plan_mode` 會先撞上那位——headless 入口回的是「沒有人被問到」，而真正的原因是
 *   「你不在計劃模式」。順序決定模型看到哪一句。
 * - **`tools`**：`exit_plan_mode` 走 `registry.tools.register()`，**不用
 *   `AgentMiddleware` 自帶的 `tools`**。那條路繞過 `toolOrder`——`fold.ts` 的
 *   `orderTools` 只排 `registry.tools.effective()` 裡的東西，而工具呈現順序是我們
 *   自建的機制（dsh 那邊註冊順序造成過真實 CI flake），繞過它等於把那個保護放掉。
 * - **`commands`**：`/plan` 走 `registry.commands.register()`。**命令不進模型**——它是
 *   人對工具說的話，結果直接印給打字的人看。dsh 那邊這一格掛在
 *   `ctx.inject(['commands'], …)` 底下（「命令註冊表被組進來時才啟用」），我們的
 *   `PluginRegistry` 每個註冊點永遠都在，所以直接註冊；**這是形狀差異不是偏離**，
 *   理由已經寫在 `@nexus/core` 的 `CommandRegistrationPoint` 上。
 *
 * **不再註冊 `approvals.gate`**（[#652](https://github.com/DemianLi/nexus-agent/issues/652)）。以前那位對
 * `exit_plan_mode` 回 `ask`，理由是「人批准計劃與人批准這次工具呼叫是同一件事」——dsh 明文否決那條路，
 * 已照 dsh 改回提問通道，見檔頭。
 *
 * **工具一律註冊，不看模式。** 照 dsh：模式沒啟用時 `exit_plan_mode` 仍然留在面向模型的
 * schema 裡，「這樣狀態轉換不會在規劃策略變更之外額外造成工具目錄變動」。代價是模式關著的
 * 時候它是活的 schema、死的執行路徑。
 *
 * **模組層級的一顆常數**，給 [#454](https://github.com/DemianLi/nexus-agent/issues/454)
 * 從設定檔 import。設定走 {@link Config} 進來，所以同一顆可以被好幾次組裝各 `apply` 一次
 * ——**每次掛載才有的狀態一律活在 `apply` 裡**。
 */
export const planModePlugin: NexusPlugin<PlanModeConfig> = {
  name: 'plan-mode',
  Config: planModeConfigSchema,
  apply(registry: PluginRegistry, config: PlanModeConfig): void {
    const { guidance, startActive } = config;
    // **這兩格活在 `apply` 裡，不在模組層級。** `load.ts` 一次組裝
    // 呼叫一次 `plugin.apply(tracked, config)`，所以放這裡就是一組裝一份。寫在模組層級
    // 的話，同一顆 plugin 被兩次組裝共用時兩邊會串台——`serve.ts` 每個 thread 組裝
    // 一次，串台就是一個 thread 的 `/plan` 開到另一個 thread 的模式上，**而且不會拋**。
    //
    // 陣列不是單一格，理由同 goal：「剛好一份」是一個假設，`attachSession` 被呼叫兩次時
    // 由命令當場說出來（`planAmbiguousMessage`）。表是給工具用的——工具問的是「這次呼叫
    // 的那份日誌」，命令問的是「這次組裝的那一份」。兩者同生同滅。
    const attachedHere: PlanModeSession[] = [];
    const sessionsHere = new Map<SessionLog, PlanModeSession>();
    // `exit_plan_mode` 同意之後排著、等下一次模型呼叫交出去的待關（見檔頭）。同 dsh 的 `pendingIntents`。
    const pendingExits = new Set<PlanModeSession>();
    registry.sessions.join((subject) => {
      if (subject.address.kind !== 'root') return;
      const session = trackPlanMode(subject, startActive);
      attachedHere.push(session);
      sessionsHere.set(subject.log, session);
      return () => {
        // 只是不留一格記憶體：收掉之後兩張表都找不到這份，命令與下一步都交不出它，行為上觀察不到。
        pendingExits.delete(session);
        sessionsHere.delete(subject.log);
        const at = attachedHere.indexOf(session);
        if (at >= 0) attachedHere.splice(at, 1);
      };
    });

    // middleware 掛在 root 與每個子代理上（#327），所以先問這一次是誰。三格，**不能收成兩格**：
    // - 認得出來、是這個 plugin 接著的 root 那份日誌 → 讀它的模式。
    // - 認得出來、是別的日誌（子代理）→ 不在計劃模式。照 dsh，子代理讀的是它自己的 session。
    // - 認不出來（沒接日誌、沒有 `checkpoint_ns`、挑不出來）→ 沿用改之前的答案：剛好接了一份就讀它，
    //   否則退回初值。不接日誌、開著 `startActive` 的組裝靠這一格夾指引；收成「不在」的話指引會靜靜
    //   消失，沒有東西會紅。接了不只一份時不猜：命令那側會把「挑不出來」講出來，猜一份的話指引會照著
    //   別人的模式夾。
    const fallback = (): boolean =>
      attachedHere.length === 1 ? (attachedHere[0] as PlanModeSession).active() : startActive;
    const active = (config: unknown): boolean => {
      const found = registry.sessions.forCall(config);
      if (found.kind !== 'ok') return fallback();
      return sessionsHere.get(found.log)?.active() ?? false;
    };
    // 只認得出來、而且是這個 plugin 接著的 root 那份：子代理的模型呼叫交不出 root 的待關。
    const settle = (config: unknown): void => {
      const found = registry.sessions.forCall(config);
      if (found.kind !== 'ok') return;
      const session = sessionsHere.get(found.log);
      if (session === undefined || !pendingExits.delete(session)) return;
      if (session.active()) session.log.append('plan/mode', { active: false });
    };
    // 軟相依，同 `@nexus/plugin-ask-user`：沒人提供時當作有人在。產品路徑由組裝點明著提供。
    const channel: ApprovalChannel = registry.services.get(CHANNEL_SERVICE) ?? { kind: 'human' };

    registry.capabilities.provide(PLAN_MODE_CAPABILITY);
    registry.middleware.use(createPlanModeMiddleware(guidance, active, settle), { prepend: true });
    registry.tools.register(
      createExitPlanModeTool(
        (config) => {
          const found = registry.sessions.forCall(config);
          if (found.kind === 'not-attached') return { kind: 'not-attached' };
          if (found.kind !== 'ok') return { kind: 'not-root' };
          const session = sessionsHere.get(found.log);
          return session === undefined ? { kind: 'not-root' } : { kind: 'ok', session };
        },
        channel,
        (session) => pendingExits.add(session),
      ),
    );
    registry.commands.register({
      name: PLAN_COMMAND_NAME,
      description: PLAN_COMMAND_DESCRIPTION,
      input: { hint: PLAN_COMMAND_HINT },
      handler: ({ rawInput }) => planCommandResult(attachedHere, pendingExits, rawInput),
    });
  },
};

export default planModePlugin;

/**
 * 建一個條目。**薄薄一層**：設定不在這裡驗，驗在載入的時候——那時候才有 id 可以指名。
 *
 * @param options - 設定，形狀見 {@link planModeConfigSchema}。
 * @returns 可以放進組裝點清單的條目。
 */
export function createPlanModePlugin(options: PlanModePluginOptions = {}): PluginEntry {
  return { plugin: planModePlugin, config: options };
}
