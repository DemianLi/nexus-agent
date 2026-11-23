/**
 * 這條邊界的絆索：**這個套件不得反向依賴 app**。
 *
 * 抽出來之前，這三個模組住在 `apps/harness/src`，彼此之間、以及對 fence 的 import 都是
 * 相對路徑。抽完之後那些邊只剩型別、而且經 `@nexus/core`。**會把它推回去的不是誰決定
 * 要推回去，是某天有人要一個 harness 裡的東西然後順手加一行 import**——那一行照樣
 * typecheck 得過（pnpm workspace 解析得到 `@nexus/harness`），照樣測試全綠，只有
 * `#454` 從 YAML 用套件名載它的那天才會炸。
 *
 * ## 為什麼要先數檔案
 *
 * 一個掃不到任何檔案的結構檢查**永遠綠**。所以下面先斷言掃到的數量下限：glob 寫壞、
 * 檔案搬家、副檔名改掉，都會先在那一條紅，而不是靜靜地回報「零違規」。
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 不准被 import 的 specifier。前者是相對路徑爬出去，後者是走套件名。
 *
 * **判準只看真的 `from '…'`，不看整份原始碼**：散文裡提得到 `@nexus/harness`（
 * `sandbox-mode.ts` 就在解釋 fence 住在那邊），拿 `includes()` 掃會把那些句子判成違規，
 * 而修法會是刪掉正確的註解。
 */
const FORBIDDEN = ['apps/harness', '@nexus/harness'] as const;

/** 一份原始碼裡每一個 `from '…'` / `import '…'` 的 specifier。 */
function specifiers(source: string): readonly string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/gu)].map((match) => match[1]!);
}

/** 這個套件的每一個原始檔，含測試——測試也不准把 app 拖進來。 */
function sources(): readonly string[] {
  return readdirSync(here)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(here, name));
}

describe('套件邊界', () => {
  it('掃得到這個套件的每一個 .ts——掃空的結構檢查永遠綠', () => {
    // 今天是 6 個（index / sandbox-mode / sandbox-escalation / invariant ＋ 兩份測試）。
    // 下限寫 6：再拆檔案不該讓這一條紅，少掉檔案該讓它紅。
    expect(sources().length).toBeGreaterThanOrEqual(6);
  });

  it('沒有任何一個檔 import 得到 app', () => {
    const offenders = sources().flatMap((path) =>
      specifiers(readFileSync(path, 'utf8'))
        .filter((specifier) =>
          FORBIDDEN.some(
            (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
          ),
        )
        .map((specifier) => `${path}: ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });
});
