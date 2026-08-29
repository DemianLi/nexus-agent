/**
 * `@nexus/core` 自己的不變量配套入口：**會話日誌的 turn 配對**。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-session/invariant`
 * （`references/deepseek-harness/packages/core/session/src/invariant.ts`），但**檢的東西
 * 少很多**，而那是對的：
 *
 * - dsh 檢的 turn/step 巢狀、`tool/call` ↔ `tool/result` 配對，
 *   {@link ./session-log.ts | SessionEventType} **沒有詞彙表達**——只有四種事件，沒有
 *   step、沒有 callId。加事件種類是另一件事，門檻寫在 `session-log.ts` 檔頭。
 * - `seq` 嚴格遞增、純 JSON、不可變、重入，**四樣全都已經被 `SessionLog` 自己擁有**
 *   （`#events.length`、`snapshotJsonValue`、`deepFreeze`、`#publishing`）。抄過來只是
 *   複製擁有者的邊界，dsh 明說配套入口只檢**擁有者自己不負責**的那部分。
 *
 * 剩下真的沒人管的跨筆關係就是 turn 配對。三條都對著兩個生產者實際發的序列驗過
 * （`apps/harness/src/thread-pump.ts` 的 `#runOnce`、`apps/harness/src/cli.ts` 的
 * `runTurn`）：兩條路都是 `turn/start` →（`interrupt/raised`）* → `turn/end` 或
 * `turn/failed`，而且 pump 的輪是排隊跑的，不會交錯。
 *
 * **刻意不檢「日誌結尾還有一輪開著」**：那跟「跑到一半」長得一模一樣，不是違規。
 *
 * @module
 */

import type { InvariantInstaller } from './invariants.js';
import type { NexusPlugin } from './plugin.js';

/** 這個配套入口認領的 package 名。 */
export const SESSION_INVARIANT_PACKAGE = '@nexus/core';

/**
 * turn 配對的三條關係。
 *
 * `turn/failed` 與 `turn/end` 都是收工，所以用同一格 `open` 記狀態就夠——
 * 兩者的差別是結果不是結構。
 */
export const sessionInvariant: InvariantInstaller = (subject, fail) => {
  // trace 放在 closure 裡：一份日誌一次安裝，不需要 dsh 那個
  // `WeakMap<Session, SessionTrace>`（見 `invariants.ts` 裡標註的偏離）。
  let open = false;

  subject.observe((event) => {
    switch (event.type) {
      case 'turn/start': {
        if (open) fail(`turn/start（seq ${event.seq}）來的時候上一輪還開著`);
        open = true;
        break;
      }
      case 'turn/end':
      case 'turn/failed': {
        if (!open) fail(`${event.type}（seq ${event.seq}）關了一個沒有開著的輪`);
        open = false;
        break;
      }
      case 'interrupt/raised': {
        if (!open) fail(`interrupt/raised（seq ${event.seq}）落在任何開著的輪之外`);
        break;
      }
      default:
        // 後來加的事件種類歸它們自己的擁有者。這裡刻意不寫 exhaustive 的
        // assertNever——不認得的事件不該讓這條檢查變成阻礙（協調器的 `severityOf`
        // 同一條理由）。
        break;
    }
  });
};

/**
 * 把會話日誌的配套入口掛上去。
 *
 * **不在 `DEFAULT_PLUGINS` 裡，而這一點與 dsh 不同，要講清楚。** dsh 的標準組合
 * （`agent-spine-demo`）確實掛了服務加四個核心配套入口；dsh 的規矩只說「單獨掛註冊表
 * 不會裝上任何檢查」，沒說預設組合該掛什麼。我們不掛的理由是**我們這側自己的約束**：
 * `DEFAULT_PLUGINS` 刻意只有 echo 一個，那份清單的 JSDoc 明說它「不替誰決定該裝什麼」，
 * 哪些 plugin 該進預設要等外部設定機制
 * （[#46](https://github.com/DemianLi/nexus-agent/issues/46)）啟動才有地方講。
 * **#46 落地時要回來重新問一次這件事**——它是預設清單的問題，不是這個配套入口的問題。
 *
 * @returns 註冊 `@nexus/core` 配套入口的 plugin。
 */
export function createSessionInvariantPlugin(): NexusPlugin {
  return {
    name: 'session-invariant',
    apply(registry) {
      registry.invariants.register(SESSION_INVARIANT_PACKAGE, sessionInvariant);
    },
  };
}
