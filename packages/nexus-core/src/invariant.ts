/**
 * `@nexus/core` 的不變量配套入口：**會話日誌的 turn 配對**。
 *
 * 檔名與子路徑（`@nexus/core/invariant`）照 dsh 的慣例——每個 package 的配套入口都是
 * `src/invariant.ts`，只掛在 `./invariant` 上，不從主入口再匯出。
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
export const CORE_INVARIANT_PACKAGE = '@nexus/core';

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
 * **它在 `@nexus/harness` 的 `DEFAULT_PLUGINS` 裡**，連同另外八個配套入口——
 * [#107](https://github.com/DemianLi/nexus-agent/issues/107) 拍板。這與 dsh 對得上：
 * dsh 的標準組合（`agent-spine-demo`）也掛了服務加核心配套入口；它的規矩只說「單獨掛
 * 註冊表不會裝上任何檢查」，沒說預設組合該掛什麼。
 *
 * **進得來的前提是關得掉**：[#104](https://github.com/DemianLi/nexus-agent/issues/104)
 * 給了條目層的 `disabled` 與組裝點的 `invariants` 選擇，所以這不是單向門。理由與代價
 * （九個全進、每次執行多九個條目）寫在 `DEFAULT_PLUGINS` 自己的 JSDoc 上——那份清單
 * 明說它「不替誰決定該裝什麼」，例外要在例外那邊講。
 *
 * **但掛上它不等於違規看得見。** 違規的去處是進入點的事：CLI 走
 * `CreateNexusAgentOptions.onInvariantViolation` 印到 stderr，`serve.ts` 維持
 * `createInvariantRunner` 的預設。這個檔案只負責註冊，不負責回報去處。
 *
 * @returns 註冊 `@nexus/core` 配套入口的 plugin。
 */
export function createCoreInvariantPlugin(): NexusPlugin {
  return {
    name: 'core-invariant',
    apply(registry) {
      registry.invariants.register(CORE_INVARIANT_PACKAGE, sessionInvariant);
    },
  };
}
