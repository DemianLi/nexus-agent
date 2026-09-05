/**
 * `@nexus/plugin-goal` 的不變量配套入口：**耐久 goal 串的合法性**，以及**每一顆續行輪次
 * 的文字**。
 *
 * 形狀照 dsh 的兩個伴生合起來：`@deepseek-ai/dsh-goal/invariant`
 * （`references/deepseek-harness/packages/goal/goal/src/invariant.ts`，對讀日期
 * 2026-09-01，版本 `0a53fb55bea101816fa226bb964ae2bed71c343b`）跑一份與服務互相獨立的
 * 折疊；`@deepseek-ai/dsh-goal-round-driver/invariant`（版本 `d347e703`，2026-09-04）驗
 * 每一顆 goal 來源訊息的內容逐字等於套件自有 renderer 算出來的東西。
 *
 * ## 兩個伴生為什麼在我們這裡合成一個
 *
 * dsh 那份住在驅動器套件裡，因為那裡才是 renderer 的家。**我們的排程器不是一個
 * plugin**——輪迴圈歸入口點所有，所以它落在 `apps/harness`（登記過的載體偏離，見
 * [#180](https://github.com/DemianLi/nexus-agent/issues/180)）。但**檢查不跟著搬**：
 * renderer 與折疊都在這裡，而且判準是**只要 `kind: 'goal'` 這個詞彙存在，這條檢查就
 * 武裝**，與有沒有掛排程器無關。只在掛了排程器時才擋的檢查，對一顆手寫或寫壞的
 * goal 來源輪次是零防守。
 *
 * ## 為什麼這不是重複
 *
 * {@link ./service.ts | GoalService} 自己也折同一串事件，但兩邊要的東西不一樣：
 *
 * - **服務那邊要的是「壞掉之後不要給出錯的答案」**——它把第一次失敗扣住，之後每一次讀
 *   與每一次變更都拒絕。那是**安靜的**：日誌照樣往前走，沒有人被通知。
 * - **這裡要的是「壞掉這件事有人講」**——`fail()` 拋出去的 `InvariantError` 由 runner
 *   接住轉給 `onViolation`（CLI 印到 stderr）。
 *
 * 少了任何一半都有洞：只有服務的話，一顆壞掉的變更只換來一個從此拒絕回答的目標，而沒
 * 有人知道為什麼；只有這裡的話，違規印出來了，服務卻還在拿一份停在半路的折疊回答問題。
 *
 * ## 這條檢查的擁有者為什麼是這個 package
 *
 * `goal/change` 的跨筆關係（修訂號連續、相位轉換、id 不重用）由這個 package 定義，
 * `@nexus/core` 的 `SessionLog` 只保證「純 JSON、序號遞增、不可變」——它管不到也不該
 * 管一顆 goal 變更接不接得上前一顆。這正是 dsh 那條「檢查放在擁有者旁邊」。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin } from '@nexus/core';

import { applyGoalEvent, emptyGoalFoldState } from './fold.js';
import type { GoalFoldState } from './fold.js';
import { renderGoalRoundPrompt } from './prompt.js';

/** 這個配套入口認領的 package 名。 */
export const GOAL_INVARIANT_PACKAGE = '@nexus/plugin-goal';

/** 驗一筆之前先拷一份：驗不過的那一筆不留下半套狀態。 */
function cloneState(state: GoalFoldState): GoalFoldState {
  return {
    goal: state.goal,
    roundsStarted: state.roundsStarted,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastRef: state.lastRef,
    seenGoalIds: new Set(state.seenGoalIds),
  };
}

/**
 * 一份獨立的嚴格折疊。
 *
 * **違規之後不停下來**，只是不採用那一筆：跟著的每一筆照樣驗。停下來的話，中段一次
 * 違規會讓後面全部失明——同 `createInvariantRunner` 重播時的那一條。
 */
export const goalStreamInvariant: InvariantInstaller = (subject, fail) => {
  let state = emptyGoalFoldState();

  subject.observe((event) => {
    // **`turn/start` 不能整種略過。** goal 來源的那一支推進 `roundsStarted`，而下一輪的
    // 準入檢查讀的正是它——這份累積器跟不上的話，第二輪必然報一個假違規。
    if (event.type !== 'goal/change' && event.type !== 'turn/start') return;
    if (event.type === 'turn/start' && event.data.kind !== 'goal') return;
    // **重建的前綴是「這一顆之前」的狀態**，也就是還沒套這一顆的 `state`。dsh 的伴生為此
    // 重掃一次 `snapshotEvents()`；我們是增量的，前綴就在手上。
    const prior = state.goal;
    const candidate = cloneState(state);
    try {
      applyGoalEvent(candidate, event);
    } catch (error: unknown) {
      fail(
        `會話事件 ${event.seq} 破壞了耐久 goal 串：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (event.type === 'turn/start' && event.data.kind === 'goal') {
      // 套過了，所以四格都對上了——`prior` 一定在。剩下的是這一顆的**文字**。
      // 寫成 `if/else` 而不是提前 `fail()`：`fail` 的 `never` 是型別上的，
      // 控制流分析對一個參數形式的它不收斂。
      /* v8 ignore next 3 -- 準入檢查已經要求前綴有一個 active 目標 */
      if (prior === undefined) {
        fail(`會話事件 ${event.seq} 的 goal 輪次沒有可以重建的目標`);
      } else if (event.data.text !== renderGoalRoundPrompt(prior, event.data.round)) {
        fail(`會話事件 ${event.seq} 的第 ${event.data.round} 輪內容不是這個套件算出來的續行文字`);
      }
    }
    state = candidate;
  });
};

/**
 * 把 goal 串的配套入口掛上去。
 *
 * **它進 `DEFAULT_PLUGINS`，但域本身不進**——見 `index.ts` 檔頭。配套入口不裝功能只裝
 * 觀察，所以它適用那份清單裡「十一個配套入口全進」的那條例外；域是功能，功能等它有
 * 人打得到的入口再說。
 *
 * @returns 註冊 `@nexus/plugin-goal` 配套入口的 plugin。
 */
export function createGoalInvariantPlugin(): NexusPlugin {
  return {
    name: 'goal-invariant',
    apply(registry) {
      registry.invariants.register(GOAL_INVARIANT_PACKAGE, goalStreamInvariant);
    },
  };
}
