/**
 * `PluginRegistry` 有幾條通道，以及**樹上哪幾處散文逐字寫著那個數字**。
 *
 * 圖是 [#190](https://github.com/DemianLi/nexus-agent/issues/190)，這一份是它的候選 6
 * （[#195](https://github.com/DemianLi/nexus-agent/issues/195)）。卡上的射程本來只有「兩處
 * 十五改成十四」，開卡時量到的事把它放寬成這條絆索。
 *
 * ## 那兩處不是過期，是從沒對過
 *
 * `apps/harness/src/goal-driver.ts` 與 `packages/nexus-plugin-goal/src/index.ts` 都寫著
 * 「`PluginRegistry` 十五條通道沒有一條排得出一輪」，兩處由**同一顆 commit** 生出
 * （`c4fe696`，[#181](https://github.com/DemianLi/nexus-agent/pull/181)，2026-09-05）。在它的
 * 父節點上數 `PluginRegistry` 就已經是 14 個欄位——第十四條 `sessions` 早四天就在了
 * （[#138](https://github.com/DemianLi/nexus-agent/pull/138)）。**寫下去的那一刻它就是錯的。**
 * 而且那句話自己打自己：它引著 `registry.ts:559-572`，那是 **14 行**。
 *
 * **這個數字漂過兩次。** 第一次記在 `.docs/plugin-architecture-gap-survey.md` 那張表上
 * （`registry.ts` 檔頭與計劃書當時寫著「一條」／「四條」，跟那份筆記同一張 PR 改正）。兩次
 * 之間沒有任何東西在數它——這就是這個檔案存在的理由。**為什麼會多數一條沒查，也不猜。**
 *
 * ## 光釘住數字不夠，所以散文的期望值是**算出來的**
 *
 * 一條 `expect(欄位數).toBe(14)` 今天當然綠，而且它擋的是型別、不是散文——第十五條通道落地
 * 那天它會紅，但沒有任何東西告訴你還有哪幾行要跟著改。所以下面那組斷言**不寫死中文字**：
 * 每一處散文的期望字串都由 {@link TOTAL_CHANNELS} 經 {@link cn} 算出來。把常數改成 15 而不
 * 掃散文，散文那幾條當場紅——**數字與散文之間那條機械連結就是這個檔案的產物**，數字本身只是
 * 順帶釘住的。
 *
 * ## 型別那一層由編譯器守，不由正則守
 *
 * {@link CHANNELS} 是一份 `satisfies Record<keyof PluginRegistry, true>` 的窮舉表：加一個
 * 欄位而不加進來，`typecheck` 紅在「少一個屬性」；刪一個欄位而不拿掉，紅在「多一個屬性」。
 * **不掃原始碼、不用正則**，所以它不會因為換行或改註解而失準。順序是兩段的：`typecheck` 先
 * 指到這個檔案，這個檔案的失敗訊息再告訴你要掃哪幾行。
 *
 * ## 哪幾處**不**在斷言裡，以及為什麼
 *
 * **有些數字是歷史，有些是現況，只有現況那幾處會漂。** `sessions.ts` 的「這是第十四個註冊
 * 點」與 `nexus-plugin-plan-mode/src/index.ts` 的「[#126] 加了第十四個註冊點」講的是**它們
 * 落地時排第幾**——第十五條通道出現之後，`sessions` 仍然是第十四個。把它們一起釘住，等於要求
 * 未來的人去改一句本來就對的話。
 *
 * `.docs/` 底下另有兩處（`plugin-architecture-gap-survey.md` 的「14 個欄位（9 ＋ 5）」與
 * `development-plan.md` 的「九個註冊點 ＋ 五條通道」）寫的是現況，**但用阿拉伯數字而且不在
 * #195 的改動範圍內**，所以只進下面的提醒清單、不進斷言。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { PluginRegistry } from '@nexus/core';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * 十四條通道逐個列出來。
 *
 * `satisfies` 那一句是這個檔案的骨頭：**它讓編譯器去比對 `PluginRegistry` 的欄位集合**，
 * 少一個或多一個都在 `typecheck` 當場紅。值是什麼不重要，重要的是鍵。
 */
const CHANNELS = {
  // 九個折進 `createDeepAgent` 參數的註冊點。
  tools: true,
  subagents: true,
  capabilities: true,
  backend: true,
  middleware: true,
  permissions: true,
  approvals: true,
  skills: true,
  memory: true,
  // 五條不折進任何參數的正交通道。
  lifecycle: true,
  telemetry: true,
  invariants: true,
  commands: true,
  sessions: true,
} satisfies Record<keyof PluginRegistry, true>;

/** 折進 `createDeepAgent` 參數的那幾個。`registry.ts` 檔頭的「九個註冊點」。 */
const FOLDED_CHANNELS = 9;
/** 不折進任何參數的正交通道。`registry.ts` 檔頭的「外加五條」。 */
const ORTHOGONAL_CHANNELS = 5;
/** 兩者相加，也就是 `PluginRegistry` 的欄位數。 */
const TOTAL_CHANNELS = FOLDED_CHANNELS + ORTHOGONAL_CHANNELS;

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

/**
 * 把數字寫成散文裡的樣子。
 *
 * 只認得 0–19，因為通道數走不到那之外還不改這個檔案的話，這條絆索的前提早就變了。
 * **超出範圍拋，不回一個對不上的字串**——靜靜地讓每一條斷言都紅，會把人指向散文而不是這裡。
 */
function cn(value: number): string {
  if (value < 10) return DIGITS[value]!;
  if (value < 20) return value === 10 ? '十' : `十${DIGITS[value - 10]!}`;
  throw new Error(
    `通道數 ${value} 超出 cn() 認得的範圍。補齊它，順便重讀一次這個檔案的檔頭：` +
      `散文那幾處的期望值是從這裡算出來的。`,
  );
}

/** 一處逐字寫著通道數的散文。`phrases` 是**算出來的**，不是寫死的中文字。 */
interface ProseSite {
  /** repo 相對路徑。直接讀，不 glob——檔案改名要 ENOENT，不能靜靜地掃不到。 */
  readonly path: string;
  /** 這個檔案裡必須出現的字串。 */
  readonly phrases: readonly string[];
}

const PROSE_SITES: readonly ProseSite[] = [
  {
    // 定義處。九與五的拆法本身也寫在這裡，所以兩個數字都釘。
    path: 'packages/nexus-core/src/registry.ts',
    phrases: [`${cn(FOLDED_CHANNELS)}個註冊點`, `外加${cn(ORTHOGONAL_CHANNELS)}條`],
  },
  {
    // #181 的載體偏離：「沒有一條排得出一輪」。十五是在這裡被寫下去的。
    path: 'apps/harness/src/goal-driver.ts',
    phrases: [`${cn(TOTAL_CHANNELS)}條通道`],
  },
  {
    // 同一筆偏離的另一半，同一顆 commit。
    path: 'packages/nexus-plugin-goal/src/index.ts',
    phrases: [`${cn(TOTAL_CHANNELS)}條通道`],
  },
  {
    // #193 的索引：「最直覺的家是 `PluginRegistry` 的十四個欄位，那是錯的軸」。
    path: 'apps/harness/src/interception-index.test.ts',
    phrases: [`${cn(TOTAL_CHANNELS)}個欄位`],
  },
];

/** 斷言擋不到、但通道數變了就要人去看一眼的地方。**這份清單是這條絆索的價值所在。** */
const ALSO_SWEEP = [
  '.docs/plugin-architecture-gap-survey.md（「14 個欄位（9 ＋ 5）」，阿拉伯數字）',
  '.docs/development-plan.md（「九個註冊點 ＋ 五條通道」）',
  'packages/nexus-core/src/load.ts 與 load.test.ts（「九個註冊點一個都不能漏」）',
].join('\n  - ');

describe('PluginRegistry 的通道數', () => {
  it(`是 ${TOTAL_CHANNELS} 條，而且九加五的拆法沒變`, () => {
    expect(Object.keys(CHANNELS)).toHaveLength(TOTAL_CHANNELS);
    expect(FOLDED_CHANNELS + ORTHOGONAL_CHANNELS).toBe(TOTAL_CHANNELS);
  });

  it.each(PROSE_SITES)('$path 講的通道數跟型別對得上', ({ path, phrases }) => {
    const source = readFileSync(join(REPO_ROOT, path), 'utf8');
    for (const phrase of phrases) {
      expect(
        source,
        `${path} 找不到「${phrase}」。\n` +
          `通道數是 ${TOTAL_CHANNELS}（${FOLDED_CHANNELS} 折進 createDeepAgent ＋ ` +
          `${ORTHOGONAL_CHANNELS} 條正交），這個檔案的散文沒跟上。\n` +
          `改完之後另外去看一眼（斷言擋不到）：\n  - ${ALSO_SWEEP}\n` +
          `**不要改**「第十四個註冊點」那幾處（sessions.ts、plan-mode）——那是落地順序，是歷史不是現況。`,
      ).toContain(phrase);
    }
  });
});
