/**
 * `skill.list` 的那一份清單（[#1574](https://github.com/DemianLi/nexus-agent/issues/1574) N0929）：這條對話用 `/名字` 叫得出哪些技能。
 *
 * 照 dsh 的 `SessionSkillCatalog.list`（`packages/api/session-controller/src/skill-catalog.ts:35-91`，`687f282e`）：
 *
 * - **不帶正文**：只回元資料，逐格照 dsh 的 `SkillEntry`（`types.ts:248-259`）。
 * - **只回人叫得到的**（`isUserInvocable`，`:78`）；`modelInvocable` 照實帶，`disable-model-invocation: true` 的是 `false`。
 * - **依名字逐碼排序**：dsh 的 `list` 回的是 `snapshot().skills`，排序是 `compareSkillSummary`（`skill/src/index.ts:486`、`:797-799`）；
 *   core 的 `scanSkills` 回的是第一次出現的順序，所以在這裡排。
 * - **沒有登記處就是錯**：dsh 兩層都沒掛 skills 時拋 `gateway/internal`（`:67-73`）。我們的對應是「沒有任何技能來源」——`skills` 那一列的
 *   schema 擋掉空清單，所以沒有來源就等於沒掛那一列——回 `undefined`，由 wire 回 `not_supported`（碼的取捨見偏離 2）。
 * - **只在圖內讀得到的來源，等於沒有檔案提供者**：沒有磁碟根的 thread（serve 沒給 `--workspace`、或落盤關掉的新 thread，
 *   `thread-roots.ts`）墊底的是記憶體的 `TextOnlyStateBackend`（`agent-factory.ts` 的 `defaultBackend`），它的檔案存在圖的 state 裡，
 *   只有在圖的執行上下文裡讀得到；`skill.list` 跑在 HTTP 處理裡，硬讀會拋、被收成「不完整」。dsh 的檔案提供者只讀磁碟，
 *   所以這種來源在 dsh 的語意裡就是「這個來源沒有提供者」：**不掃、不 warn**，其餘來源照常讀（落在路由底下的，例如插件用
 *   `backend.mount()` 掛上的磁碟路由）。落盤關掉、但給了 `--workspace` 的新 thread 有共用區，不在路由底下的來源（例如出廠的
 *   `/skills/`）先接到 `/shared` 底下（見下），不落在墊底那一格。判準看結構，不看拋錯：來源落在組裝點包上去的路由底下（`FsService.offWorkspacePrefixes()`，含 `/shared`）
 *   就交給那條路由；不在任何路由底下就落在墊底那一格，墊底只有在這條 thread 有可寫根（`FsService.workspaceRoot()`）時才在磁碟上。
 * - **掃描不完整，一份都不列**：dsh 的檔案提供者讀失敗會拋，registry 跳過整個提供者、記一行 warn（`skill/src/index.ts:602-608`），
 *   `list` 照常回。我們整組來源是一次掃描，等於一個提供者，所以照同一個語意回空陣列、記一行 warn。同刀 2 的叫用
 *   （PM 裁決 issuecomment-6358917124 第 1 題），不算偏離。
 *
 * 來源讀登記處（`skillSources` 那份行程級的），**每次呼叫當下讀**，不讀折進 thread 的那一份：同刀 2 的叫用（PM 裁決 (i)），
 * `/名字` 叫得出的和這份清單列的才是同一組。有共用區的 thread（#1775 的新 thread）先經 `threadSkillSources` 換成共用區底下的來源
 * （[#1928](https://github.com/DemianLi/nexus-agent/issues/1928)），跟模型清單、`/名字` 同一支。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **`path` 是 backend 命名空間的路徑，不是磁碟路徑**（理由 2）。dsh 的 `path` 是檔案提供者給的 `SKILL.md` 絕對路徑；我們的主機多人共用、
 *    完全內網，把主機上的磁碟路徑交給瀏覽器沒有用處，只多洩漏一份目錄結構。模型讀技能用的也是 backend 命名空間的路徑（基座的 skills
 *    中介層印進 prompt 的那一個），兩邊一致。
 * 2. **錯誤碼：沒有清單回 `not_supported`、清單讀不出來回 `unknown_error`**，dsh 兩種都是 `gateway/internal`。依據是卡面做法第 5 步與 PM 派工
 *    指定 `not_supported`，並沿用這條 wire「組裝沒有這項功能就回 `not_supported`」的既有慣例（`subagent.list`、`permission.catalog`、
 *    `model.catalog` 等，見 `wire-handler.ts`）——web 據這個碼把入口藏起來；`unknown_error` 是 dsh 的 internal 在這條 wire 上的對應。
 *
 * ## 已知缺口
 *
 * - **模型在虛擬 FS 裡寫的技能列不到**：沒有磁碟根、也沒有共用區的 thread（serve 沒給 `--workspace`），模型自己寫進 `/skills/x/SKILL.md`
 *   的技能，模型那側的 skills 中介層與 `/名字` 叫用在圖內讀得到，這份清單列不到（上面「只在圖內讀得到的來源」）。dsh 沒有對照物（它的技能只來自磁碟提供者），所以照 dsh 就是不列。
 *   重開條件：產品要讓沒有磁碟根的 thread 也能在 web 上列出模型寫的技能時，改成從這條 thread 的存檔點讀 state 裡的檔案。
 *
 * @module
 */

import { scanSkills, threadSkillSources } from '@nexus/core';
import type { FsService, SkillCatalogEntry } from '@nexus/core';
import type { SkillEntry } from '@nexus/wire';

/** {@link createSkillCatalog} 讀這條 thread 的 `fs` 把手讀的那幾格。 */
export type SkillCatalogFs = Pick<
  FsService,
  'backend' | 'workspaceRoot' | 'offWorkspacePrefixes' | 'sharedWorkspacePrefix'
>;

/** {@link createSkillCatalog} 每次呼叫當下要讀的三樣東西。 */
export interface SkillCatalogLookups {
  /** 技能來源，順序就是優先序（後者贏）。空的就是沒掛 `skills` 那一列。 */
  readonly sources: () => readonly string[];
  /** 這條 thread 的 `fs` 把手；還沒有（沒綁）是 `undefined`。 */
  readonly fs: () => SkillCatalogFs | undefined;
  /** 掃描不完整時說一句話的去處（伺服器日誌）。 */
  readonly warn: (message: string) => void;
}

/**
 * 一條 thread 的技能清單。回 `undefined` 是「這個組裝沒有技能可列」（沒有來源、或拿不到 backend），wire 回 `not_supported`；
 * 掛了但沒有技能、或掃描不完整，是空陣列。
 */
export type SkillCatalog = () => Promise<readonly SkillEntry[] | undefined>;

/**
 * 造一條 thread 的 {@link SkillCatalog}。
 *
 * @param lookups - 來源、backend 與 warn，都在呼叫當下才讀。
 * @returns 每次呼叫重掃一次的清單。
 */
export function createSkillCatalog(lookups: SkillCatalogLookups): SkillCatalog {
  return async () => {
    const sources = lookups.sources();
    if (sources.length === 0) return undefined;
    const fs = lookups.fs();
    const backend = fs?.backend();
    if (fs === undefined || backend === undefined) return undefined;
    // 有共用區的 thread 讀共用區裡的技能（#1928），跟模型清單、`/名字` 同一支換。
    const readable = threadSkillSources(sources, fs).filter((source) =>
      readableOutsideGraph(fs, source),
    );
    if (readable.length === 0) return [];
    const scan = await scanSkills(backend, readable);
    if (!scan.complete) {
      lookups.warn(
        '技能清單這一次是空的：掃描不完整（有技能讀不到），照 dsh 的提供者語意一份都不列',
      );
      return [];
    }
    return scan.skills
      .filter((skill) => skill.invocation.userInvocable)
      .sort((left, right) => compareCodePoints(left.name, right.name))
      .map(toEntry);
  };
}

/**
 * 這個來源在圖外（HTTP 處理裡）讀不讀得到。落在組裝點包上去的路由底下就交給那條路由（`/shared` 是磁碟；其餘的讀錯照常算不完整），
 * 否則落在墊底那一格：這條 thread 有可寫根時是磁碟，沒有時是只在圖內讀得到的記憶體 FS。
 */
function readableOutsideGraph(fs: SkillCatalogFs, source: string): boolean {
  if (fs.workspaceRoot() !== undefined) return true;
  return fs.offWorkspacePrefixes().some((prefix) => isUnder(source, prefix));
}

/** `path` 是不是 `prefix` 本身或在它底下；兩邊的結尾斜線都不算數。 */
function isUnder(path: string, prefix: string): boolean {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === base || path.startsWith(`${base}/`);
}

/** 一份技能的元資料，逐格照 dsh `skill-catalog.ts:80-86`：不帶正文。 */
function toEntry(skill: SkillCatalogEntry): SkillEntry {
  return {
    name: skill.name,
    path: skill.path,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    modelInvocable: skill.invocation.modelInvocable,
  };
}

/** 逐碼比，同 dsh 的 `compareCodePoints`（不是 `localeCompare`）。 */
function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
