/**
 * 把「每個 workspace 套件的每個說法對到哪個來源檔」寫進 `tsconfig.base.json` 的標記區塊，並整份產生 `tsconfig.runtime.json`
 * （[#1502](https://github.com/DemianLi/nexus-agent/issues/1502)，照 dsh `scripts/gen-tsconfig-paths.ts`）。
 *
 * **兩份，差在 vendor（為什麼非開第二份不可，兩個實測理由）。** `tsconfig.base.json`（tsc 的型別檢查）不含 `vendor/*`：上游原始碼用較寬鬆的 tsconfig 檢查，放進嚴格設定會噴
 * 出一批與本專案無關的錯（實測 186 個），型別維持今天的來源（各 vendor 套件 `prepare` 產的 `lib/types/*.d.ts`）。`tsconfig.runtime.json`
 * （tsx、vitest 用）含全部、並關掉 `verbatimModuleSyntax`（vendor 原始碼有未標 `type` 的型別 import，esbuild 在該旗標下會留著而載入失敗），載進來的是 `src/`——不然 vendor 要先建置才跑得了開發環境，改了原始碼卻跑到舊的 `lib/`。
 *
 * 套件的 `main`／`exports` 直接指 `lib/`（裝進 `node_modules` 之後 Node 要載的是編好的 JS），所以在原始碼樹裡 tsc、tsx 與 vitest
 * 都要靠這份 `paths` 才解得到 `src/`。`--check` 只報漂移不寫檔，接在 gate：新增套件或 subpath 忘了重新產生，CI 當場紅。
 *
 * `apps/web/tsconfig.json` 也寫一份（標記區塊在它的 `paths` 裡，相對 `apps/web` 的路徑）：TS 的 `paths` 不跟 `extends` 的 base 合併，
 * web 自己設了 `paths`（`@/*`、`cn`）就會整個蓋掉 base 那份。vite 外掛讀 web 自己的 `tsconfig.json`，不讀根的 base。
 *
 * 產生器本身被動不動就改的是「區塊內」；區塊外手寫的條目與註解原樣保留。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { format, resolveConfig } from 'prettier';

import { ROOT, workspacePackages } from './workspace-packages.js';
import type { Alias } from './workspace-packages.js';

const BEGIN = '// BEGIN generated package aliases — pnpm run gen-tsconfig-paths';
const END = '// END generated package aliases';

/** 要寫區塊的 tsconfig（路徑相對這個檔所在目錄寫）。不含 vendor：理由見檔頭。 */
const TARGETS = ['tsconfig.base.json', 'apps/web/tsconfig.json'] as const;

/** 整份產生的執行期 tsconfig，含 vendor。 */
const RUNTIME = 'tsconfig.runtime.json';

/** 一條 alias 寫成一行 JSON 成員（路徑相對 `from` 目錄）。 */
function renderAlias(alias: Alias, from: string): string {
  const absolute = join(ROOT, alias.source);
  let path = relative(from, absolute).split('\\').join('/');
  if (!path.startsWith('.')) path = `./${path}`;
  return `${JSON.stringify(alias.specifier)}: [${JSON.stringify(path)}]`;
}

/**
 * 產生 alias 區塊本體（不含標記）。
 *
 * @param from - 要寫入的 tsconfig 所在目錄。
 * @param indent - 每行縮排。
 * @param withVendor - 要不要含 `vendor/*`。
 */
export function renderRegion(from: string, indent: string, withVendor: boolean): string {
  const aliases = workspacePackages()
    .filter((pkg) => withVendor || !pkg.vendor)
    .flatMap((pkg) => pkg.aliases);
  const seen = new Set<string>();
  for (const alias of aliases) {
    if (seen.has(alias.specifier)) {
      throw new Error(`gen-tsconfig-paths：${alias.specifier} 被兩個套件同時宣告`);
    }
    seen.add(alias.specifier);
  }
  return aliases.map((alias) => `${indent}${renderAlias(alias, from)}`).join(',\n');
}

/**
 * 把區塊換成新內容。
 *
 * @throws 標記不見或順序不對。
 */
export function writeRegion(text: string, body: string, indent: string, file: string): string {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin < 0 || end < begin) {
    throw new Error(`gen-tsconfig-paths：${file} 缺少產生區塊的標記（${BEGIN}）`);
  }
  return `${text.slice(0, begin)}${BEGIN}\n${body}\n${indent}${END}${text.slice(end + END.length)}`;
}

function indentOf(text: string): string {
  const begin = text.indexOf(BEGIN);
  const lineStart = text.lastIndexOf('\n', begin) + 1;
  return text.slice(lineStart, begin);
}

/** 執行期 tsconfig 的完整內容：繼承 base 的編譯選項，`paths` 換成含 vendor 的全部。 */
export function renderRuntime(): string {
  const indent = '      ';
  return [
    '{',
    '  // 產生的檔，不要手改：pnpm run gen-tsconfig-paths（scripts/gen-tsconfig-paths.ts）。',
    '  // tsx 與 vitest 用它把 @nexus/* 對回 src/；型別檢查用 tsconfig.base.json（不含 vendor，理由見產生器檔頭）。',
    '  "extends": "./tsconfig.base.json",',
    '  "compilerOptions": {',
    // vendor 的原始碼寫 `import { defineProperty, Dict } from 'cosmokit'`（Dict 是型別）：base 的 verbatimModuleSyntax 會讓
    // esbuild 把它原樣留著，tsx 載入時 `cosmokit does not provide an export named 'Dict'`。tsx 與 vitest 不做型別檢查，關掉它。
    '    "verbatimModuleSyntax": false,',
    '    "paths": {',
    renderRegion(ROOT, indent, true),
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

/**
 * 過 prettier 排成 repo 的格式。**這些檔也在 `prettier --check` 的範圍裡**（CI 的 static 查它們，不能列進 `.prettierignore`），
 * 所以預期內容是「產生之後再排版」的結果：`--check` 比的也是排版後的，產生器與 prettier 才不會互相拉扯。
 */
async function formatted(file: string, text: string): Promise<string> {
  const path = join(ROOT, file);
  const options = (await resolveConfig(path)) ?? {};
  return format(text, { ...options, filepath: path });
}

/** 預期內容 → 檔案。 */
async function expectedFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const target of TARGETS) {
    const current = readFileSync(join(ROOT, target), 'utf8');
    const indent = indentOf(current);
    const body = renderRegion(join(ROOT, target, '..'), indent, false);
    files.set(target, await formatted(target, writeRegion(current, body, indent, target)));
  }
  files.set(RUNTIME, await formatted(RUNTIME, renderRuntime()));
  return files;
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [target, next] of await expectedFiles()) {
    const file = join(ROOT, target);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (next === current) continue;
    if (check) {
      console.error(
        `gen-tsconfig-paths：${target} 的套件別名過期了，跑 \`pnpm run gen-tsconfig-paths\`。`,
      );
      stale = true;
    } else {
      writeFileSync(file, next);
      console.log(`gen-tsconfig-paths：已改寫 ${target}`);
    }
  }
  if (stale) process.exitCode = 1;
  else if (check) console.log('gen-tsconfig-paths：套件別名是最新的。');
}
