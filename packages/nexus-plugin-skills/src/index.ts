/**
 * `@nexus/plugin-skills`——把 SKILL.md 這類隨選工作流掛進 agent 的 plugin。
 *
 * 跟 `@nexus/plugin-memory` 一樣薄，理由也一樣：基座的 `createSkillsMiddleware` 已經
 * 做完了掃描與注入，`@nexus/core` 的 `skills` 註冊點與 `foldRegistry` 在 Phase 1 就接好
 * 了，所以這裡真正提供的只有一個**慣例路徑**（{@link DEFAULT_SKILLS_SOURCE}）。
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
 *
 * ## 形狀（#1446：第四顆搬上 Cordis 樹的插件）
 *
 * 函式插件，具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**（Loader 的 `unwrapExports` 有 default
 * 就取 default，具名的 `inject`／`Config` 會被丟掉；一致性套件的 `export-form` 格擋這個）。相依只有 `@nexus/sdk` 與
 * `@nexus/skills`（技能來源的服務定義）：**沒有一行 import `@nexus/core`**（決議 §3-4 第 17 條；#1420 的 lint 規則擋它）。
 *
 * - 要的服務經 `inject` 宣告（`skillSources`，`^1.0.0`），在 `apply` 裡經 token 取。
 * - 登記路徑是 effect：這一列卸載時登記處自己撤掉。
 * - **模型看到的東西不變**：宿主把這一列登記的路徑照順序折回每條 thread 的 `registry.skills.addSource`，基座的 skills 中介層
 *   與 `createSkillsMiddlewareQuietWhenEmpty` 那一層都沒動。
 * - 路徑格式與重名在**登記時**就驗（提供者那一側，#1446 Q2 (a)、Q3 (a)），寫錯的列在讀清單那一步就掉，不等組 thread。
 *
 * 舊的 `NexusPlugin` 外殼（`createSkillsPlugin`）不在這裡：它是測試夾具，住在 `apps/harness` 的 `skills.fixture.ts`。
 */

import type { Context } from '@nexus/cordis';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { skillSourcesToken } from '@nexus/skills';
import { z } from 'zod';

/**
 * 省略 `sources` 時用的來源。
 *
 * **是 backend 命名空間下的絕對目錄路徑，不是磁碟路徑。** 基座把它當「父目錄」掃：
 * 底下每一個含 `SKILL.md` 的子目錄就是一個 skill。目錄本身直接放了 `SKILL.md` 的話，
 * 基座會改當成單一 skill 的路徑處理（`listSkillsFromBackend` 看 `ls` 結果自動判斷）。
 */
export const DEFAULT_SKILLS_SOURCE = '/skills/';

/**
 * 這個 plugin 的設定。
 *
 * **空清單擋在 schema 裡**：它會讓 `foldRegistry` 直接省略 `skills` 參數、基座連 middleware
 * 都不建，結果與「沒掛這個 plugin」一模一樣——而呼叫端顯然以為自己掛了。
 */
export const skillsConfigSchema = z.strictObject({
  /**
   * skill 來源目錄，**依序即優先序**：基座用 `allSkills.set(skill.name, skill)` 逐一
   * 覆蓋，所以後面的來源贏過前面的同名 skill。省略即只有
   * {@link DEFAULT_SKILLS_SOURCE}。
   *
   * 覆蓋只換內容、不換位置——`Map` 的迭代順序是**第一次**出現的順序，所以被後來者
   * 覆蓋掉的那個 skill，它在 prompt 清單裡的位置仍然是前一個來源給的。
   */
  sources: z
    .array(z.string())
    .min(1, '空的來源清單等於沒掛這個 plugin——真的不要 skills 就別把它放進清單')
    .default([DEFAULT_SKILLS_SOURCE]),
});

/** 驗過的設定。 */
export type SkillsConfig = z.infer<typeof skillsConfigSchema>;

/** 工廠收的東西：schema 的輸入面。 */
export type SkillsPluginOptions = z.input<typeof skillsConfigSchema>;

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`，錯誤訊息、log 與相容層清單用）。 */
export const name = 'skills';

/** 要的服務：`skillSources`，契約 `^1.0.0`。範圍在這裡宣告，落進 Cordis 的 `Context.intercept`，提供者的 `check` 讀得到。 */
export const inject = injectOf(need(skillSourcesToken, '^1.0.0'));

/** 設定的 schema，與 {@link manifest}.config 是同一個物件（一致性套件比對）。 */
export const Config = skillsConfigSchema;

export const manifest = defineManifest({
  id: 'skills',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [],
  consumes: [{ token: skillSourcesToken.name, range: '^1.0.0' }],
  config: skillsConfigSchema,
  // 換程式碼要重啟行程；設定一改，下一條 thread 看到新的來源，開著的不動（#1405、決議 §3-2 第 6 條）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 掛上：把設定的每一個來源依序登記進行程級的技能來源登記處。
 *
 * **這個擴充點的預設失敗模式是「看得到、讀不到」。** 清單是基座用 backend 方法（`ls` / `downloadFiles`）自己掃出來的，
 * **不經過 `permissions`**；而模型要拿到正文得呼叫 `read_file` 工具，**那條經過**。所以一條蓋到 skill 路徑的 deny 規則不會讓
 * skill 消失——它會讓 skill 好端端地列在 prompt 裡，然後模型每次去讀都被拒。`apps/harness` 有測試釘著這個形狀。
 *
 * （順帶：我們的 `ContainedFilesystemBackend` 那道 fence 在這裡**完全不參與**——它只包寫入路徑，讀一律通過。擋人的自始至終
 * 只有 `permissions` 一層。）
 *
 * **繼承規則跟 memory 正好相反。** 基座的 `createSubagentDefaultMiddleware` 有 `input.skills` 分支，所以 subagent **可以**有
 * 自己的 skills；而 general-purpose subagent 會拿到 root 的那份來源——它由 `foldRegistry` 註冊，照基座那份把 `skills` 抄了
 * 過去。對照之下 memory 只有 `mode: 'fork'` 的 subagent 拿得到、general-purpose 拿不到。淨結果是**兩個擴充點的繼承規則互為
 * 反面**，這種事只能靠絆索測試記住。
 *
 * @param ctx - 這一列的 Cordis context。
 * @param config - 驗過的設定。
 */
export function apply(ctx: Context, config: SkillsConfig): void {
  const registry = service(ctx, skillSourcesToken);
  // 路徑格式與重名的檢查在登記處那一側（`@nexus/skills/provider`），不在這裡。
  for (const source of config.sources) registry.addSource(source);
}
