/**
 * `@nexus/plugin-skills` 的不變量配套入口。
 *
 * **No runtime invariant：這個 package 在 subject 裡沒有任何屬於自己的東西可以檢，
 * 而那是射程決定的，不是逐條審過的結果。** nexus 的 `InvariantSubject` 裡只有一份
 * `SessionLog`（見 `@nexus/core` 的 `invariants.ts`），而那份日誌歸 `@nexus/core`；
 * dsh 的 `install(ctx, fail)` 收的則是整個 Cordis 匯流排，每個 package 自己發的事件都在
 * 裡面。**技術上 `observe()` 誰都叫得動**——subject 沒有按包擋人——但叫下去看到的是
 * 別人的事件，而 dsh 明說配套入口只檢**自己擁有的**跨筆關係。所以這一側除了日誌的擁有者
 * 以外，沒有一個 package 在 subject 裡找得到自己的關係。這是已知的射程不是新發現：
 * [#101](https://github.com/DemianLi/nexus-agent/issues/101) 已經把「加會話事件種類」明文
 * 排除在外，而事件詞彙就是這個射程的上限。
 *
 * 下面這段講的因此不是「為什麼這個 package 沒有不變量」，是**它的契約實際證在哪裡**：
 *
 * 跟 `@nexus/plugin-memory` 同一個形狀：掃描與注入都在基座的 skills
 * middleware 裡，這個套件只提供慣例路徑與能力名。`index.ts` 檔頭記的四件實測事實
 * （progressive disclosure 是純 prompt、`allowed-tools` 零強制、`module` frontmatter 懸空、
 * 目錄載到就凍住）**全是基座的行為**，這個套件既不擁有也改不動。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const SKILLS_INVARIANT_PACKAGE = '@nexus/plugin-skills';

/**
 * 空 installer。
 *
 * 沒有參數是刻意的——`noUnusedParameters` 開著，寫了 `(subject, fail)` 編不過，而且
 * 「一個都沒用到」正好是這個檔案要說的話。
 */
const install: InvariantInstaller = () => {};

/**
 * 把 `@nexus/plugin-skills` 的配套入口掛上去。
 *
 * 掛了它**不會裝上任何檢查**，唯一的作用是**保留包名歸屬**：`register()` 就算在
 * installer 是空的時候也把名字佔住，兩個 plugin 不會靜默認領同一個包名。
 *
 * @returns 註冊 `@nexus/plugin-skills` 配套入口的 plugin。
 */
export function createSkillsInvariantPlugin(): NexusPlugin {
  return {
    name: 'skills-invariant',
    apply(registry) {
      registry.invariants.register(SKILLS_INVARIANT_PACKAGE, install);
    },
  };
}
