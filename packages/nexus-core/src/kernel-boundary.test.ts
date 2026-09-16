/**
 * 容器層的相依絆索。
 *
 * `@nexus/core` 一個包同時扮三個角色：**容器**（誰持有 plugin、誰做載入與回滾）、
 * **領域**（會話日誌、摘要、工具註冊表）、**打底**（`fold` 決定預設掛什麼）。
 * 三合一是刻意的選擇，理由與取捨見
 * [`.docs/kernel-split-tradeoff.md`](../../../.docs/kernel-split-tradeoff.md)。
 *
 * 那份筆記的前提是「容器層今天沒有碰過任何 agent 概念」，而那件事**今天成立純屬紀律**
 * ——沒有包邊界擋著誰在 `load.ts` 裡 import `summarization.ts`。這個檔案把那條紀律變成
 * 會紅的東西：它不阻止三合一，它只保證**拆分這個選項不會在無人察覺時失效**。
 *
 * 兩條規則不同強度：
 *
 * - **容器層**（{@link KERNEL_FILES}）對領域套件零相依，連型別都不行。它們要能原封搬進
 *   一個不認識 deepagents 的包。
 * - **接縫**（{@link SEAM_FILES}）指名得了領域型別，但**只能 `import type`**——那是讓
 *   接縫在執行期不存在的原因，也是拆分成本停留在「改 import」而不是「拆執行期相依」的原因。
 *
 * 只認 `import type` 這個寫法，不認 `import { type X }`：兩者編譯後等價，但絆索要看得懂，
 * 而統一寫法的成本是一次改寫。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** 容器層：對領域套件零相依，型別也不行。 */
const KERNEL_FILES = ['plugin.ts', 'load.ts', 'entries.ts'] as const;

/** 接縫：指名得了領域型別，但只能 `import type`。 */
const SEAM_FILES = ['registry.ts'] as const;

/**
 * 領域套件。比對的是 import 來源的**開頭**，所以 `@langchain/core/tools` 這種子路徑
 * 也算得到。
 */
const DOMAIN_PACKAGES = ['deepagents', 'langchain', '@langchain/', '@langgraph/'];

/** 一條 import 敘述：它從哪裡拿、在第幾行、是不是純型別。 */
interface ImportStatement {
  readonly line: number;
  readonly source: string;
  readonly typeOnly: boolean;
}

/**
 * 把註解換成等量的換行再掃。
 *
 * **保留行數**是為了錯誤訊息指得出行號；直接刪掉註解會讓後面每一行的號碼都錯位，而錯位的
 * 行號比沒有行號更糟。
 */
function stripComments(source: string): string {
  const blanked = (match: string): string => match.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blanked).replace(/\/\/[^\n]*/g, blanked);
}

/**
 * 掃出一個檔案的所有靜態 import。
 *
 * @param file - `src/` 底下的檔名。
 * @returns 依出現順序的 import 敘述。
 */
function readImports(file: string): ImportStatement[] {
  const text = stripComments(readFileSync(join(SRC_DIR, file), 'utf8'));
  const pattern = /import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const found: ImportStatement[] = [];
  for (const match of text.matchAll(pattern)) {
    found.push({
      line: text.slice(0, match.index).split('\n').length,
      source: match[2] as string,
      typeOnly: match[1] !== undefined,
    });
  }
  return found;
}

/** 這個 import 來源是不是領域套件。 */
function isDomain(source: string): boolean {
  return DOMAIN_PACKAGES.some((pkg) => source === pkg || source.startsWith(pkg));
}

describe('容器層與領域層的邊界', () => {
  it.each(KERNEL_FILES)('%s 對領域套件零相依', (file) => {
    const offenders = readImports(file)
      .filter((entry) => isDomain(entry.source))
      .map((entry) => `${file}:${entry.line} import ${JSON.stringify(entry.source)}`);
    expect(
      offenders,
      `容器層不該認識 agent 的任何東西——這三個檔案要能原封搬進一個不認識 deepagents 的包。` +
        `真的需要那個型別，就把它搬到 registry.ts 的接縫上再由容器層以泛型收下。`,
    ).toEqual([]);
  });

  it.each(SEAM_FILES)('%s 只用 import type 認領域套件', (file) => {
    const offenders = readImports(file)
      .filter((entry) => isDomain(entry.source) && !entry.typeOnly)
      .map((entry) => `${file}:${entry.line} import ${JSON.stringify(entry.source)}`);
    expect(
      offenders,
      `接縫上的領域相依必須是 import type：值相依會讓這個檔案在執行期真的載入 deepagents，` +
        `拆分成本就從「改 import」變成「拆執行期相依」。`,
    ).toEqual([]);
  });

  it('絆索本身認得出違規', () => {
    // 絆索的價值全在「壞掉時會紅」，所以這裡證明它對兩種違規都認得出來，而不是
    // 因為正則寫壞了永遠回空陣列。
    expect(isDomain('deepagents')).toBe(true);
    expect(isDomain('@langchain/core/tools')).toBe(true);
    expect(isDomain('./registry.js')).toBe(false);
    expect(isDomain('zod')).toBe(false);

    const sample = [
      "import { createDeepAgent } from 'deepagents';",
      "import type { StructuredTool } from '@langchain/core/tools';",
      "import { z } from 'zod';",
    ].join('\n');
    const parsed = [
      ...sample.matchAll(/import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g),
    ];
    expect(parsed.map((m) => [m[2], m[1] !== undefined])).toEqual([
      ['deepagents', false],
      ['@langchain/core/tools', true],
      ['zod', false],
    ]);
  });
});
