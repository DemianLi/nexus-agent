/**
 * agent 工廠——**plugin 清單組出來的 agent 只有這一個組裝點**。
 *
 * 整個 repo 只有一處例外：[`baseline.test.ts`](./baseline.test.ts) 直接呼叫
 * `createDeepAgent`，而那是刻意的——它斷言的是「基座還是不是我們以為的那個形狀」，
 * 中間隔著我們自己的 fold 就驗不到那件事了。
 *
 * 三步：`loadPlugins()` 把清單跑進 registry、`foldRegistry()` 折成參數、
 * `createDeepAgent()` 收下。前兩步住在 `@nexus/core`（純轉換層，不碰基座的建構），
 * 第三步只有這裡有。換模型、換儲存、換工具組合＝換 plugin 清單，core 不動。
 *
 * 「組裝點自有、plugin 不得提供」的那些（default backend、工具呈現順序、model、
 * checkpointer / store、核准政策的 session 開關、摘要的門檻與去向、重複呼叫提醒的門檻與
 * 射程，加一份基座工具名單）
 * 從 {@link CreateNexusAgentOptions} 進來，原樣交給 fold：**所有權在這裡，檢查跑在 core**。
 *
 * 這也是 fold 的產物第一次真的碰到基座。基座在建構時還有三道自己的檢查是 fold 看不到的，
 * 外加**一件不是檢查而是改寫**的事（第 4 條）：
 *
 * 1. **工具名撞到內建**——`createDeepAgent()` 開頭丟 `ConfigurationError('TOOL_NAME_COLLISION')`。
 *    我們在 fold 之前先擋一次，理由見 {@link assertNoBaseToolNameCollision}。
 * 2. **`permissions` 的路徑格式**——只要規則非空，`createFilesystemMiddleware()` 就跑
 *    `validatePermissionPaths()`：非絕對路徑、含 `..`、含 `~` 一律拋錯。`registry.permissions.deny()`
 *    明文不驗第二次，所以這條的失敗只會在這裡出現。
 * 3. **`permissions` 配上支援命令執行的 backend**——同一個地方拋，因為 shell 指令碰得到任何路徑，
 *    路徑規則會失效。**它丟的是普通的 `Error`，不是 `ConfigurationError`**（PR #53 的內文寫成
 *    後者，是錯的；1.13.1 的 `ConfigurationError` 只有 `TOOL_NAME_COLLISION` 一個 code）。
 *    現在觸發不到——`StateBackend` 的 `isSandboxBackend` 是 false——所以這裡不寫測試，
 *    留給 Phase 2 的 `feat/sandbox-plugin` 當場驗。
 * 4. **按模型改寫組裝**——`createDeepAgent()` 從 `model` 解出一份 harness profile，然後才
 *    開始組 middleware。它拿得掉工具、改得動我們自己註冊的工具的 description、加得了
 *    middleware（連同它帶的工具）、換得掉系統提示詞。**前三條是檢查，這一條是改寫**：
 *    它不會拒絕任何東西，只會安靜地讓組出來的 agent 不是我們宣告的那個。所以這裡在
 *    fold 之前先要求宣告，見 {@link CreateNexusAgentOptions.expectedHarnessProfile} 與
 *    [`harness-profile.ts`](./harness-profile.ts)。
 *
 * 組裝點還負責一件基座**設了但等於沒設**的事：agent 迴圈的上限。見
 * {@link DEFAULT_RECURSION_LIMIT}。
 */

import {
  assertInvariantSelection,
  createInvariantRunner,
  createSessionRunner,
  foldRegistry,
  formatOrigin,
  loadPlugins,
  SessionTelemetryCoordinator,
  type AgentCheckpointer,
  type AgentModel,
  type AgentStore,
  type ApprovalPolicy,
  type InvariantError,
  type InvariantSelection,
  type NexusPlugin,
  type PluginRegistry,
  type SessionRegistry,
  type SessionTelemetrySharingStatus,
  type RepeatReminderSettings,
  type SummarizationSettings,
} from '@nexus/core';
import { CompositeBackend, createDeepAgent, StateBackend } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { BASE_TOOL_NAMES, RESERVED_BASE_TOOL_NAMES } from './base-tools.js';
import { assertHarnessProfileDeclared } from './harness-profile.js';
import type { HarnessProfileEffects } from './harness-profile.js';

export interface CreateNexusAgentOptions {
  /** plugin 清單。順序有意義：middleware 的順序、以及 `except` 的射程都跟著它。 */
  readonly plugins: readonly NexusPlugin[];
  /**
   * 模型。**刻意是必填**——基座省略時會退到它自己的預設（`anthropic:claude-sonnet-4-6`），
   * 那會讓「忘了指定」與「就是要 Anthropic」看起來一模一樣，而前者的代價是打一支
   * 沒人預期的付費 API。預設供應商的決策（Anthropic）不受影響：那是清單怎麼寫的事，
   * 不是這裡該替人填的預設值。
   */
  readonly model: AgentModel;
  /**
   * 宣告「這個模型會讓基座對組裝做哪些事」。**省略即宣告「什麼都不做」**——那是今天所有
   * 呼叫端的實情，也是唯一一種不必寫的宣告。
   *
   * 基座解出來的 profile 與這份宣告不一致，組裝當場失敗（兩個方向都擋：沒宣告卻有東西、
   * 宣告了卻沒有那些東西）。**這不是把某些模型封死**——確認過改動可以接受，就照錯誤訊息
   * 把實際那份貼進來。理由、形狀與 dsh 那側的對照見
   * [`harness-profile.ts`](./harness-profile.ts) 的檔頭。
   */
  readonly expectedHarnessProfile?: HarnessProfileEffects;
  /**
   * default backend。plugin 掛的是路由分支（`backend.mount()`），兜底的這個是組裝點的事。
   * 省略即 `StateBackend`（跑在 state 裡的虛擬 FS，不碰真實磁碟）。**含路徑圍堵的
   * default backend 是 Phase 2 `feat/fs-backends` 的事**，現在這個不設防。
   */
  readonly backend?: AnyBackendProtocol;
  /** 工具呈現順序。省略即字典序（省略不代表隨便排，代表另一種確定的排法）。 */
  readonly toolOrder?: readonly string[];
  /**
   * 基座工具的名字宇宙。省略即 {@link BASE_TOOL_NAMES}。
   * 會想覆寫它的只有測試，以及哪天真的開了 async subagent 的組裝。
   */
  readonly baseToolNames?: readonly string[];
  /**
   * 「先讀後改」策略的開關。省略即開著（照 dsh，那邊是預設載入的插件）。
   *
   * `false` 是明著接受盲改——一個只寫新檔、從不編輯既有檔的批次流程用得到它。
   * 形狀與理由見 `@nexus/core` 的 `observation.ts`。
   */
  readonly observationPolicy?: boolean;
  /** checkpointer。有 plugin 宣告要核准的工具卻沒給，fold 會報錯。 */
  readonly checkpointer?: AgentCheckpointer;
  /** 長期記憶用的 store。 */
  readonly store?: AgentStore;
  /** 核准政策的 session 開關。省略即「這個 session 有人在」。 */
  readonly approvals?: ApprovalPolicy;
  /**
   * 摘要的門檻與去向。省略即 `DEFAULT_SUMMARIZATION`，給物件就逐格淺合併上去，
   * `false` 是明著退回基座那個。
   *
   * **這一格存在是因為基座沒有這個參數。** `createSummarizationMiddleware({ backend })`
   * 被無條件寫死進 root 與每個 subagent 的 stack，`CreateDeepAgentParams` 上一個
   * summarization 欄位都沒有；門檻由基座在執行期從模型 profile 二選一挑，而我們的模型
   * 解不出 profile，於是拿到一組與模型無關的常數，**沒有任何一側在檢查它跟真實窗口的
   * 關係**。唯一的縫是同名取代，fold 走的就是那條。
   *
   * `fraction` 型別的門檻在型別層與執行期都被擋掉——它需要 `profile.maxInputTokens`，
   * 缺值時 `trigger` 一輩子不觸發、`keep` 一則逐字訊息都不留，兩個方向都不警告。
   * 實測與決議見 [#142](https://github.com/DemianLi/nexus-agent/issues/142)，形狀與
   * 數值的理由見 [`summarization.ts`](../../../packages/nexus-core/src/summarization.ts)。
   */
  readonly summarization?: Partial<SummarizationSettings> | false;
  /**
   * 重複工具呼叫的提醒門檻與射程。省略即 `DEFAULT_REPEAT_REMINDER`（門檻 3／5／8），
   * 給物件就逐格淺合併上去，`false` 是明著不要。
   *
   * **這一格存在是因為基座沒有這種 middleware。** 模型以同參數重複呼叫同一個工具時，
   * 今天唯一會讓它停下來的是 {@link DEFAULT_RECURSION_LIMIT}，而那個上限不分辨「在
   * 進展」與「在打轉」——它只會在跑了夠久之後把整輪掐掉。提醒器是**建議不是阻止**：
   * 合理的重複一秒都不會被延遲。形狀與門檻照 dsh 的 `repeat-tool-reminder`，
   * 偏離登記見 [`repeat-reminder.ts`](../../../packages/nexus-core/src/repeat-reminder.ts)。
   *
   * **開著會吃掉迴圈預算**：它掛在 `beforeModel` 上，那在圖裡是一個節點，每一輪多一個
   * super-step，於是 `recursionLimit` 的換算從 `2 × 輪數 + 2` 變成 `3 × 輪數 + 2`。
   * 見 {@link DEFAULT_RECURSION_LIMIT}。
   */
  readonly repeatReminder?: Partial<RepeatReminderSettings> | false;
  /** 附加在基座 base prompt 前面的 system prompt。 */
  readonly systemPrompt?: string;
  /**
   * agent 迴圈的上限，單位是 LangGraph 的 super-step。省略即 {@link DEFAULT_RECURSION_LIMIT}。
   *
   * **一定要設，因為基座的預設等於沒有上限**——見 {@link DEFAULT_RECURSION_LIMIT}。
   * 換算是 `recursionLimit = 2 × 模型輪數 + 2`（模型一輪、工具一輪各算一個 super-step）。
   */
  readonly recursionLimit?: number;
  /**
   * 哪些 package 的不變量檢查要真的裝上去。省略即全裝。
   *
   * **這是次要的那個開關。** 條目層的 {@link NexusPlugin.disabled} 才是主要答案：一個配套
   * 入口 plugin 對一個 package 名，關掉那個條目就等於關掉那個 package 的檢查，而且
   * 錯誤訊息裡指得出是誰。這裡收的 selection 補的是條目層表達不了的兩件事——`enabled:
   * false` 這個總開關，以及跨多個 package 的 regex 樣式。
   *
   * **原樣轉給 `createInvariantRunner`，這裡不加任何語意**：驗證與過濾規則只有
   * {@link InvariantSelection} 那一份。
   */
  readonly invariants?: InvariantSelection;
  /**
   * 違規往哪裡講。省略即 `createInvariantRunner` 的預設，也就是 `console.error`。
   *
   * **這道縫存在的理由不是「換一個 fd」**——預設的 `console.error` 本來就是 stderr。它買到
   * 的是三件事，缺一件違規就會變成一個沒有人管得到的輸出：呼叫端**指得出格式**（CLI 有
   * 自己的 `Printer`，違規不繞過它）、**測得到**（在這道縫之前，唯一驗違規的辦法是去攔
   * `console.error`），以及**歸得了因**（違規跟 agent 的輸出落在同一個終端機上，沒有前綴
   * 就分不出誰是誰）。
   *
   * 定案見 [#107](https://github.com/DemianLi/nexus-agent/issues/107)。**`serve.ts` 那條
   * 路徑刻意不傳**，維持預設：那裡的 `console.error` 進的是伺服器日誌，撞不到任何人的
   * 終端機。兩條進入點答案不同是選的，不是漏的。
   */
  readonly onInvariantViolation?: (error: InvariantError) => void;
}

/**
 * 迴圈上限的預設值。
 *
 * ## 為什麼要自己設一個
 *
 * **基座把它調到一個保證不會觸發的值。** `createDeepAgent` 最後一步是
 * `createAgent(...).withConfig({ recursionLimit: 1e4 })` —— 一萬個 super-step，換算成
 * **約 5,000 輪模型呼叫**。2026-08-28 用 [`LoopingChatModel`](./looping-model.ts) 實測過：裸基座與我們的
 * 組裝點都跑到 `GraphRecursionError: Recursion limit of 10000 reached`，模型分別被叫了
 * 5000 與 4999 次。**那不是護欄，是一個關掉的護欄。**
 *
 * 這是 [`baseline.test.ts`](./baseline.test.ts) 那條「基座還是不是我們以為的那個形狀」
 * 的另一型：上次是我們掛的 middleware 關掉了基座的預設，這次是**基座自己**把預設轉到底，
 * 而且它藏在 dist 的一行 `withConfig` 裡 —— 型別、文件、README 全都看不到。
 *
 * ## 為什麼是 100
 *
 * 換算後約 49 輪模型呼叫。實測跑掉的那一次（[#86](https://github.com/DemianLi/nexus-agent/pull/86)，
 * `llama-3.2-11b` 在一題基準任務上多叫了 25 次工具、792.8 秒、110,936 token）大約要
 * 57 個 super-step，所以這個值攔得住它，而正常的基準任務（最長 3 次工具呼叫 ≈ 8 個
 * super-step）離它還很遠。**它是「跑掉了」的界線，不是「複雜任務」的界線** —— 真的需要
 * 更長的呼叫端自己傳一個大的，那時那個數字會出現在呼叫端的程式碼裡而不是沒有人設過。
 *
 * **上面那兩個 super-step 數字都是每輪兩格算的**（57 與 8），跟下一段的新換算不同尺，
 * 不要拿它們互比。換成每輪三格是 ≈ 85 與 ≈ 12：跑掉的那次照樣攔得住，正常任務照樣很遠。
 *
 * ## 上面那個換算是裸組裝的，預設組裝比它短
 *
 * `2 × 輪數 + 2` 只在「圖裡沒有 `beforeModel` 節點」時成立，而
 * [#147](https://github.com/DemianLi/nexus-agent/issues/147) 打底的
 * {@link CreateNexusAgentOptions.repeatReminder} 就是一個。通式是
 * `模型輪數 = floor((recursionLimit - 1) / 每輪格數)`，所以**預設組裝每一輪是三格，
 * 100 換算成 33 輪而不是 49**。2026-09-03 實測，逐格對照見
 * [`looping-model.ts`](./looping-model.ts) 的檔頭。
 *
 * **這個常數沒有跟著動。** 方向是護欄變嚴不是變鬆，而校準的兩端換算過去都還成立（見
 * 上一段）。要拿回原本的預算就自己傳一個大的 `recursionLimit`，或明著關掉提醒器。
 */
export const DEFAULT_RECURSION_LIMIT = 100;

/**
 * 沒有人在的那些入口用的核准政策。
 *
 * **這是入口層的一個事實，不是一個偏好。** 一個收不了核准決定的入口把 `enabled` 留在
 * 預設的 `true`，等於保證每次碰到核准點都停在那裡等一個不會來的答案 —— CLI 是整輪
 * 作廢，eval 是一條基準任務作廢。關掉之後 agent 照樣跑得完：不需要核准的照跑，需要
 * 核准的回一則說明是「沒有人被問到」的拒絕（[#113](https://github.com/DemianLi/nexus-agent/issues/113)
 * 拍板 (a)：不加旗標，因為旗標是為了讓人選，而這裡沒有第二個值得選的行為）。
 *
 * 對到 dsh 的 `ApprovalPolicy: 'never'`，它的文件寫的正是這個用途 ——
 * "The strict headless stance (CI, unattended runs)"（`docs/subsystems/approval.md:43`）。
 *
 * **與 dsh 的偏離，只有這一句**：dsh 還分得出第三種 —— policy 留在 `'ask'` 但一個
 * answerer 都沒 compose，結果是 `'unavailable'` 而不是 `'rejected'`。我們的
 * `ApprovalChannel` 是從 checkpointer 在不在推出 `no-channel` 的，不是從一份 answerer
 * 名冊，所以「有 resume 管道但沒有介面」在我們這裡沒有表示法，退到 `never`。
 *
 * **不是每個入口都該用它。** `serve.ts` 那條刻意維持預設的 `true`：瀏覽器那端真的按得
 * 下去，關掉它會把一個做得出來的功能關掉。三個入口三個答案，這是選的不是漏的。
 */
export const HEADLESS_APPROVALS: ApprovalPolicy = { enabled: false };

/**
 * 組裝好的 agent，加上收掉它的方法。
 *
 * **刻意是推導出來的別名，不是自己打一份 interface**：`createDeepAgent` 的回傳型別帶著
 * 一整串由參數推導的型別參數，寫成 `ReturnType<typeof createDeepAgent>` 會退回預設值，
 * 呼叫端的 `result.messages` 當場變成 `any`。
 *
 * `dispose` 收的是清單裡的 plugin 經 `registry.lifecycle.onDispose()` 登記的活資源
 * （MCP 的 stdio 子行程是第一個），逆序、冪等，**外加還接著的遙測協調器**。
 * **不收 agent 本身**——deepagents 建構後不可變，也沒有東西要關。不呼叫的下場是行程
 * 不退出：子行程的 stdio pipe 是活的 handle。
 *
 * `attachTelemetry` 是遙測的接線口。它在這裡而不在 `@nexus/core`，因為接線需要同時
 * 拿到 registry（誰掛了後端、誰掛了脫敏規則）與一份 {@link SessionLog}，而**只有組裝點
 * 同時看得到這兩個**——core 那側不知道日誌是誰建的，兩條進入點那側不知道 registry。
 *
 * `attachInvariants` 同一個理由，接的是不變量配套入口。兩者**不合併**：遙測是把事件
 * 送出去，不變量是檢查事件之間的關係，一個有出境資料一個沒有，開關與失敗語意都不一樣。
 *
 * `attachSession` 是第三個，接的是 `sessions` 通道的參與者。它與另外兩個的差別是**方向**：
 * 那兩個只讀，這一個交出去的日誌**寫得動**——`goal/change` 這種權威 domain 事件就是從
 * 這裡進日誌的。理由與否掉沿用 `invariants` 的兩條見
 * {@link @nexus/core!SessionSubject}。
 */
export type NexusAgentHandle = Awaited<ReturnType<typeof createNexusAgent>>;

/**
 * 依一份 plugin 清單建一個 agent。
 *
 * **組裝失敗時這裡自己收拾**：`loadPlugins` 過了才發現 fold 的前置條件不成立、或基座
 * 擋下這份組裝時，已經開好的資源沒有第二個人知道——呼叫端拿到的是一個 exception，
 * 不是 handle。所以先 `dispose()` 再把原本的錯誤往外拋。
 *
 * @param options - 清單，加上組裝點自有的那些。
 * @returns 建好的 agent 與收掉它的方法。
 * @throws 模型解出來的 harness profile 與宣告不符、清單載入失敗（重名、`requires` 缺件、
 *   `apply` 拋錯）、`invariants` 的 pattern 不合法、fold 的前置條件不成立，或基座自己在
 *   建構時擋下這份組裝——五種都在載入期發生，不會拖到跑起來才炸。
 */
/**
 * 基座把過大的工具結果搬去的那個路徑前綴。**抄自基座，不是我們選的。**
 *
 * `createFilesystemMiddleware` 的 `wrapToolCall` 在文字超過
 * `4 * toolTokenLimitBeforeEvict`（預設 `2e4` → 80,000 字元）時寫
 * `/large_tool_results/<sanitized tool_call_id>.txt`，然後把訊息換成頭尾預覽加一句
 * 「用 `read_file` 自己去讀」（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:2416`
 * 的 `processToolMessage`）。那個路徑是**寫死在基座裡的**，這裡只是把同一個字串說出來。
 *
 * **匯出是刻意的**：`tool-result-stash.test.ts` 那條絆索拿它跟基座實際指路的路徑對，
 * 基座改了字串就當場紅。把它藏起來、測試裡再抄一次字面值，那條絆索就會兩邊一起錯。
 */
export const TOOL_RESULT_STASH_PREFIX = '/large_tool_results';

/**
 * 把工具結果暫存那一格路由到獨立的 {@link StateBackend}，不讓它落在 agent 的工作區上。
 *
 * ## 它修的是一個會丟資料的缺陷（[#170](https://github.com/DemianLi/nexus-agent/issues/170)）
 *
 * 基座那次 `backend.write()` **失敗時不會保留原文**——它把訊息換成
 * `Tool result too large, but the result could not be saved to the filesystem: <error>`
 * （`:2437`），於是模型剛要到手的東西整個沒了，只剩一句「存不進去」。
 *
 * **而那不是稀有路徑。** `ContainedFilesystemBackend` 的 `read-only` mode 對**每一次**
 * write 回 `{ error }`，所以那個組裝底下**每一則**超過 80,000 字元的工具結果都會這樣：
 * 實測 80,014 個字元換成 166 個，模型接著 `read_file` 拿到 `ENOENT`。
 *
 * dsh 明文保證相反：`dsh-spill-policy` 的三個不變式之一是「spill 失敗保留原始內聯結果，
 * 絕不把成功的呼叫變成錯誤」（`packages/spill/spill-policy/README.zh.md`，SHA `4e84901`）。
 *
 * ## 為什麼修在 backend 這一層，而不是包一層 middleware
 *
 * **因為原文在基座那一層裡面。** 我們自己的 `wrapToolCall` 包在外面時，拿到的已經是
 * 基座換過的訊息；要握住原文得再有一層跑在裡面，兩層之間對 `tool_call_id`，而且
 * 「認出基座失敗了」只能去比對那句英文——基座沒有給碼。路由讓那次 write **不會失敗**，
 * 於是這些都不必發生。
 *
 * ## 為什麼是無條件的，不是「唯讀時才路由」
 *
 * `fold.ts` 已經畫過這條線：**歷史是基礎建設，不是 agent 的工作區**（摘要器因此拿的是
 * default backend，不是折出來的那個）。工具結果暫存落在同一側 —— 它是 harness 的暫存，
 * 不是模型在做的事。所以它不該取決於工作區的寫入政策：
 *
 * - **`read-only`**：那次 write 不再被 fence 擋掉，缺陷消失。
 * - **`workspace-write`**：暫存不再落在使用者的專案目錄裡。今天它會留下永遠沒人清的
 *   `<root>/large_tool_results/*.txt`；dsh 的 spill 同樣**不寫工作區**，它有自己的私有根。
 * - **預設（`StateBackend`）**：路由到另一個 `StateBackend`，行為等價（實測）。
 * - 而且它不必知道那次 write **為什麼**會失敗——`ENOSPC`、`EACCES`、掛載唯讀，一起蓋掉。
 *
 * **代價講明白：暫存改放在 graph state 裡，所以它進 checkpoint。** 預設組裝本來就是這樣，
 * 但磁碟型的 backend 今天是把那段文字移出 state 的，這一改等於移回來。跑完之後它也不再
 * 留在磁碟上供事後翻查。**與 dsh 的差別也在這裡**：它的 spill 存在宿主上一個私有目錄
 * （0700／`open(…, 'wx', 0o600)`）並有保留期清理，我們換成 state —— 理由是 `read-only`
 * 不該因為這件事開始碰磁碟，而且 state 不需要清理政策。要改成落盤的話，換的就是這裡
 * 這一個路由目標。
 *
 * @param backend - 組裝點的 default backend。
 * @returns 同一個 backend，外面包一層只有這一條路由的 `CompositeBackend`。
 */
function withToolResultStash(backend: AnyBackendProtocol): AnyBackendProtocol {
  return new CompositeBackend(backend, { [TOOL_RESULT_STASH_PREFIX]: new StateBackend() });
}

export async function createNexusAgent(options: CreateNexusAgentOptions) {
  // **跑在 `loadPlugins` 之前**：它只看 `options.model`，這時候還沒有任何 plugin 開好資源，
  // 所以失敗了不必先 `dispose()`。其餘四種都在下面那個 try 裡，因為它們要等 registry。
  assertHarnessProfileDeclared(options.model, options.expectedHarnessProfile);

  const { registry, dispose } = await loadPlugins(options.plugins);

  try {
    assertNoBaseToolNameCollision(registry);
    // 選擇的合法性在**這裡**驗，不是等接線時才驗：runner 是每一份會話日誌各建一個的，
    // 壞掉的 regex 預設會拖到第一輪對話才炸，那不是組裝失敗該出現的地方。
    if (options.invariants !== undefined) assertInvariantSelection(options.invariants);

    const params = foldRegistry(registry, {
      defaultBackend: withToolResultStash(options.backend ?? new StateBackend()),
      toolOrder: options.toolOrder,
      baseToolNames: options.baseToolNames ?? BASE_TOOL_NAMES,
      model: options.model,
      checkpointer: options.checkpointer,
      store: options.store,
      approvals: options.approvals,
      ...(options.summarization !== undefined && { summarization: options.summarization }),
      ...(options.repeatReminder !== undefined && { repeatReminder: options.repeatReminder }),
      ...(options.observationPolicy !== undefined && {
        observationPolicy: options.observationPolicy,
      }),
    });

    // `withConfig` 疊在基座自己那一層 `withConfig` 上面，後者贏（實測 `8` → 模型只被叫
    // 3 輪）。**推導出來的型別沒有塌**：包完之後 `invoke()` 的 `messages` 仍然是
    // `BaseMessage[]` 而不是 `any`，所以 {@link NexusAgentHandle} 那個別名照樣成立
    // ——這件事驗過，因為 `any` 是不會讓 typecheck 紅的那種壞掉。
    const agent = createDeepAgent({
      ...params,
      ...(options.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
    }).withConfig({ recursionLimit: options.recursionLimit ?? DEFAULT_RECURSION_LIMIT });

    // 接上去但還沒收掉的協調器。**組裝點自己記著**，因為呼叫端可能只叫 `dispose()`
    // 就走人——那時 `shutdown` 標記與後端的排空都還沒發生，遙測會少掉最後一段。
    const attached = new Set<SessionTelemetryCoordinator>();
    return {
      agent,
      /**
       * plugin 註冊的**人的命令**。進入點靠它把一行 `/name` 發派出去。
       *
       * 交出去的是整個註冊點而不是只有 `find`，理由是 `register()` 自己就擋得住誤用：
       * 它要 `requireOrigin()`，而組裝之後沒有任何 plugin 的 `apply` 在跑，呼叫它會
       * 當場拋。所以這裡沒有「組裝後偷偷加命令」這條路。
       */
      commands: registry.commands,
      /**
       * 掛著的遙測服務說的共享策略，**沒掛任何東西時是 `undefined`**。
       *
       * 披露那一層只有在拿到 `undefined` 的時候才渲染「未配置」——這是 dsh 的規矩，
       * 也是為什麼這裡回的是「有沒有掛」而不是一個保險的預設值。
       */
      telemetrySharing: registry.telemetry.service()?.value.sharing as
        SessionTelemetrySharingStatus | undefined,
      /**
       * 把一次組裝的**每一份**會話日誌接上遙測。**沒掛後端時回 `undefined`**——沒有後端
       * 就沒有出口，建一個把記錄丟進虛空的協調器只會讓熱路徑白付投影與脫敏的成本。
       *
       * **一份會話一個協調器，而且新開的那些自動有。** 這是 dsh 的形狀——它的 live
       * capture「subscribes to the session firehose」並且「sweeps already-live sessions」
       * （`packages/session/session-telemetry/src/coordinator.ts` 檔頭），per-session 的
       * 狀態掛在以 session 為鍵的 `WeakMap` 上。subagent 的日誌因此不必有人記得重接。
       *
       * @param sessions - 這次組裝的會話註冊表。
       * @returns 收掉這一次接線的函式，或沒掛後端時的 `undefined`。
       */
      attachTelemetry(sessions: SessionRegistry): (() => Promise<void>) | undefined {
        const mounted = registry.telemetry.service();
        if (mounted === undefined) return undefined;
        const mine = new Set<SessionTelemetryCoordinator>();
        const unobserve = sessions.observe(({ log }) => {
          const coordinator = new SessionTelemetryCoordinator({
            log,
            sink: mounted.value,
            // 現讀而不是快照：`rules()` 每次捕獲都重新問一遍，補送歷史時套的是**現在**
            // 掛著的策略。這是 dsh waterfall 的語意，折疊要接得住。
            rules: () => registry.telemetry.rules(),
          });
          attached.add(coordinator);
          mine.add(coordinator);
        });
        return async () => {
          unobserve();
          for (const coordinator of [...mine]) {
            mine.delete(coordinator);
            attached.delete(coordinator);
            await coordinator.dispose();
          }
        };
      },
      /**
       * 把一份會話日誌接上註冊著的不變量配套入口。**沒有人註冊時回 `undefined`**——
       * 同 `attachTelemetry` 的理由：沒有檢查就不要在熱路徑上多掛一個訂閱。
       *
       * 過濾器（`enabled` / allowlist / blocklist）從 {@link CreateNexusAgentOptions.invariants}
       * 來，**原樣轉下去**。沒給就是全裝。違規的去處同理，從
       * {@link CreateNexusAgentOptions.onInvariantViolation} 來，沒給就是 runner 的預設。
       *
       * **`companions.length === 0` 這一條擋在過濾之前，不是之後**：這裡問的是「有沒有
       * 人註冊」，而不是「過濾完還剩幾個」。過濾成空集合是一個有效的選擇結果，runner
       * 照樣要接（它擁有訂閱與失敗語意），只是一個檢查都不裝。
       *
       * **每一份會話各一個 runner**，同 dsh 的配套入口（`for (const session of
       * ctx.sessions.list()) seedSession(session)` 加 `ctx.on('session/created', …)`，
       * `packages/core/session/src/invariant.ts:218-220`）。subagent 的日誌因此不會變成
       * 一個沒有檢查的角落。
       *
       * @param sessions - 這次組裝的會話註冊表。
       * @returns 收掉這一次接線的函式，或沒有配套入口時的 `undefined`。
       */
      attachInvariants(sessions: SessionRegistry): (() => void) | undefined {
        const companions = registry.invariants.companions();
        if (companions.length === 0) return undefined;
        const runners: (() => void)[] = [];
        const unobserve = sessions.observe(({ log }) => {
          runners.push(
            createInvariantRunner({
              log,
              companions,
              ...(options.invariants !== undefined && { selection: options.invariants }),
              ...(options.onInvariantViolation !== undefined && {
                onViolation: options.onInvariantViolation,
              }),
            }),
          );
        });
        return () => {
          unobserve();
          // 倒著收，同 `load.ts` 收 lifecycle disposer 的順序。
          for (const stop of [...runners].reverse()) stop();
          runners.length = 0;
        };
      },
      /**
       * 把會話註冊表接上來：**綁給模型工具，並把每一份會話裝上 `sessions` 參與者**。
       *
       * **它做兩件事，而且不再有「沒有人註冊就回 `undefined`」那條短路。** 短路以前成立
       * 是因為這個口只餵參與者；現在它同時是模型工具問「我該寫進哪一份日誌」的那條線
       * （`registry.sessions.forCall`）。一個只註冊工具、沒有 `join` 任何參與者的 plugin
       * 在短路底下會永遠拿到「沒接上」，而那是一個**看起來像設定問題的假象**。
       *
       * **這裡沒有 selection 也沒有 `onViolation`。** 那兩樣是不變量的東西：一個回答
       * 「這個 package 的檢查要不要裝」，一個回答「違規往哪裡印」。參與者不產生違規，
       * 它產生的是事件；要不要裝它由清單那一層答（條目層的 `disabled`），而它自己壞掉
       * 只換來一行 warn。
       *
       * @param sessions - 這次組裝的會話註冊表。
       * @returns 收掉這一次接線的函式：退訂、解綁，再倒著收每一份會話的 runner。
       */
      attachSession(sessions: SessionRegistry): () => void {
        const installers = registry.sessions.installers();
        const unbind = registry.sessions.bind(sessions);
        const runners: (() => void)[] = [];
        const unobserve = sessions.observe(({ address, log }) => {
          if (installers.length > 0)
            runners.push(createSessionRunner({ address, log, installers }));
        });
        return () => {
          unobserve();
          unbind();
          for (const stop of [...runners].reverse()) stop();
          runners.length = 0;
        };
      },
      async dispose() {
        // 遙測先收：後端很可能是某個 plugin 開的，plugin 的 disposer 一跑它就沒了，
        // 那時再送 `shutdown` 標記等於送進一個已經關掉的東西。
        for (const coordinator of [...attached]) {
          attached.delete(coordinator);
          await coordinator.dispose();
        }
        await dispose();
      },
    };
  } catch (error) {
    // 清理自己失敗的話不能蓋掉原本的錯誤——那個才是使用者要修的東西。
    await dispose().catch(() => {});
    throw error;
  }
}

/**
 * plugin 註冊的工具不得佔用基座內建的名字。
 *
 * 基座自己有一道同樣意思的檢查（`createDeepAgent()` 開頭的 `BUILTIN_TOOL_NAMES`
 * → `ConfigurationError('TOOL_NAME_COLLISION')`），這裡先擋是為了兩件事：
 *
 * - **指名是誰。** 基座的訊息只說哪個工具名撞了，不知道是清單裡哪一個 plugin 註冊的——
 *   而 registry 每次註冊都記著 origin，這是我們比基座多知道的東西。
 * - **補上基座沒查的那半。** 它只檢查 root 的 `tools`。註冊到 subagent 層、或 subagent
 *   定義自帶的同名工具**不會**觸發它：那些工具跟該 subagent 那份 middleware stack 帶的
 *   內建檔案工具擠在同一個名字上，誰贏由基座內部的合併順序決定，而且是無聲的。
 *
 * 用的是 {@link RESERVED_BASE_TOOL_NAMES} 而不是 `foldRegistry` 收的 `baseToolNames`：
 * 那是兩個不同的集合，前者多了 async 那五個。理由見
 * [`base-tools.ts`](./base-tools.ts)——基座的保留是無條件的，而名字宇宙是條件式的。
 */
function assertNoBaseToolNameCollision(registry: PluginRegistry): void {
  const collisions: string[] = [];

  const collect = (name: string, where: string, cite: string): void => {
    if (RESERVED_BASE_TOOL_NAMES.has(name)) collisions.push(`${cite} 在${where}註冊了 "${name}"`);
  };

  for (const [name, entry] of registry.tools.effective()) {
    collect(name, '全域', formatOrigin(entry.origin));
  }
  for (const scope of registry.tools.scopes()) {
    for (const [name, entry] of registry.tools.own(scope)) {
      collect(name, `subagent "${scope}"`, formatOrigin(entry.origin));
    }
  }
  for (const [name, entry] of registry.subagents.entries()) {
    for (const tool of entry.value.tools ?? []) {
      collect(tool.name, `subagent "${name}" 自帶的工具裡`, formatOrigin(entry.origin));
    }
  }

  if (collisions.length === 0) return;
  throw new Error(
    `工具名撞到基座保留的名字：${collisions.join('；')}。` +
      `這些名字歸基座的 middleware stack 所有（檔案系統工具、task、async 任務那組），` +
      `佔用它們不會取代基座的版本，只會讓兩個同名工具擠在一起。換個名字。` +
      `目前被保留的：${[...RESERVED_BASE_TOOL_NAMES].sort().join('、')}`,
  );
}
