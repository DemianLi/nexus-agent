/**
 * `@nexus/core` 的不變量配套入口：**會話日誌的跨筆關係**。
 *
 * 檔名與子路徑（`@nexus/core/invariant`）照 dsh 的慣例——每個 package 的配套入口都是
 * `src/invariant.ts`，只掛在 `./invariant` 上，不從主入口再匯出。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-session/invariant`
 * （`references/deepseek-harness/packages/core/session/src/invariant.ts`），但**檢的東西
 * 少很多**，而那是對的：
 *
 * - dsh 檢的 turn/step 巢狀，{@link ./session-log.ts | SessionEventType} **沒有詞彙表達**
 *   ——沒有 `step/*` 事件，也沒有逐事件的 `{turn, step}`。一次模型呼叫的識別是 `modelCall`
 *   （[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)，它的 `model/start` 的 `seq`），另有一道檢查（`session-relationships.ts` 的 `startSeqs`）只檢它**指得到前面真的有的開頭**，
 *   不檢「落在哪一輪」。`tool/call` ↔ `tool/result` 的 `callId` 配對從
 *   [#264](https://github.com/DemianLi/nexus-agent/issues/264) 起有詞彙了，照 dsh 檢，但**只檢
 *   配對、不檢落在哪一步**（形狀的偏離見 `session-log.ts` 的那兩顆）。`model/start` ↔
 *   `model/end`（[#266](https://github.com/DemianLi/nexus-agent/issues/266)）只檢結尾那一側，
 *   理由見 `session-relationships.ts` 的 `openModelCalls`。
 * - `seq` 嚴格遞增、純 JSON、不可變、重入，**四樣全都已經被 `SessionLog` 自己擁有**
 *   （`#events.length`、`snapshotJsonValue`、`deepFreeze`、`#publishing`）。抄過來只是
 *   複製擁有者的邊界，dsh 明說配套入口只檢**擁有者自己不負責**的那部分。
 *
 * 剩下真的沒人管的跨筆關係（turn 配對、模型呼叫的起訖與 `modelCall` 的指向、工具呼叫與結果的配對、重試的連號與開跑、
 * 核准稽核落在輪內、送出佇列）寫在 {@link ./session-relationships.ts | createSessionRelationshipChecker}，這個配套入口只把它接到
 * 執行期的日誌上，違規交給 `fail`。harness 讀盤用的是同一支（[#1597](https://github.com/DemianLi/nexus-agent/issues/1597)），
 * 這幾條兩邊判法相同；標題的來源只在讀盤那一側驗（`apps/harness/src/session-log-validation.ts`）。
 *
 * @module
 */

import type { InvariantInstaller } from './invariants.js';
import type { NexusPlugin, PluginEntry } from './plugin.js';
import { createSessionRelationshipChecker } from './session-relationships.js';

/** 這個配套入口認領的 package 名。 */
export const CORE_INVARIANT_PACKAGE = '@nexus/core';

/** 會話日誌的跨筆關係，逐顆交給 {@link createSessionRelationshipChecker}。 */
export const sessionInvariant: InvariantInstaller = (subject, fail) => {
  // 一份日誌安裝一次，所以一份日誌一份檢查狀態。
  const checker = createSessionRelationshipChecker();
  subject.observe((event) => {
    for (const violation of checker.accept(event)) fail(violation.message);
  });
};

/**
 * 把會話日誌的配套入口掛上去。
 *
 * **它在出貨清單裡**（`apps/harness/cordis.yml`），連同另外八個配套入口——
 * [#107](https://github.com/DemianLi/nexus-agent/issues/107) 拍板。這與 dsh 對得上：
 * dsh 的標準組合（`agent-spine-demo`）也掛了服務加核心配套入口；它的規矩只說「單獨掛
 * 註冊表不會裝上任何檢查」，沒說預設組合該掛什麼。
 *
 * **進得來的前提是關得掉**：[#104](https://github.com/DemianLi/nexus-agent/issues/104)
 * 給了條目層的 `disabled` 與組裝點的 `invariants` 選擇，所以這不是單向門。理由與代價
 * （九個全進、每次執行多九個條目）寫在 `apps/harness/cordis.yml` 的註解裡——那份清單
 * 明說它「不替誰決定該裝什麼」，例外要在例外那邊講。
 *
 * **但掛上它不等於違規看得見。** 違規的去處是進入點的事：CLI 走
 * `CreateNexusAgentOptions.onInvariantViolation` 印到 stderr，`serve.ts` 維持
 * `createInvariantRunner` 的預設。這個檔案只負責註冊，不負責回報去處。
 *
 * @returns 掛著它的條目，註冊 `@nexus/core` 配套入口的 plugin。
 */
export function createCoreInvariantPlugin(): PluginEntry {
  return { plugin: coreInvariantPlugin };
}

/**
 * 模組層級的那一顆。不收設定，所以沒有 `Config`；
 * [#454](https://github.com/DemianLi/nexus-agent/issues/454) 從設定檔 import 的就是它。
 */
export const coreInvariantPlugin: NexusPlugin = {
  name: 'core-invariant',
  apply(registry) {
    registry.invariants.register(CORE_INVARIANT_PACKAGE, sessionInvariant);
  },
};

export default coreInvariantPlugin;
