/**
 * 續行排程器的**決策那一半**：一輪收工之後，要不要再排一輪。
 *
 * **時刻：dsh 的 `agent/turn-stopping`**（awaited 通知，聽者可以要求再跑一步）。
 * 這個模組是那個時刻在我們樹上唯一的佔用者，但**只佔了一半**：dsh 那一格配一個
 * `agent.steer()` 讓聽者把下一步塞進去，我們沒有給聽者用的等價物——輪迴圈歸入口點所有，見下面
 * 那條載體偏離。人插話那一面有了（[#710](https://github.com/DemianLi/nexus-agent/issues/710)，
 * `@nexus/core` 的 `step-inbox.ts`），但它由 pump 送進圖，聽者碰不到。索引見 `apps/harness/src/interception-index.test.ts`。
 *
 * 形狀照 dsh 的 `packages/goal/goal-round-driver/`（對讀版本
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`，2026-09-04），
 * [#180](https://github.com/DemianLi/nexus-agent/issues/180)。
 *
 * ## 為什麼它落在 `apps/harness` 而不是一個 plugin——一筆登記過的載體偏離
 *
 * dsh 的 driver 是一個 Cordis plugin，靠 `agent/pre-step` 與 `ctx.agents` 的 idle 判斷把
 * 一輪排進 agent 的 inbox。我們的 `PluginRegistry` 十七條通道（`registry.ts:863-883`）
 * **沒有一條排得出一輪**——輪迴圈歸入口點所有（`thread-pump.ts` 的 `#runOnce`、
 * `cli.ts` 的 `runTurn`）。所以載體丟掉、紀律照抄，同 `containment.ts` 對
 * `guard/timeout-policy` 那一筆。
 *
 * **但檢查沒有跟著搬**：續行文字的 renderer 與驗它的不變量伴生都留在
 * `@nexus/plugin-goal`，判準是「只要 `kind: 'goal'` 這個詞彙存在，伴生就武裝」——與有
 * 沒有掛排程器無關。只在掛了排程器時才擋的檢查，對一顆手寫或寫壞的輪次是零防守。
 *
 * ## 這個模組是純的，`flush()` 不在裡面
 *
 * 決定與執行分開：這裡回一個**意圖**（排一輪／記一顆 blocker／閒著），呼叫端執行。
 * 耐久檢查點是呼叫端的事，而且順序是**決定 → flush → 再決定一次 → 送**——第二次決定
 * 抓的是「flush 期間有人插話進來」，它最容易被省略而且省略了不會有任何徵兆。
 *
 * ## 就緒不是「`turn/end` 到了」
 *
 * `thread-pump.ts` 自己寫著「跑完**與停在核准點**都算收工」，而 dsh 明文「完成、暂停和
 * 阻塞会阻止续行」。三格都要問，見 {@link decideGoalRound}。
 *
 * ## CLI 的那條額外停損：做的是這一條，不是 #180 要的那一條
 *
 * [#180](https://github.com/DemianLi/nexus-agent/issues/180) 第五節要求「旗標開著時 CLI
 * 要另有一條停損：連續 N 輪沒有任何工具成功就停」。**那一條經評估後刻意不做**，結論沒有
 * 變，理由少了一條（見第一點）：
 *
 * - 「連續 N 輪沒有工具成功」**以前量不到**，[#264](https://github.com/DemianLi/nexus-agent/issues/264)
 *   之後會話日誌有 `tool/result` 了。**但量得到不等於判得準**：`HEADLESS_APPROVALS` 是**拒絕**
 *   不是靜默，被拒的呼叫在日誌上是一顆 `isError` 而且沒碼的結果，跟工具自己拋錯長得一樣
 *   ——所以那個計數會把「沒有人在」數成「模型卡住了」，抓不到它要抓的那件事。量得到之後的
 *   評估歸地圖 [#263](https://github.com/DemianLi/nexus-agent/issues/263)，而那張圖拍過板：
 *   **會停下來的迴圈偵測不進執行期**。
 * - 「連續 N 輪沒有 `goal/change`」更糟：一個正常工作的模型可以幾十輪不碰 goal 工具，
 *   那是這條路的**正常樣子**，不是停滯。這個判準會在長任務中途把目標 block 掉。
 * - **一條會誤殺健康長任務的停損，比沒有停損更糟。**
 *
 * 做的是另一條，而且問的是完全不同的問題：**操作的人在命令列上講死一個輪數**
 * （`--max-goal-rounds`，見 {@link decideGoalRound} 的 `roundCap`）。它不猜停滯，所以誤殺
 * 不了任何東西——它回答的是「這一次呼叫我准你燒幾輪」。
 *
 * **為什麼非有一條不可**：`maxGoalRounds` 不是操作的人設得動的。`service.ts:269` 是
 * `request.maxGoalRounds ?? this.#defaultMaxGoalRounds`——`??` 而不是 `Math.min`，所以
 * 模型在 `create_goal` 裡自己填的那個數字**贏過**組裝點給的預設。「唯一的硬上限是
 * `maxGoalRounds`」在真 key 上等於「唯一的硬上限由模型自己挑」，那不是一條停損。
 *
 * **這是一筆登記過的載體偏離**：dsh 的 driver 沒有這一格（`goal-round-driver/src/index.ts`
 * 的第 166 行只讀 `goal.maxGoalRounds`）。它不需要——那是一個你要刻意掛載的 Cordis
 * plugin，選擇權在宿主那側；我們的等價物是一個旗標，而旗標後面直接是一支燒 API key 的
 * 迴圈（`cli.ts` 的 `driveGoalRounds`）。
 *
 * （2026-09-19 註：「刻意掛載」這半句要打折——dsh 的 base 其實出廠就掛著這顆 driver，擋續行的
 * 是行程本地、每次 `agent/created` 歸零的啟用狀態。多一條操作者上限這個偏離本身不受影響，見
 * `.docs/plugin-architecture-gap-survey.md` §三第 18 列。）
 *
 * 剩下的那一半照舊：`blockedAfterConsecutiveRounds`（預設 3）讓模型從第 3 輪起**可以**把
 * 自己 block 出去——那是准許不是保證，沒有東西逼它用。所以 CLI 開旗標時要把**兩條**上限
 * 都印出來、講明哪一條在管，見 `cli.ts`。
 *
 * @module
 */

import { currentTurnStart, hasUnansweredInterrupt } from '@nexus/core';
import type { GoalBlockReason, GoalId, GoalRef, SessionEvent } from '@nexus/core';
import { renderGoalRoundPrompt } from '@nexus/plugin-goal';
import type { GoalView } from '@nexus/plugin-goal';

/** 上限耗盡時記的那顆 blocker 的穩定代碼。逐字照 dsh。 */
export const ROUND_LIMIT_BLOCK_CODE = 'round-limit';

/**
 * 操作的人在命令列上給的那條上限用完時記的那顆 blocker 的代碼。
 *
 * **跟 {@link ROUND_LIMIT_BLOCK_CODE} 分成兩個名字**，因為成因不同，而且不同在哪正是要
 * 量的東西：一個是目標自己那個數字（模型挑的）用完了，另一個是人喊停。合成一個代碼的
 * 話，「模型自己收斂到上限」與「人設的閘先夾住它」在日誌上長得一模一樣。
 *
 * dsh 沒有這個代碼，見檔頭那筆登記。
 */
export const ROUND_CAP_BLOCK_CODE = 'round-cap';

/** 排得出一輪時，要交給入口點的東西。 */
export interface GoalRoundRequest {
  /** 送進模型的那一串字。**入口點拿同一個值同時寫日誌與構訊息**，見 `thread-pump.ts`。 */
  readonly text: string;
  readonly goalId: GoalId;
  readonly revision: number;
  readonly round: number;
}

/**
 * 為什麼這一刻排不出一輪。**每一種各有一個名字**，因為它們的成因不同——尤其
 * `turn-failed` 與 `turn-open`：合成一句「最後一顆不是 `turn/end`」的話，一次「拋錯之後
 * 照樣續行」的重構會通過每一條測試。
 */
export type GoalDriverIdleReason =
  /** 上一輪還在跑（沒有結尾）。 */
  | 'turn-open'
  /**
   * 上一輪**拋錯**結束。續行不重試，見 [#180](https://github.com/DemianLi/nexus-agent/issues/180) 的 Out of scope。
   * 不只這一次不排：{@link driveGoalRound} 還會收回續行授權，同 dsh 收到 `agent/error` 就 `disarm`
   * （`packages/goal/goal-round-driver/src/index.ts:246-249`，`477b4f4`）。
   */
  | 'turn-failed'
  /**
   * 上一輪**被人中止**（`turn/end` 帶 `reason.kind: 'aborted'`）。人按了停止，續行不接著排，也不會在人
   * 隨便再說一句話之後接回來——[#265](https://github.com/DemianLi/nexus-agent/issues/265) 的 Q8。
   * {@link driveGoalRound} 收回續行授權，要續行得走一次有人授權的 `resume`；同 dsh 在「被中止的不是自己排的
   * 那一輪」時直接 `disarm`（`packages/goal/goal-round-driver/src/index.ts:328-337`，`477b4f4`）。
   * 停在核准點時按停止的那一種（收回）也落在這裡：收回寫的是一輪 `resume` 帶 aborted 收尾。
   *
   * **偏離一格（Q8 拍板過）**：dsh 在被中止的是自己排的那一輪時，還會在下一個 idle 把目標暫停（改耐久相位）；
   * 我們只收回行程內的授權，相位與修訂號不動——Q8 寫的是「目標狀態不動」。
   *
   * **dsh 後來加的那一格我們已經有，機制不同**：dsh `9a8d21dfe75`／`c02925ed6b5`（2026-09-29，對讀 `5badb15009a`）
   * 讓 driver 在 idle 時把還排在佇列的續行預約從 inbox 撤回（`agent.inbox.remove(attempt.messageId)`），否則下一則
   * 人類輸入會先領到那份過期的預約、被 pre-step 拒掉，人的輸入就卡著。被中止的是別的工作時，dsh 只停用續行、不暫停目標，
   * 這一半與我們同。我們沒有 inbox 預約：續行是 pump 佇列裡沒有 `itemId` 的一件，那一輪收成中止時
   * `ThreadPump.#parkIfStopped`（`thread-pump.ts`） 把它整件拿掉（送出它的 promise 就此有結果），排在它後面的人類輸入照停住的規矩等下一次
   * 送出。`send-queue.test.ts` 的「排著的續行那一輪在停止落定時丟掉，不停住」釘住這一條，情境與 dsh 的
   * `queue-actions.e2e.ts` goal-stop 一致：人類那一輪在跑、續行排在後面、按停止、再送一句話只跑人類的那句，不跑續行。
   * 引用的行號（`246-249`、`328-337`、`329-331`）是 `477b4f4` 那一版，之後 dsh 的檔案已經位移。
   */
  | 'turn-aborted'
  /**
   * 上一輪**撞到了模型的輸出上限**（`turn/end` 帶 `reason.kind: 'max-tokens'`，
   * [#433](https://github.com/DemianLi/nexus-agent/issues/433)）。不只這一次不排：{@link driveGoalRound} 還會
   * 收回續行授權，要續行得走一次有人授權的 `resume`——同 dsh 的 `goal-round-driver` 看到 max-tokens 就
   * `disarm`（`packages/goal/goal-round-driver/src/index.ts:329-331`，`477b4f4`）。
   */
  | 'turn-max-tokens'
  /** 停在核准點，中斷還掛著。 */
  | 'interrupt-pending'
  /** 沒有目前的目標。 */
  | 'no-goal'
  /** 有目標但相位不是 active（完成、暫停、被擋住都算）。 */
  | 'not-active'
  /** 相位是 active 但這個 process 沒有續行授權。 */
  | 'disarmed';

/** 這一刻該做什麼。 */
export type GoalDriverDecision =
  | { readonly kind: 'run'; readonly round: GoalRoundRequest }
  | { readonly kind: 'block'; readonly ref: GoalRef; readonly reason: GoalBlockReason }
  | { readonly kind: 'idle'; readonly reason: GoalDriverIdleReason };

/**
 * 當前這一段物理輪次收工了沒——**拋錯結束與還在跑是兩件事**。
 *
 * **整個就緒判準都靠一件事成立：`turn/start` 在 `try` 之前 append。**
 * 兩個入口點都是這樣寫的（`thread-pump.ts` 的 `#runOnce`、`cli.ts` 的 `runTurn`，兩處都
 * 有註解說為什麼），所以「一輪跑過但日誌上沒有頭」這個狀態不存在。哪天有人把 append 挪進 `try` 裡，這裡讀到的就會是一個假的 idle。
 *
 * ## 這個行程裡一輪都還沒開始，算收工（[#661](https://github.com/DemianLi/nexus-agent/issues/661)）
 *
 * 以前這一格回 `no-turn`、不排。它把「就緒與否」綁在這個行程「跑過一輪」上，結果新開的行程、或續接回來還沒說過話的會話，
 * 打 `/goal <目標>` 或 `/goal resume` 之後什麼都不會發生，要等人再講一句話。dsh 的 `readyToDrive`
 * （`packages/goal/goal-round-driver/src/index.ts:103-109`，`477b4f4`）沒有「得先跑過一輪」這個條件，看的是 agent 此刻閒不閒。
 *
 * 放行不會讓續接回來的會話自己跑起來：授權從 `disarmed` 開始，只有一次有人下的 `create` 或 `resume` 才 armed
 * （`service.ts`）；而 `currentTurnStart` 往回找時遇到最後一顆 `session/end-seed` 就停，上一個行程的輪不會被當成現在這一輪
 * （[#251](https://github.com/DemianLi/nexus-agent/issues/251)）。
 */
function turnClosed(events: readonly SessionEvent[]): GoalDriverIdleReason | undefined {
  const start = currentTurnStart(events);
  if (start < 0) return undefined;
  for (let at = start + 1; at < events.length; at += 1) {
    const event = events[at];
    if (event?.type === 'turn/end') {
      // **被中止的那一輪也以 `turn/end` 收尾**（#276）。少了這一句，人按了停止之後續行照樣排
      // 下一輪，而沒有任何測試會紅——跟 `turn-failed` 那格同一個理由。
      const kind = event.data.reason?.kind;
      if (kind === 'aborted') return 'turn-aborted';
      return kind === 'max-tokens' ? 'turn-max-tokens' : undefined;
    }
    if (event?.type === 'turn/failed') return 'turn-failed';
  }
  return 'turn-open';
}

/** 看到這幾種原因就把續行授權收回來，不只是這一次不排。值是收回失敗時警告裡的說法。 */
const REVOKING_REASONS: Partial<Record<GoalDriverIdleReason, string>> = {
  'turn-max-tokens': '撞到輸出上限',
  'turn-aborted': '被人中止',
  'turn-failed': '輪次拋錯',
};

/**
 * 現在該不該再排一輪。**純函式**：讀日誌與一份視圖，不動任何東西。
 *
 * @param events - 這一份會話日誌到目前為止的全部事件。
 * @param goal - 目前那份視圖；沒有目前目標時給 `undefined`。
 * @param roundCap - 操作的人這一次呼叫給的輪數上限；省略即只有目標自己那一條。
 * @returns 排一輪、記一顆 blocker，或閒著（帶得出理由）。
 */
export function decideGoalRound(
  events: readonly SessionEvent[],
  goal: GoalView | undefined,
  roundCap?: number,
): GoalDriverDecision {
  const notClosed = turnClosed(events);
  if (notClosed !== undefined) return { kind: 'idle', reason: notClosed };
  // **停在核准點也算 `turn/end`**，所以這一句非問不可——少了它，排程器會在一顆等著人按
  // 批准的中斷上面再排一輪，而那一輪會把中斷靜靜吃掉（`thread-pump.ts` 檔頭第 5 點）。
  if (hasUnansweredInterrupt(events)) return { kind: 'idle', reason: 'interrupt-pending' };
  if (goal === undefined) return { kind: 'idle', reason: 'no-goal' };
  if (goal.phase !== 'active') return { kind: 'idle', reason: 'not-active' };
  // **掛載、resume、fork 之後絕不自行復活**：授權從 `disarmed` 開始，要一次有人授權的
  // `create` 或 `resume` 才 armed（`service.ts` 的「永遠不持久」）。
  if (goal.activation !== 'armed') return { kind: 'idle', reason: 'disarmed' };
  if (goal.roundsStarted >= goal.maxGoalRounds) {
    return {
      kind: 'block',
      ref: { id: goal.id, revision: goal.revision },
      reason: {
        code: ROUND_LIMIT_BLOCK_CODE,
        message: `目標用完了設定的 ${goal.maxGoalRounds} 個續行輪次。`,
      },
    };
  }
  // **順序有意義**：目標自己那個數字先問。兩條同時到頂時該說的是 `round-limit`——那一刻
  // 人設的閘沒有夾到任何東西，說成 `round-cap` 會把功勞算錯，而這兩者分不分得開正是開著
  // 旗標跑真模型時要看的那件事。
  if (roundCap !== undefined && goal.roundsStarted >= roundCap) {
    return {
      kind: 'block',
      ref: { id: goal.id, revision: goal.revision },
      reason: {
        code: ROUND_CAP_BLOCK_CODE,
        message: `這一次呼叫用完了 --max-goal-rounds 給的 ${roundCap} 個續行輪次。`,
      },
    };
  }
  const round = goal.roundsStarted + 1;
  return {
    kind: 'run',
    round: {
      // **一次 render，一個值。** 入口點拿它同時寫 `turn/start.text` 與構模型訊息，所以
      // 「日誌上寫的」與「模型讀到的」在結構上是同一串字，不是兩份要互相對齊的東西。
      text: renderGoalRoundPrompt(goal, round),
      goalId: goal.id,
      revision: goal.revision,
      round,
    },
  };
}

/**
 * 排程器要問域的四件事。**窄到剛好夠用**，所以兩條進入點各自組得出來，而這個模組不必
 * 知道 `GoalService` 長什麼樣。
 */
export interface GoalDriverPort {
  /**
   * 目前那份視圖。
   *
   * **查不到域時回 `undefined`**——patch 把 `goal` 那一列關掉的話就沒有 goal 這個 plugin，
   * 那時排程器要安靜地什麼都不做，不是拋。
   */
  goal(): GoalView | undefined;
  /** 記一顆 blocker。 */
  block(ref: GoalRef, reason: GoalBlockReason): void;
  /** 收回續行授權，**不動耐久的相位**。耐久檢查點失敗、上一輪撞到輸出上限、被中止或拋錯時用。 */
  disarm(): void;
  /** 排隊前的耐久檢查點。沒有落盤時是 no-op。 */
  flush(): Promise<void>;
  /** 排程器自己出事時說一聲。 */
  warn(message: string): void;
}

/**
 * 跑完一次排程：決定 → 耐久檢查點 → **再決定一次** → 交出那一輪。
 *
 * ## 為什麼是兩次決定
 *
 * `flush()` 是 await，而 await 期間人可以插話、目標可以被 `/goal pause` 改掉。第二次決定
 * 就是那道閘：它是**最容易省略而且省略了不會有任何徵兆**的一步——省略的後果是一輪排在
 * 一個已經被暫停的目標上，或搶在一個人剛送進來的訊息前面。
 *
 * 兩次的結果要**是同一輪**：號碼變了代表期間有別的東西推進過計數，那一輪要重新來過。
 *
 * ## `flush()` 失敗是停用，不是重試
 *
 * 照 dsh：耐久檢查點過不去就 `disarm()`，之後要續行得走一次有人授權的 `resume`。
 * 重試的話，一份寫不下去的日誌會配上一個照樣往前跑的模型——而日誌正是之後要用來重建
 * 「它到底做了什麼」的那份東西。
 *
 * ## 上一輪撞到輸出上限也是停用
 *
 * 同 dsh（#433）：模型一輪寫不完，自動再排一輪多半再撞一次，要人看過再決定。只收回授權、不動相位，
 * 跟上面那一條同一個動作。
 *
 * @param readEvents - 讀當下的事件；**每次呼叫都要重讀**，不是一份快照。
 * @param port - 域那一側的四件事。
 * @param roundCap - 操作的人這一次呼叫給的輪數上限。**兩次決定都帶著它，但今天那是形式
 *   上的一致而不是一條擋得住什麼的閘**：唯一能在 `flush()` 期間新踩到上限的變化是
 *   `roundsStarted` 往前走，而那同時會讓下面那道「號碼變了就重來」先攔下來。寫成只帶
 *   第一次也量不出差別——留著是因為兩次決定該問同一個問題，不是因為它今天擋得到東西。
 * @returns 排得出來的那一輪，或這一刻不排時的 `undefined`。
 */
export async function driveGoalRound(
  readEvents: () => readonly SessionEvent[],
  port: GoalDriverPort,
  roundCap?: number,
): Promise<GoalRoundRequest | undefined> {
  const first = decideGoalRound(readEvents(), port.goal(), roundCap);
  if (first.kind === 'idle') {
    // 撞到輸出上限、被人中止、拋錯：照 dsh 只在授權還在時收回（`goal-round-driver/src/index.ts:117-124`、
    // `:246-249`、`:328-337`）。收回之後再問一次就是 `disarmed`，所以這一句冪等。
    const revoking = REVOKING_REASONS[first.reason];
    if (revoking !== undefined && port.goal()?.activation === 'armed') {
      try {
        port.disarm();
      } catch (error: unknown) {
        port.warn(`${revoking}之後停用續行失敗：${errorText(error)}`);
      }
    }
    return undefined;
  }
  if (first.kind === 'block') {
    try {
      port.block(first.ref, first.reason);
    } catch (error: unknown) {
      port.warn(`記不下輪次上限的 blocker：${errorText(error)}`);
    }
    return undefined;
  }
  try {
    await port.flush();
  } catch (error: unknown) {
    port.warn(`耐久檢查點失敗，停用續行：${errorText(error)}`);
    try {
      port.disarm();
    } catch (disarmError: unknown) {
      port.warn(`連停用續行都失敗了：${errorText(disarmError)}`);
    }
    return undefined;
  }
  const second = decideGoalRound(readEvents(), port.goal(), roundCap);
  if (second.kind !== 'run' || second.round.round !== first.round.round) return undefined;
  return second.round;
}

/** 拿得到就拿訊息，拿不到就整個轉字串。 */
function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
