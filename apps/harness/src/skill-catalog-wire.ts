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
 *   schema 擋掉空清單，所以沒有來源就等於沒掛那一列——回 `undefined`，由 wire 回 `not_supported`（用 nexus 現有的碼）。
 * - **掃描不完整，一份都不列**：dsh 的檔案提供者讀失敗會拋，registry 跳過整個提供者、記一行 warn（`skill/src/index.ts:602-608`），
 *   `list` 照常回。我們整組來源是一次掃描，等於一個提供者，所以照同一個語意回空陣列、記一行 warn。同刀 2 的叫用
 *   （PM 裁決 issuecomment-6358917124 第 1 題），不算偏離。
 *
 * 來源讀登記處（`skillSources` 那份行程級的），**每次呼叫當下讀**，不讀折進 thread 的那一份：同刀 2 的叫用（PM 裁決 (i)），
 * `/名字` 叫得出的和這份清單列的才是同一組。
 *
 * ## 與 dsh 的偏離
 *
 * 1. **`path` 是 backend 命名空間的路徑，不是磁碟路徑**（理由 2）。dsh 的 `path` 是檔案提供者給的 `SKILL.md` 絕對路徑；我們的主機多人共用、
 *    完全內網，把主機上的磁碟路徑交給瀏覽器沒有用處，只多洩漏一份目錄結構。模型讀技能用的也是 backend 命名空間的路徑（基座的 skills
 *    中介層印進 prompt 的那一個），兩邊一致。
 *
 * @module
 */

import { scanSkills } from '@nexus/core';
import type { SkillCatalogEntry } from '@nexus/core';
import type { SkillEntry } from '@nexus/wire';
import type { AnyBackendProtocol } from 'deepagents';

/** {@link createSkillCatalog} 每次呼叫當下要讀的三樣東西。 */
export interface SkillCatalogLookups {
  /** 技能來源，順序就是優先序（後者贏）。空的就是沒掛 `skills` 那一列。 */
  readonly sources: () => readonly string[];
  /** 這條 thread 的檔案 backend；還沒有（沒綁、fold 之前）是 `undefined`。 */
  readonly backend: () => AnyBackendProtocol | undefined;
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
    const backend = lookups.backend();
    if (backend === undefined) return undefined;
    const scan = await scanSkills(backend, sources);
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
