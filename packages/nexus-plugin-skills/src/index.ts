/**
 * `@nexus/plugin-skills`——把 SKILL.md 這類隨選工作流掛進 agent 的 plugin。
 *
 * 跟 `@nexus/plugin-memory` 一樣薄，理由也一樣：基座的 `createSkillsMiddleware` 已經
 * 做完了掃描與注入，`@nexus/core` 的 `skills` 註冊點與 `foldRegistry` 在 Phase 1 就接好
 * 了，所以這裡真正提供的只有一個**慣例路徑**（{@link DEFAULT_SKILLS_SOURCE}）與一個
 * **能力名**（{@link SKILLS_CAPABILITY}）。
 *
 * 動工前查過基座（`deepagents@1.13.1`，`dist/langsmith-*.js` 的 skills middleware）。
 * 四件實測事實決定了這個套件能承諾什麼：
 *
 * 1. **progressive disclosure 是純 prompt，不是機制。** middleware 只把 name／
 *    description／path 寫進 system prompt，然後用文字叫模型自己去 `read_file`。所以
 *    **清單載入與內容讀取走的是兩條不同的路**：清單走 backend 方法（`ls` /
 *    `downloadFiles`），內容走 `read_file` 工具。只有後者經過 `permissions`。
 *    直接後果見 {@link createSkillsPlugin}。
 * 2. **`allowed-tools` frontmatter 零強制。** 基座解析它、把它印進 prompt，就這樣——
 *    全套件 7 個出現點沒有一個是強制點。**不能當權限用**，權限只有 `permissions`。
 * 3. **`module` frontmatter 只印一行 `await import("@/skills/<name>")`，沒有東西實作
 *    那個 import。** 那是懸空的 seam；同一件事在 `@nexus/plugin-quickjs` 已經記過一次。
 * 4. **目錄載到就凍住。** `loadedSkills` 是 middleware 工廠的閉包變數，一旦載到東西就
 *    永不重載，跨 thread 也一樣；agent 建好之後新增的 skill 看不見。**但空的不算**——
 *    載到空清單時每一輪 `beforeAgent` 都會重掃整個 backend。
 */

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這個 plugin 宣告的能力名。要相依它的 plugin 把這個字串放進自己的 `requires`。 */
export const SKILLS_CAPABILITY = 'skills';

/**
 * 省略 `sources` 時用的來源。
 *
 * **是 backend 命名空間下的絕對目錄路徑，不是磁碟路徑。** 基座把它當「父目錄」掃：
 * 底下每一個含 `SKILL.md` 的子目錄就是一個 skill。目錄本身直接放了 `SKILL.md` 的話，
 * 基座會改當成單一 skill 的路徑處理（`listSkillsFromBackend` 看 `ls` 結果自動判斷）。
 */
export const DEFAULT_SKILLS_SOURCE = '/skills/';

export interface SkillsPluginOptions {
  /**
   * skill 來源目錄，**依序即優先序**：基座用 `allSkills.set(skill.name, skill)` 逐一
   * 覆蓋，所以後面的來源贏過前面的同名 skill。省略即只有
   * {@link DEFAULT_SKILLS_SOURCE}。
   *
   * 覆蓋只換內容、不換位置——`Map` 的迭代順序是**第一次**出現的順序，所以被後來者
   * 覆蓋掉的那個 skill，它在 prompt 清單裡的位置仍然是前一個來源給的。
   */
  readonly sources?: readonly string[];
}

/**
 * 建一個 skills plugin。
 *
 * **這個擴充點的預設失敗模式是「看得到、讀不到」。** 清單是基座用 backend 方法
 * （`ls` / `downloadFiles`）自己掃出來的，**不經過 `permissions`**；而模型要拿到正文
 * 得呼叫 `read_file` 工具，**那條經過**。所以一條蓋到 skill 路徑的 deny 規則不會讓
 * skill 消失——它會讓 skill 好端端地列在 prompt 裡，然後模型每次去讀都被拒。
 * `apps/harness` 有測試釘著這個形狀。
 *
 * （順帶：我們的 `ContainedFilesystemBackend` 那道 fence 在這裡**完全不參與**——
 * 它只包寫入路徑，讀一律通過。擋人的自始至終只有 `permissions` 一層。）
 *
 * **繼承規則跟 memory 正好相反。** 基座的 `createSubagentDefaultMiddleware` 有
 * `input.skills` 分支，所以 subagent **可以**有自己的 skills；而內建的 general-purpose
 * subagent 會拿到 root 的那份來源（`normalizeSubagentSpec` 把 `skills` 傳了進去）。
 * 對照之下 memory 只有 `mode: 'fork'` 的 subagent 拿得到、general-purpose 拿不到。
 * 淨結果是**兩個擴充點的繼承規則互為反面**，這種事只能靠絆索測試記住。
 *
 * @param options - 來源清單。
 * @returns 可以放進組裝點清單的 plugin。
 * @throws `sources` 給了空陣列。空清單會讓 `foldRegistry` 直接省略 `skills` 參數、
 *   基座連 middleware 都不建，結果與「沒掛這個 plugin」一模一樣——而呼叫端顯然以為
 *   自己掛了。
 */
export function createSkillsPlugin(options: SkillsPluginOptions = {}): NexusPlugin {
  const sources = options.sources ?? [DEFAULT_SKILLS_SOURCE];
  if (sources.length === 0) {
    throw new Error(
      'createSkillsPlugin({ sources: [] })：空的來源清單等於沒掛這個 plugin——' +
        'fold 會省略 skills 參數，基座連 skills middleware 都不會建。' +
        '真的不要 skills 就別把這個 plugin 放進清單。',
    );
  }

  return {
    name: 'skills',
    apply(registry: PluginRegistry): void {
      registry.capabilities.provide(SKILLS_CAPABILITY);
      // 路徑格式的檢查在 registry 那一側（`assertLoadableSkillsPath`），不在這裡。
      for (const source of sources) registry.skills.addSource(source);
    },
  };
}
