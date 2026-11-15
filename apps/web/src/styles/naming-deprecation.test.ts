// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { isVendorUpstream } from '@/test/vendor-upstream';

/**
 * 命名與棄用（`COMPONENTS.md`「命名」「棄用」；規格 §13.6）裡機器判得出來的部分。vendor 上游原樣的檔不管，它們跟著上游走。
 *
 * 命名：
 * 1. **檔名 kebab-case**（`components/` 底下的 `.tsx`）。
 * 2. **檔名不重複資料夾名**（`tool/result.tsx`，不是 `tool/tool-result.tsx`）。舊的不為了對齊而改名，釘在 {@link REPEATS_FOLDER}，只能變少。
 * 3. **布林的 props 不加 `is`**（`open`、`busy`，不是 `isOpen`）。例外列在 {@link PROPS_ALLOWED}，只能變少。
 * 4. **事件的 props 是 `on` 加動詞**：不取 `handleX`、`xHandler`、`xCallback`。
 * 5. **給外層補樣式的口只有 `className`**：不另外開 `xxxClassName`。
 * 6. **token 的名字說用途不說值**：不取 `--gray-200`、`--text-13` 這種帶數值的名字。
 *
 * 棄用：
 * 7. **`@deprecated` 寫明從哪一版開始、改用什麼**：`@deprecated 0.7.0：改用 Surface`。版號是標記當下 `package.json` 的版號，
 *    刪除的那張 PR 靠它確認已經隨一個 Release 出去過。
 * 8. **標了棄用的東西 repo 裡沒有用法**：標記的那張 PR 要把用法全部換掉。
 *
 * 判不出來的：事件名的動詞取得好不好、該用字串聯集卻開了好幾個布林、標記之後有沒有真的等一個 Release 才刪。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, keep);
    return keep(path) && !isVendorUpstream(path) ? [path] : [];
  });
}

const isTest = (path: string) => /\.test\.tsx?$/.test(path);
const code = walk(SRC, (path) => /\.tsx?$/.test(path) && !isTest(path));
const styles = walk(SRC, (path) => path.endsWith('.css'));
const components = code.filter(
  (path) => path.startsWith(join(SRC, 'components')) && path.endsWith('.tsx'),
);
const rel = (path: string) => relative(SRC, path);
const read = (path: string) => readFileSync(path, 'utf8');

/** 檔名重複了資料夾名、在這條規則之前就有的檔。 */
const REPEATS_FOLDER: readonly string[] = [
  'components/conversation/conversation-body.tsx',
  'components/conversation/conversation-feedback-dialog.tsx',
  'components/conversation/conversation-notices.tsx',
];

/** props 命名的例外，在這條規則之前就有的。只能變少。 */
const PROPS_ALLOWED: readonly { file: string; name: string; why: string }[] = [
  {
    file: 'components/sidebar/right-sidebar-context.ts',
    name: 'isMobile',
    why: '跟 vendor 的 `useSidebar().isMobile` 同名：左右側欄用同一個字，呼叫端不必記兩個',
  },
];

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function repeatsFolder(path: string): boolean {
  const folder = basename(dirname(path));
  return folder !== 'components' && basename(path).startsWith(`${folder}-`);
}

/** 型別宣告裡一個成員的名字與型別：`  name?: type`。 */
const MEMBER = /^\s+(?:readonly\s+)?(\w+)\??:\s*(.+)$/gm;

function badProps(source: string): string[] {
  return [...source.matchAll(MEMBER)].flatMap((m) => {
    const name = m[1] ?? '';
    const type = m[2] ?? '';
    if (/^is[A-Z]/.test(name) && /^boolean\b/.test(type)) return [`${name}（布林不加 is）`];
    if (/^handle[A-Z]/.test(name) || /(?:Handler|Callback)$/.test(name)) {
      return [`${name}（事件用 on 加動詞）`];
    }
    if (/.ClassName$/.test(name)) return [`${name}（只開一個 className）`];
    return [];
  });
}

const VALUE_NAME = /^--(?:[a-z]+-)*\d+$/;

function declaredTokens(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(
    (m) => m[1] ?? '',
  );
}

const MARK = /@deprecated\b[^\n]*/g;
const MARK_FORMAT = /^@deprecated (\d+)\.(\d+)\.(\d+)：改用\s*\S/;

function newerThan(version: string, current: string): boolean {
  const [a, b] = [version, current].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) {
    if ((a?.[i] ?? 0) !== (b?.[i] ?? 0)) return (a?.[i] ?? 0) > (b?.[i] ?? 0);
  }
  return false;
}

/** 一條標記寫得對不對；對的回 `null`。 */
function markProblem(mark: string, current: string): string | null {
  const m = MARK_FORMAT.exec(mark.replace(/\s*\*\/\s*$/, ''));
  if (m === null) return '要寫成「@deprecated <版號>：改用 <什麼>」';
  return newerThan(`${m[1]}.${m[2]}.${m[3]}`, current) ? `版號比現在的 ${current} 還新` : null;
}

/** 標記後面被棄用的名字：程式碼是下一個宣告的名字，css 是下一個自訂屬性。 */
function deprecatedNames(source: string): string[] {
  return [...source.matchAll(MARK)].flatMap((m) => {
    const rest = source.slice((m.index ?? 0) + m[0].length);
    const next =
      /^[\s*/]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)/.exec(
        rest,
      ) ?? /^[\s*/]*(--[\w-]+)\s*:/.exec(rest);
    return next?.[1] === undefined ? [] : [next[1]];
  });
}

/** 一個名字在一份原始碼裡被用到幾次（宣告的那一次也算）。 */
function uses(name: string, source: string): number {
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const pattern = name.startsWith('--')
    ? new RegExp(`${escaped}(?![\\w-])`, 'g')
    : new RegExp(`\\b${escaped}\\b`, 'g');
  return (source.match(pattern) ?? []).length;
}

describe('命名', () => {
  test('量具自檢：掃得到元件、程式碼與樣式', () => {
    expect(components.length).toBeGreaterThan(50);
    expect(code.length).toBeGreaterThan(components.length);
    expect(styles.length).toBeGreaterThan(3);
  });

  test('元件的檔名是 kebab-case', () => {
    expect(components.filter((path) => !KEBAB.test(basename(path, '.tsx'))).map(rel)).toEqual([]);
  });

  test('檔名不重複資料夾名：就是釘住的那幾個，沒有多也沒有少', () => {
    expect(components.filter(repeatsFolder).map(rel).sort()).toEqual([...REPEATS_FOLDER].sort());
  });

  test('props 的命名：布林不加 is、事件用 on 加動詞、只開一個 className（例外見 PROPS_ALLOWED）', () => {
    const found = code.flatMap((path) =>
      badProps(read(path)).map((what) => ({ file: rel(path), what })),
    );
    const allowed = (v: { file: string; what: string }) =>
      PROPS_ALLOWED.some((a) => a.file === v.file && v.what.startsWith(`${a.name}（`));
    expect(found.filter((v) => !allowed(v)).map((v) => `${v.file}：${v.what}`)).toEqual([]);
    expect(
      PROPS_ALLOWED.filter((a) => !found.some((v) => allowed(v) && v.file === a.file)).map(
        (a) => a.name,
      ),
    ).toEqual([]);
    expect(PROPS_ALLOWED.filter((a) => a.why.trim() === '')).toEqual([]);
  });

  test('token 的名字不帶數值', () => {
    expect(
      styles.flatMap((path) =>
        declaredTokens(read(path))
          .filter((name) => VALUE_NAME.test(name))
          .map((name) => `${rel(path)}：${name}`),
      ),
    ).toEqual([]);
  });
});

describe('棄用', () => {
  const sources = [...code, ...styles].map((path) => ({ path, source: read(path) }));

  test('每條 @deprecated 都寫了從哪一版開始、改用什麼', () => {
    expect(
      sources.flatMap(({ path, source }) =>
        [...source.matchAll(MARK)].flatMap((m) => {
          const problem = markProblem(m[0], VERSION);
          return problem === null ? [] : [`${rel(path)}：${m[0].trim()}（${problem}）`];
        }),
      ),
    ).toEqual([]);
  });

  test('標了棄用的東西 repo 裡沒有用法', () => {
    const names = sources.flatMap(({ path, source }) =>
      deprecatedNames(source).map((name) => ({ name, home: path })),
    );
    expect(
      names.flatMap(({ name, home }) =>
        sources
          .filter(({ path, source }) => path !== home && uses(name, source) > 0)
          .map(({ path }) => `${name}（標在 ${rel(home)}）還用在 ${rel(path)}`),
      ),
    ).toEqual([]);
  });
});

describe('判準', () => {
  test('檔名：kebab-case 才過；重複資料夾名的擋，`components/` 這一層不算', () => {
    expect(KEBAB.test('row-trigger')).toBe(true);
    expect(KEBAB.test('RowTrigger')).toBe(false);
    expect(KEBAB.test('row_trigger')).toBe(false);
    expect(repeatsFolder('/x/components/tool/tool-result.tsx')).toBe(true);
    expect(repeatsFolder('/x/components/tool/result.tsx')).toBe(false);
    expect(repeatsFolder('/x/components/components-list.tsx')).toBe(false);
  });

  test('props：is 開頭的布林、handle／Handler／Callback、xxxClassName 擋；回布林的函式、on 開頭、className 不擋', () => {
    const bad = badProps(
      [
        'interface Props {',
        '  isOpen: boolean;',
        '  handleClick: () => void;',
        '  closeHandler?: () => void;',
        '  doneCallback: () => void;',
        '  readonly labelClassName?: string;',
        '}',
      ].join('\n'),
    );
    expect(bad.map((what) => what.split('（')[0])).toEqual([
      'isOpen',
      'handleClick',
      'closeHandler',
      'doneCallback',
      'labelClassName',
    ]);
    expect(
      badProps(
        [
          'interface Props {',
          '  open: boolean;',
          '  canSend?: boolean;',
          '  isBlank: (item: Item) => boolean;',
          '  onOpenChange: (open: boolean) => void;',
          '  className?: string;',
          '}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test('token：結尾是數值的名字擋，說用途的不擋', () => {
    expect(['--gray-200', '--text-13'].every((name) => VALUE_NAME.test(name))).toBe(true);
    expect(
      ['--text-ui', '--radius-row', '--muted-foreground', '--radius-2xl'].some((name) =>
        VALUE_NAME.test(name),
      ),
    ).toBe(false);
    expect(declaredTokens('/* --old: 1 */\n:root {\n  --brand: red;\n}')).toEqual(['--brand']);
  });

  test('標記：少了版號、少了改用什麼、版號比現在新都擋', () => {
    expect(markProblem('@deprecated 0.6.0：改用 Surface', '0.6.2')).toBeNull();
    expect(markProblem('@deprecated 0.6.0：改用 --scrim */', '0.6.2')).toBeNull();
    expect(markProblem('@deprecated 改用 Surface', '0.6.2')).not.toBeNull();
    expect(markProblem('@deprecated 0.6.0', '0.6.2')).not.toBeNull();
    expect(markProblem('@deprecated 0.7.0：改用 Surface', '0.6.2')).toContain('還新');
    expect(newerThan('0.10.0', '0.9.9')).toBe(true);
  });

  test('用法：標記後面的宣告或自訂屬性就是被棄用的名字，別的檔提到它就算用到', () => {
    const component = [
      '/**',
      ' * 舊的卡片。',
      ' * @deprecated 0.6.0：改用 Surface',
      ' */',
      'export function OldCard() {}',
    ].join('\n');
    const css = ':root {\n  /* @deprecated 0.6.0：改用 --scrim */\n  --veil: red;\n}';
    expect(deprecatedNames(component)).toEqual(['OldCard']);
    expect(deprecatedNames(css)).toEqual(['--veil']);
    expect(uses('OldCard', "import { OldCard } from './old-card';\n<OldCard />")).toBe(2);
    expect(uses('OldCard', '<OldCardList />')).toBe(0);
    expect(uses('--veil', 'background: var(--veil);')).toBe(1);
    expect(uses('--veil', 'background: var(--veil-strong);')).toBe(0);
  });
});
