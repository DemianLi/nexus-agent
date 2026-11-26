// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 「哪顆工具怎麼畫」的知識只放在 adapter 與那張表：`features/tool/` 的產品碼在這幾個檔以外，不准按工具名分支，
 * 否則加一顆工具又要去改 `toStep`、`card.tsx`。
 *
 * 偵測是掃原始碼的樣式（去掉註解之後）。擋得住：`x.name === 'read_file'`、`name !== READ_FILE`、反過來寫的 `'a' === name`、
 * `switch (entry.name)`、`SOME_NAMES.includes(entry.name)`、`new Set([...]).has(name)`、`TABLE[entry.name]`、`name.startsWith('mcp__')`。
 * 擋不住：先把名字存進別的變數名再比（`const tool = entry.name; tool === 'x'`）、拿名字當參數傳給別的函式再由那個函式比
 * （比的那個檔仍會被掃到，除非它不在 `features/tool/`）、用 `Record` 以外的方式動態取值。所以這條是絆索，不是證明。
 */

const ADAPTER_FILES = new Set(['adapter.ts', 'adapters.ts', 'tools.ts', 'result-card.ts']);

/**
 * 對話層的特例：這幾個檔按工具名分支是因為那顆工具不是「一種畫法」，而是對話裡的一個動作。
 * 每個檔釘住命中的那幾處：多一處、少一處都紅，所以清單只能照實變短，例外的檔也不能再多長一個分支。
 */
const CONVERSATION_LEVEL_EXCEPTIONS: Readonly<
  Record<string, { readonly why: string; readonly hits: readonly string[] }>
> = {
  'step.ts': {
    why: '提問、交付檔案、待辦、傳訊給子代理與委派子代理的背景執行，是對話層的清單與面板，不是工具卡的畫法',
    hits: [
      'entry.name === ASK_USER_QUESTION',
      'entry.name === PRESENT',
      'entry.name === TODO_WRITE',
      'entry.name === SEND_MESSAGE',
      'entry.name === SEND_MESSAGE',
      '.includes(entry.name)',
    ],
  },
  'dialog-summary.ts': {
    why: '提問與待辦的一行摘要：觀測分頁問「這顆若是提問或待辦，摘要是什麼」，比工具名的事收在這一個檔，不讓別的分頁自己比',
    hits: ['entry.name === ASK_USER_QUESTION', 'entry.name === TODO_WRITE'],
  },
  'aborted.ts': {
    why: '提問的停止由 `isStoppedQuestion` 另判，被中止的狀態字不套在它身上',
    hits: ['name === ASK_USER_QUESTION'],
  },
  'max-tokens-view.ts': {
    why: '撞到輸出上限的是委派子代理（`task`／`subagent`）這一種對話層的特例',
    hits: ['.includes(entry.name)'],
  },
  'sandbox-escalation.ts': {
    why: '沙箱升級的核准面板：認的是核准動作的名字，不是工具卡',
    hits: ['action.name === SANDBOX_ESCALATION_TOOL'],
  },
  'subagent-view.ts': {
    // `name === ''` 比的是子代理的名字，不是工具名；樣式分不出來，照實列。
    why: '背景子代理的編號、名字表與歸屬，掃的是委派工具那幾顆',
    hits: ["name === ''", '.includes(entry.name)'],
  },
};

const NAME = String.raw`(?:[A-Za-z_$][\w$]*\.)*name`;
const LITERAL = String.raw`(?:'[^']*'|"[^"]*"|\`[^\`]*\`|[A-Z][A-Z0-9_]{2,})`;
const PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b${NAME}\s*[!=]==?\s*${LITERAL}`),
  new RegExp(String.raw`${LITERAL}\s*[!=]==?\s*${NAME}\b`),
  new RegExp(String.raw`\bswitch\s*\(\s*${NAME}\s*\)`),
  new RegExp(String.raw`\.(?:includes|has)\(\s*${NAME}\s*\)`),
  new RegExp(String.raw`\[\s*${NAME}\s*\]`),
  new RegExp(String.raw`\b${NAME}\.(?:startsWith|endsWith)\(`),
  new RegExp(String.raw`\b${NAME}\s+in\s+[A-Za-z_$]`),
];

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** 這段原始碼裡按工具名分支的那幾處（空陣列就是乾淨）。 */
function nameBranches(source: string): string[] {
  const code = withoutComments(source);
  return PATTERNS.flatMap((pattern) =>
    [...code.matchAll(new RegExp(pattern, 'g'))].map((match) => match[0]),
  );
}

const dir = new URL('./', import.meta.url);
const productFiles = readdirSync(dir).filter(
  (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
);
const scanned = productFiles.filter((file) => !ADAPTER_FILES.has(file));

describe('量具自檢', () => {
  it('掃得到 features/tool 的產品碼，也掃得到 adapter 那幾個檔', () => {
    expect(productFiles.length).toBeGreaterThan(10);
    expect(productFiles).toEqual(expect.arrayContaining(['step.ts', 'card.tsx', 'view.ts']));
    for (const file of ADAPTER_FILES) expect(productFiles).toContain(file);
    expect(scanned).not.toContain('tools.ts');
  });

  it.each([
    "entry.name === 'read_file'",
    "if (name !== 'edit_file') return;",
    'name === READ_FILE',
    "'x' === entry.name",
    'switch (entry.name) { }',
    'DELEGATION_TOOL_NAMES.includes(entry.name)',
    "new Set(['a']).has(entry.name)",
    'return TITLES[entry.name];',
    "name.startsWith('mcp__')",
  ])('擋得住 %s', (line) => {
    expect(nameBranches(line)).not.toEqual([]);
  });

  it.each([
    "attribution.kind === 'root'",
    'const title = toolTitle(entry.name);',
    "// entry.name === 'read_file'",
    "/* name === 'x' */ const a = 1;",
    'label: `${attribution.name}`',
  ])('放行 %s', (line) => {
    expect(nameBranches(line)).toEqual([]);
  });
});

describe('工具名只在 adapter 與那張表上分支', () => {
  const hits = new Map(
    scanned.map((file) => [file, nameBranches(readFileSync(new URL(file, dir), 'utf8'))]),
  );

  it.each(scanned.filter((file) => !(file in CONVERSATION_LEVEL_EXCEPTIONS)))(
    '%s 沒有按工具名分支',
    (file) => {
      expect(hits.get(file)).toEqual([]);
    },
  );

  it.each(Object.entries(CONVERSATION_LEVEL_EXCEPTIONS))(
    '例外 %s 命中的分支跟清單上列的一模一樣',
    (file, { hits: listed }) => {
      expect(scanned, `${file} 不在 features/tool/ 了，從清單拿掉`).toContain(file);
      expect([...(hits.get(file) ?? [])].sort()).toEqual([...listed].sort());
    },
  );
});
