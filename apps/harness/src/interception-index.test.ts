/**
 * 攔截時刻的索引：**dsh 的九個時刻裡，我們佔住的那四格分別是誰佔的、又比標準少了什麼。**
 *
 * 圖是 [#190](https://github.com/DemianLi/nexus-agent/issues/190)，這一份是它的候選 3
 * （[#193](https://github.com/DemianLi/nexus-agent/issues/193)）。九格逐格的核對過程在
 * 那張圖上，**這裡不重複論證，只保留索引與那條防漂移的斷言**。
 *
 * ## 為什麼是這裡，而不是 `registry.ts` 的檔頭
 *
 * 最直覺的家是 `PluginRegistry` 的十九個欄位。**那是錯的軸**：第 2、6、7 格全擠在
 * `middleware` 一個欄位，第 3 格落在 `apps/harness` 根本沒有欄位，而第 6／7 格的**位置**
 * 是 `fold.ts` 決定的、不由註冊順序決定——欄位這一軸連「排在第幾個」都表達不出來。
 * #190 記著同型的坑：grep `lifecycle` 找生命週期鉤子會落到關機 disposer 上。
 *
 * ## 判準：拿時刻名 grep 得不得到佔住它的人
 *
 * 開卡時量過，**五格佔住的只有一格半 grep 得到**，而 `tools/post-execute` 會把人帶到
 * `repeat-reminder.ts`——那個檔案提到這個名字，是為了說「投遞掛在 `beforeModel`，
 * **不是** post-execute」。所以這一份的第一產物是**佔用者身上那幾行 JSDoc**，索引是閱讀面，
 * 下面那條斷言是絆索。
 *
 * ## 每一列三件事，不是一個判決
 *
 * #190 開圖時寫「每格收成 (a)/(b)/(c) 三選一」，兩張子卡答完發現**最有資訊量的兩格都是
 * (a) 與 (b) 同時成立**（第 2 格機制在、紀錄不在；第 7 格佔住了、位置點不到）。所以每列把
 * 缺口拆成 {@link InterceptionRow.permissionDelta}（權限差）與
 * {@link InterceptionRow.recordDelta}（紀錄差）——**只有一欄判決的索引寫不下那兩格**。
 *
 * 第三欄 {@link InterceptionRow.frequencyDelta}（頻率差）是
 * [#218](https://github.com/DemianLi/nexus-agent/issues/218) 補的，來源是
 * [#215](https://github.com/DemianLi/nexus-agent/issues/215) 第 2 題量到的一件事：第 2 格的
 * **事件名對得上而節奏對不上**。它跟上面兩欄有一處**刻意的不對稱**——那兩欄的 `undefined`
 * ＝ 量過、對得上，頻率這一欄則是**必填**，沒量的寫 {@link UNMEASURED}。
 * **量過的只有第 2 格**：它 2026-09-12 起空了一段，2026-09-18 由 #388 的工作區指令基線重新佔住，
 * 頻率也在新佔用者身上重量過（見下面第 2 列）。其餘四列全是沒量，不是對得上。
 *
 * ## 缺口帳：四筆，其中兩筆是同一個缺件
 *
 * 前三筆已經散在三個檔頭裡，沒有被漏掉，只是沒有被索引；第 4 筆的家是下面第 4 列自己與
 * `.docs/plugin-architecture-gap-survey.md` §五第 7 條。**這一份只負責認帳，不決定要不要
 * 補**——「圖裡發生的事有沒有一條進日誌的路」是 #190 的候選 5，射程在那裡。
 *
 * 1. ~~**第 7 格位置點不到**~~——**2026-09-13 由
 *    [#252](https://github.com/DemianLi/nexus-agent/issues/252) 收掉**：輸出校驗搬進 `@nexus/core`，
 *    由 fold 打底在每一個 plugin middleware 的內側，位置不再靠註冊順序。`MiddlewareRegistrationPoint`
 *    仍然只有 `prepend` 一根槓桿，但這一格已經沒有 plugin 要搶最內。
 * 2. **第 2 格終止原因記不下來**——`turn/*` 由入口點在**圖外**附加（`thread-pump.ts` 的
 *    `#runOnce`、`cli.ts` 的 `runTurn`），所以 `jumpTo: 'end'` 跳掉的輪次在日誌上與正常
 *    跑完的長得一模一樣，dsh 的「blocked 輪次」表達不出來。
 * 3. ~~**第 9 格工具事件缺席**~~——**2026-09-12 由
 *    [#264](https://github.com/DemianLi/nexus-agent/issues/264) 補上**：`tool/call`／`tool/result`
 *    進了日誌，生產者是第 6 列的圍堵（圖裡的 middleware，不是入口點）。**第 9 格照舊沒有列**：
 *    dsh 那格是只觀察的 `mode: 'emit'` 通知，佔住它的是**聽者**，而我們這側讀 `tool/result`
 *    的只有遙測協調器——它照單全收每一顆事件，不是為這一格掛的。`goal-driver.ts` 檔頭那條
 *    婉拒 #180 停損的理由跟著改寫了：量得到了，結論沒變。
 * 4. **第 4 格核准的審計事件**——dsh 每次 request 一對 `approval/asked` ＋
 *    `approval/decided`；我們 #1029 起也有（人那條由 pump 寫、不必問人的由閘門寫），逐條在第 4 列的紀錄差。
 *    這一條原本是「認帳不做」（[#220](https://github.com/DemianLi/nexus-agent/issues/220)），#1018 Q2 翻案。
 *
 * **第 2 與第 3 筆原本是同一個缺件**（圖裡發生的事沒有一條進日誌的路）。第 3 筆補上的方式是
 * **讓圖裡的 middleware 自己寫**（同 `model/usage`），不是補那條路——所以第 2 筆照舊開著：
 * `jumpTo: 'end'` 跳掉的輪次仍然只有圖外的入口點看得到結尾。第 4 筆與第 2 筆**只是同一個
 * 結構成因**（紀錄由入口點在圖外附加），**不是同一個缺件**——理由寫在第 4 列那一欄裡。
 *
 * ## 沒有進索引的四格
 *
 * 第 1（`agent/session-start`）、5（`ctx.tools.guard()`）、8（`ToolDefinition.finalizeContent`）、
 * 9（`tools/result`）格今天沒有佔用者，所以索引裡沒有它們的列——**這一份索引的軸是「誰佔住」，
 * 空格沒有東西可指**。第 5 與第 8 格是 #190 的候選 4，第 9 格見上面的缺口帳。
 *
 * **第 2 格空過一段，2026-09-18 又有佔用者了。** 它原本的佔用者是 plan-mode 的
 * `beforeAgent`——「`/plan` 選好的模式在下一次 agent 呼叫開頭交成 state update」，自己登記為
 * dsh `agent/pre-step` **邊界提交**的對應物。[#251](https://github.com/DemianLi/nexus-agent/issues/251)
 * 的第二刀把計劃模式搬進會話日誌、`/plan` 當場寫進去，那一格 pending intent 跟著收掉，
 * `beforeAgent` 就沒了；[#388](https://github.com/DemianLi/nexus-agent/issues/388) 的工作區指令
 * 基線又長出一個，**所以第 2 列是重建的，不是搬回來的**——三件事逐件重判：
 *
 * - **攔截那半**（`jumpTo: 'end'`）：基座做得到（#192 實測，裸基座與我們的組裝一致，模型呼叫
 *   次數 0、無模型可見訊息），鉤子要寫成 `{ hook, canJumpTo: ['end'] }` 才裝得上 router，
 *   而產品程式碼零使用——**它從來就沒有佔用者**，新的這一個也不用它（基線只注入，不攔截）。
 *   所以它照舊不算在這一列的佔用上，只寫進權限差。
 * - **紀錄差**（終止原因記不下來）：不看佔用者，照舊是上面缺口帳的第 2 筆。
 * - **頻率差**：**2026-09-18 重量過，不是照抄** —— 見下面第 2 列。舊那一筆量的是 plan-mode 那個
 *   `beforeAgent` 的節奏；新的佔用者節奏相同（每次 agent 呼叫一次），但這次是**在新佔用者身上量的**
 *   （`agent-instructions.test.ts` 的兩輪那條、`probe` 的三組 super-step 對照）。`beforeModel` 仍然是
 *   圖裡每步一格的節點（`repeat-reminder.ts` 掛在上面），但它不是 pre-step 注入。
 *
 * **plan-mode 在 [#652](https://github.com/DemianLi/nexus-agent/issues/652) 又回到這一格，佔的是邊界提交那半**：
 * `exit_plan_mode` 改走提問通道之後，同意不當場寫 `plan/mode`，排一格待關到下一步之前才交，同 dsh 的
 * `pendingIntents`。這一次載體是它本來就有的 `wrapModelCall`，不是當年的 `beforeAgent`——所以節奏是每一步，
 * 不是每次 agent 呼叫；下面那條 `beforeAgent:` 掃描把它列成明寫的例外。
 *
 * **九格之外的縫也沒有列。** dsh 的 `approval/request`（應答者 waterfall）不是那九個時刻名
 * 之一，落不進這個軸；它記在第 4 列的權限差裡，因為第 4 格是我們這側唯一的提問者。規矩往
 * 前推是一句話：**軸就是那九格，九格之外的東西只能掛在有關係的那一列上，不另開列。**
 *
 * ## dsh 那側的字串
 *
 * 九個時刻名逐字對過 `references/deepseek-harness`，SHA
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`（2026-09-04）。**那份 clone 不進版控**，所以
 * 下面的斷言只驗我們這側；dsh 那側要重對時自己 `git -C references/deepseek-harness fetch`
 * 再對 SHA，clone 會凍在 clone 當下。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scanEventTableTree } from './event-table-scan.js';

/** 這個 repo 的根。從 `apps/harness/src/` 往上三層。 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * 「這一格的頻率**沒有量過**」——見 {@link InterceptionRow.frequencyDelta}。
 *
 * **不是「量過、對得上」**：那是隔壁兩欄 `undefined` 的意思，而頻率這一軸今天量過的只有第 2 格。
 */
const UNMEASURED = '（未量）';

/**
 * 「這一格現在**沒有**由任何事件佔住」——見 {@link InterceptionRow.eventOccupant}。
 *
 * 事件匯流排在 S0 落地（[#1217](https://github.com/DemianLi/nexus-agent/issues/1217)），但事件表是空的、沒有生產者，所以
 * 九格都還由 middleware 佔著。**這是 [#190](https://github.com/DemianLi/nexus-agent/issues/190) 偏離登記「推翻」的那一刀**：
 * 登記的前提（基礎建設表達不出事件匯流排）不再成立，這份索引從此多一個軸，S1 起逐格往下填。
 */
const NO_EVENT = '（尚無）';

interface InterceptionRow {
  /** #190 那張表的格號。 */
  readonly cell: number;
  /**
   * **現在由哪個事件佔住這一格**（#1217 起）：事件表上的事件名，或 {@link NO_EVENT}。
   *
   * 必填，而且填的名字必須真的宣告在事件表上（見下面「事件佔用」那條斷言）——**不替沒有生產者的格子寫上一個預期的事件名**。
   * 一格可以同時有 middleware 佔用者與事件：遷移途中兩者並存（草稿 §五的絞殺式），事件那一側才是終點。
   */
  readonly eventOccupant: string;
  /** dsh 的時刻名，**逐字**。這是 grep 的入口，也是下面斷言要在佔用者身上找的字串。 */
  readonly moment: string;
  /** dsh 給這個時刻的權限。 */
  readonly permission: string;
  /**
   * 佔住它的檔案，repo 相對路徑。
   *
   * **每一個都必須提到 {@link moment}。** 那不是形式——那就是這一份的判準本身。
   */
  readonly occupants: readonly string[];
  /** 權限那一軸比 dsh 少了什麼。`undefined` ＝ 三欄逐欄對得上。 */
  readonly permissionDelta: string | undefined;
  /** 紀錄那一軸比 dsh 少了什麼。`undefined` ＝ 沒有紀錄面的缺口。 */
  readonly recordDelta: string | undefined;
  /**
   * 頻率那一軸比 dsh 少了什麼。**{@link UNMEASURED} ＝ 沒量過**，不是「對得上」。
   *
   * **這一欄刻意必填**，不跟上面兩欄一樣用缺席表達。那兩欄的 `undefined` ＝ 量過、沒有缺口；
   * 頻率這一軸量過的只有第 2 格。做成選填的話，新增一列時省略它是無聲的，而讀者會照隔壁
   * 兩欄的規矩把缺席讀成「對得上」——**誤讀的方向剛好是錯的那一邊**。
   *
   * **型別沒有在擋內容**：`string` 收任何字串，哨兵是約定不是護欄。承重的是必填。
   */
  readonly frequencyDelta: string;
}

/**
 * 五條。**#190 九格核完時 (a) 是五格**，第 2 格 2026-09-12 起空了一段、2026-09-18 由 #388
 * 重新佔住（見檔頭）；沒有佔用者的四格不在這裡。
 */
const INDEX: readonly InterceptionRow[] = [
  {
    cell: 2,
    eventOccupant: NO_EVENT,
    moment: 'agent/pre-step',
    permission: '讀／改這一步要送出的訊息批次，可 `jumpTo: "end"` 收掉這一輪',
    occupants: [
      'packages/nexus-plugin-agent-instructions/src/index.ts',
      // 邊界提交（#652）：`exit_plan_mode` 同意之後的待關在下一步請求組起來之前交出去，同 dsh。
      // 載體是 `wrapModelCall`，不是 `beforeAgent`，見下面 `PRE_STEP_OTHER_CARRIERS`。
      'packages/nexus-plugin-plan-mode/src/index.ts',
    ],
    permissionDelta:
      '**邊界提交那半由 plan-mode 佔著**（#652）：`exit_plan_mode` 同意之後排一格待關，下一次模型呼叫' +
      '前由它的 `wrapModelCall` 寫進 `plan/mode`，同 dsh 在 pre-step 提交 `pendingIntents`。' +
      '`wrapModelCall` 每次模型呼叫都跑、不是圖節點，所以那一半的節奏與 dsh 同（每一步），也不多一格。' +
      '**注入那半只佔了一部分**：dsh 拿得到整個 `decision.messages` 自己 splice（插在已領取的訊息之後），' +
      '我們的 `beforeAgent` 只能**追加**——刪不掉、也指定不了位置，位置由基座決定' +
      '（2026-09-18 實測落在使用者那一句之後，與 dsh 同位，但那是基座的行為不是我們的選擇）。' +
      '攔截那半（`jumpTo: "end"`）照舊零使用，見檔頭。',
    recordDelta: undefined,
    frequencyDelta:
      'dsh 每一步都發，我們一次 agent 呼叫只發一次——**2026-09-18 在新佔用者身上重量**：' +
      '同一條 thread 送第二句話會再進一次（`agent-instructions.test.ts` 靠去重擋住第二份），' +
      '同一次 invoke 的第二輪不會。價錢是**每次 invoke 一格、每輪零格**（上限 100：33 輪變 32 輪；' +
      '#394 寫的「零」是上限 20 被 floor 吃掉的讀數）。摘要把基線切掉之後，dsh 下一步就補回、' +
      '我們等到下一次 invoke（#397，登記在 plugin 檔頭）。要「每一步」的東西這一格撐不住，' +
      '得換每輪多一格的 `beforeModel`（33 輪變 24 輪）——#389 因此以 not planned 關閉，重開條件在卡上。',
  },
  {
    cell: 3,
    eventOccupant: NO_EVENT,
    moment: 'agent/turn-stopping',
    permission: 'awaited 通知，聽者可以要求再跑一步（`agent.steer()`）',
    occupants: ['apps/harness/src/goal-driver.ts'],
    permissionDelta:
      '**只佔了一半**：聽者要求再跑一步的口（`agent.steer()` 給聽者用的那一面）沒有等價物，輪迴圈歸入口點所有。' +
      '載體偏離已登記在該檔檔頭；今天只有 goal 一個消費者，一個消費者不撐起一條通道。' +
      '人插話的那一面有了（#710，`@nexus/core` 的 `step-inbox.ts`），但它由 pump 送進圖、不經這個時刻。',
    recordDelta: undefined,
    frequencyDelta: UNMEASURED,
  },
  {
    cell: 4,
    eventOccupant: NO_EVENT,
    moment: 'tools/pre-execute',
    permission: 'waterfall，allow／deny／ask',
    occupants: ['packages/nexus-core/src/approval.ts'],
    permissionDelta:
      '**三格決策詞彙對得上，`ask` 的去向對不上。** dsh 的 `ask` 送進一條**可組合的應答者' +
      ' waterfall**（`approval/request`，' +
      '`references/deepseek-harness/packages/interaction/user-approval/src/types.ts:85`）：回一個' +
      '結果就是替那個 agent 作答，否則 `next()`，UI 通道與 ACP 橋接各是一位應答者。' +
      '我們的 `registry.approvals` **只收提問者**（`gate()`），應答者是 `approval.ts` 裡寫死的' +
      ' `interrupt(...)`，而 `ApprovalChannel` 是 `fold.ts` 折疊當下的一個判決、**不是掛點**，' +
      '所以機器應答者在我們這側沒有位置可掛。結果詞彙也跟著窄一格：dsh 的 `ApprovalOutcome`' +
      ' 四值（`types.ts:32`），我們的**應答**只有 approve／reject（`cancelled` 不是人答的，是停止收回時由 pump 記，#1029）。' +
      '**`approval/request` 是第十條縫，不在 #190 那九個時刻名裡**，所以它沒有自己的列；' +
      '記在這一列是因為第 4 格是我們這側**唯一的提問者**' +
      '（例如 `packages/nexus-plugin-submit-record/src/index.ts` 的 `approvals.gate`，`submit_record` 回 `ask`；' +
      'plan-mode 以前也掛一位，#652 照 dsh 改走提問通道，不在這裡了）。',
    recordDelta:
      '**核准的問與答各有一顆事件（#1029，翻了 #220 的「認帳不做」）。** 照 dsh 每次 request 追加 ' +
      '`approval/asked` ＋ `approval/decided`（`user-approval/src/types.ts:44-58`，log-only audit，帶 id／' +
      '工具名／call id／理由／結果），詞彙同 dsh 的 `ApprovalOutcome` 四值。**兩個生產者都在圖外的事實沒變**' +
      '（`apps/harness/src/thread-pump.ts`，`cli.ts` 傳 `HEADLESS_APPROVALS` 所以永遠不問人），' +
      '但事件的寫法因此分兩條：人那條由 pump 在記 `interrupt/raised` 的同一刻寫 asked、收到回覆或收回時寫 decided' +
      '（閘門在圖內、`interrupt()` 回來後從頭重跑，在它前面寫會是兩筆）；不必問人就確定的（政策關掉 → `rejected`、' +
      '沒有管道 → `unavailable`、子代理一律 `policy-never`）由閘門在圖內一次寫一對。listener 直接 `deny` 不寫，' +
      '同 dsh（只有 `ask` 才進核准服務）。**dsh 沒有而我們多的一格**：核准拒絕的 `tool/result` 帶碼' +
      '（`APPROVAL_REJECTED_BY_USER`／`APPROVAL_POLICY_NEVER`／`APPROVAL_NO_CHANNEL`／`TOOL_DENIED_BY_LISTENER`），' +
      '依據是 #1018 Q2 拍板的「拒絕帶原因碼」（卡上說 dsh 也帶，是讀錯：dsh 的核准拒絕結果沒有 info），載體用 dsh 的 `deny.info` 那一格。' +
      '**還沒有的**：`cancelled` 只在停在核准點按停止時寫（pump 的 `#withdraw`）；' +
      "**政策事件**（#437）：`approval/policy` 記政策（`ask`／`never`）的起始值與每次切換，子代理日誌補一顆 `source: 'delegation'`；" +
      '但日誌上 `approval/decided` 的 `rejected` 仍分不出人拒與政策拒，那一次呼叫要看 `tool/result` 的碼；' +
      '`request_sandbox_escalation` 在本體裡的政策／無管道拒絕不寫 `approval/*`（只有人那條路會）。',
    frequencyDelta: UNMEASURED,
  },
  {
    cell: 6,
    eventOccupant: NO_EVENT,
    moment: 'tools/execute',
    permission: '環繞 waterfall（超時／重試／指標）',
    occupants: [
      'packages/nexus-core/src/containment.ts',
      'packages/nexus-core/src/fold.ts',
      'packages/nexus-core/src/invalid-tool-args.ts',
      'packages/nexus-core/src/turn-cancel.ts',
      'packages/nexus-plugin-plan-mode/src/index.ts',
      'packages/nexus-core/src/output-schema.ts',
      // 檔案工具的失敗標成錯誤（#293）：dsh 在工具本體裡拋，我們貼著本體換狀態。
      'packages/nexus-core/src/fs-tool-errors.ts',
      // 耐久檢查點（#599）：dsh 的 `session-checkpoint-policy` 本來就掛在這一格，呼叫動手之前排空（root 與子代理）。
      'packages/nexus-core/src/session-checkpoint-policy.ts',
      // 讀檔結果最後補上讀到哪（#594）：dsh 在 `read` 本體裡寫，我們貼著本體補。
      'packages/nexus-core/src/read-continuation.ts',
      // 子代理撞到輸出上限（#433）：dsh 在前景 `task` 本體裡拋，我們貼著本體換掉結果。
      'packages/nexus-core/src/max-tokens.ts',
    ],
    permissionDelta:
      '**這一格與第 4、7 格在我們這側是同一種機制的三個陣列位置**，dsh 那三格是三種權限' +
      '不同的東西。位置由 `fold.ts` 決定，不由註冊順序決定。',
    recordDelta: undefined,
    frequencyDelta: UNMEASURED,
  },
  {
    cell: 7,
    eventOccupant: NO_EVENT,
    moment: 'tools/post-execute',
    permission: '檢查／變換 waterfall，可 `additionalContexts`',
    occupants: ['packages/nexus-core/src/output-schema.ts'],
    permissionDelta:
      '佔用者是 dsh 在這一格**之前**的那一步（`createSuccessResult` 驗 `output.schema`），' +
      '不是 post-execute 的 listener——我們這側兩者共用一個 `wrapToolCall` 載體。' +
      '位置 2026-09-13 起由 fold 決定（[#252](https://github.com/DemianLi/nexus-agent/issues/252)，' +
      '檔頭缺口帳第 1 筆收掉）。另外 `additionalContexts` 的射程只到' +
      '「單一生產者、一則脈絡、成功路徑」——交錯順序、失敗路徑收集、被外層阻止時丟棄' +
      '三條契約今天零生產者也就零驗證，**第二個生產者出現就要重判這一格**。',
    recordDelta: undefined,
    frequencyDelta: UNMEASURED,
  },
];

/** 索引的列數。**釘死是刻意的**：只 grep 不數，刪掉一列這份測試照樣綠。 */
const EXPECTED_ROWS = 5;

/** 佔用位址的總數（列可能共用檔案，第 6 與第 7 格就共用 `output-schema.ts`）。 */
const EXPECTED_SITES = 15;

/**
 * 第 2 列的承重事實：全樹的產品程式碼裡，`beforeAgent:` 的實作**恰好就是這一列列出的那些**。
 *
 * **這條翻過兩次面。** 它原本釘的是「第 2 列的佔用者是 `beforeAgent` 形狀」（頻率差靠它
 * 撐著）；[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的第二刀拿掉了那個佔用者，
 * 它翻成「一個都沒有」；[#388](https://github.com/DemianLi/nexus-agent/issues/388) 又長出一個，
 * 它翻回「恰好是這幾個」。**兩個方向都會紅**：多一個沒進索引的佔用者會紅（該重量頻率差、
 * 重判權限差，上一個佔用者的那一筆不能照抄），少一個也會紅（第 2 列該搬出索引）。
 *
 * `beforeModel`、`wrapModelCall` 不算：它們是別的節點，第 2 格當年就判過它們不是 pre-step
 * 注入。掃的範圍同門 B 那條（`session-resume-doors.test.ts`）：只掃產品原始碼，測試與 fixture 排除。
 *
 * **例外明著列**：第 2 列裡不是靠 `beforeAgent` 佔住的那幾個，見 {@link PRE_STEP_OTHER_CARRIERS}。
 */
const PRE_STEP_ROOTS = ['apps/harness/src', 'apps/web/src', 'packages'] as const;

/**
 * 第 2 列裡**載體不是 `beforeAgent`** 的佔用者，下面那條掃描不找它們。
 *
 * plan-mode 佔的是 dsh pre-step 的**邊界提交**那半（#652）：待關在下一次模型呼叫前交出去，載體是它本來就有的
 * `wrapModelCall`——那是每次模型呼叫都跑的包裹，不是注入，也不是圖節點。列在這裡而不是讓掃描放寬，
 * 是因為放寬成「`wrapModelCall` 也算」會把十幾個與 pre-step 無關的 `wrapModelCall` 一起掃進來。
 */
const PRE_STEP_OTHER_CARRIERS: readonly string[] = ['packages/nexus-plugin-plan-mode/src/index.ts'];

/**
 * 掃描會找到、但**不是**第 2 列佔用者的 `beforeAgent:` 實作。
 *
 * `patch-tool-calls.ts`（補懸空的工具呼叫，接縫 6）：載體是 `beforeAgent`，卻不是 dsh `agent/pre-step`
 * 的佔用者——它**修復歷史**（整串訊息換掉），不注入內容、不提交待辦。dsh 對同一件事的位置**不在 pre-step**：
 * `agent-loop/src/index.ts` 的續行準備（open session 之後、`prepare` 之前）呼叫 `interruptedTurnClosers`，
 * 把「缺的工具結果、step/end、turn/end」**寫進日誌**（2026-10-07 對過 dsh `5badb150`）。我們的版本只在
 * 每次 invoke 開頭改圖裡的狀態、不寫日誌，這個差距與接縫 6 同批登記在 PR 內文，不在這份索引的軸上。
 *
 * 它從基座時代就是 `beforeAgent` 載體，只是住在 `node_modules`，這一條掃描看不到；搬進我們的樹才現形。
 *
 * `skills-middleware.ts`（[#440](https://github.com/DemianLi/nexus-agent/issues/440)）：包基座的 skills middleware，
 * `beforeAgent` 只是把基座那顆的「掃一次 skill 目錄」轉過去、並在掃到空的之後不再轉。它**不注入、不提交待辦**
 * （注入發生在 `wrapModelCall`，而且空的時候連那個也放行），所以不佔 pre-step。同樣是基座時代就有、搬進樹才現形。
 */
const PRE_STEP_NOT_OCCUPANTS: readonly string[] = [
  'packages/nexus-core/src/patch-tool-calls.ts',
  'packages/nexus-core/src/skills-middleware.ts',
];

/** 遞迴列出產品原始碼的 `.ts`。 */
function productSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...productSources(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.fixture.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * 第 4 列紀錄差的**承重事實**，兩半：
 *
 * 1. **有**：`approval/asked`、`approval/decided` 兩顆事件種類都宣告了（#1029）。這是翻面後的樣子——原本寫的是
 *    「完全沒有任何 `approval/` 開頭的名字」，它在那兩顆落地的那天紅了，紅的地方正是要重寫的那一欄。
 * 2. **有**：`approval/policy`（#437，dsh 用它記政策切換）。翻面後的樣子——原本這一條寫「還沒有」，它在這顆落地的那天紅了，
 *    紅的地方正是要重寫的那一句。
 *
 * 掃的是種類的**寫法**（聯集的 `| 'approval/…'`，或映射／宣告合併裡的 `'approval/…':` 鍵）而不是整個檔案，
 * 所以散文裡提到事件名不會誤觸。**掃的範圍不只 `session-log.ts`**（#679）：照 dsh，擁有者套件可以用
 * `declare module '@nexus/core'` 把自己的事件種類補進 `SessionEventMap`（見 {@link declaredEventKeyBlocks}）。
 *
 * **它釘不住那一欄的其餘部分**：生產者在不在圖外、人那條路由誰寫，都要自己讀。這是這份索引每一條斷言共同的限制，見檔頭。
 */
const RECORD_ANCHOR = {
  cell: 4,
  path: 'packages/nexus-core/src/session-log.ts',
  /** 事件種類的鍵（映射／宣告合併的寫法）。 */
  present: [
    /^\s*'approval\/asked'\s*:/mu,
    /^\s*'approval\/decided'\s*:/mu,
    /^\s*'approval\/policy'\s*:/mu,
  ],
} as const;

/**
 * 一份原文裡每個 `declare module '@nexus/core' { … }` 區塊的內文（花括號配對取到對的那一個）。
 * 擁有者套件用它補 `SessionEventMap`，所以那裡面的鍵也算事件種類。
 */
function declaredEventKeyBlocks(source: string): string[] {
  const blocks: string[] = [];
  const opener = /declare\s+module\s+['"]@nexus\/core['"]\s*\{/gu;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
    }
    blocks.push(source.slice(match.index + match[0].length, i));
  }
  return blocks;
}

/** 寫了事件名、但事件表上沒有這個事件的列（格號）。不替沒有生產者的格子寫上預期的名字：事件跟它的第一個生產者同一張 PR 落地。 */
function rowsNamingUndeclaredEvents(
  rows: readonly InterceptionRow[],
  declared: ReadonlySet<string>,
): number[] {
  return rows
    .filter((row) => row.eventOccupant !== NO_EVENT && !declared.has(row.eventOccupant))
    .map((row) => row.cell);
}

describe('攔截時刻索引', () => {
  it(`剛好 ${EXPECTED_ROWS} 列，${EXPECTED_SITES} 個佔用位址`, () => {
    // 兩個數字都釘死，因為這條測試的失敗模式是**沒東西可掃**：只驗「每一列都對」的話，
    // 把列刪光它會永遠綠。
    expect(INDEX).toHaveLength(EXPECTED_ROWS);
    expect(INDEX.flatMap((row) => row.occupants)).toHaveLength(EXPECTED_SITES);
    expect(new Set(INDEX.map((row) => row.moment)).size).toBe(EXPECTED_ROWS);
  });

  it('事件佔用：填的不是「尚無」就必須是事件表上真的有的名字；S0 事件表是空的，所以九格都還沒有', () => {
    const declared = new Set(scanEventTableTree(REPO_ROOT).map((event) => event.name));
    expect(rowsNamingUndeclaredEvents(INDEX, declared)).toEqual([]);
    expect(INDEX.map((row) => row.eventOccupant)).toEqual(INDEX.map(() => NO_EVENT));
    // 正向對照：一個編造的名字確實被這條規矩擋下來，不是因為空表而永遠綠。
    const invented = { ...INDEX[0]!, eventOccupant: 'x/not-declared' };
    expect(rowsNamingUndeclaredEvents([invented], declared)).toEqual([invented.cell]);
  });

  it.each(INDEX.map((row) => [row.cell, row.moment, row] as const))(
    '第 %s 格 %s 的每個佔用者都提到這個時刻名',
    (_cell, moment, row) => {
      expect(row.occupants.length).toBeGreaterThan(0);
      for (const path of row.occupants) {
        // **刻意直接讀、不 glob**：檔案被改名時要當場炸，而不是靜靜地掃到零個檔案。
        const source = readFileSync(join(REPO_ROOT, path), 'utf8');
        expect(source.length).toBeGreaterThan(0);
        expect(source, `${path} 沒有提到 ${moment}`).toContain(moment);
      }
    },
  );

  it('第 2 格的 `beforeAgent:` 實作恰好是索引裡列的那幾個', () => {
    const listed = (INDEX.find((row) => row.cell === 2)?.occupants ?? []).filter(
      (path) => !PRE_STEP_OTHER_CARRIERS.includes(path),
    );
    const found: string[] = [];
    for (const root of PRE_STEP_ROOTS) {
      for (const file of productSources(join(REPO_ROOT, root))) {
        if (/\bbeforeAgent\s*:/u.test(readFileSync(file, 'utf8'))) {
          const relative = file.slice(REPO_ROOT.length);
          if (!PRE_STEP_NOT_OCCUPANTS.includes(relative)) found.push(relative);
        }
      }
    }
    expect(
      [...found].sort(),
      '第 2 格（agent/pre-step）的佔用者變了。多的那個要進索引，而且**重量頻率差、重判權限差**' +
        '——每一個佔用者的節奏與拿得到的權限都要自己量；少了就把第 2 列搬出索引。',
    ).toEqual([...listed].sort());
  });

  it(`第 ${RECORD_ANCHOR.cell} 格的紀錄差靠「核准的問、答、政策三顆事件都有」撐著`, () => {
    const row = INDEX.find((candidate) => candidate.cell === RECORD_ANCHOR.cell);
    // 這一列的紀錄差是量過的，不能退回 `undefined`（那等於宣稱沒有紀錄面的缺口）。
    expect(row?.recordDelta).toBeTypeOf('string');
    const sources = [readFileSync(join(REPO_ROOT, RECORD_ANCHOR.path), 'utf8')];
    for (const root of PRE_STEP_ROOTS) {
      for (const file of productSources(join(REPO_ROOT, root))) {
        sources.push(...declaredEventKeyBlocks(readFileSync(file, 'utf8')));
      }
    }
    const declared = sources.join('\n');
    for (const pattern of RECORD_ANCHOR.present) {
      expect(
        declared,
        `第 ${RECORD_ANCHOR.cell} 列的紀錄差說核准的問、答與政策各有一顆事件，但 ${String(pattern)} 在 SessionEventMap 裡找不到`,
      ).toMatch(pattern);
    }
  });
});
