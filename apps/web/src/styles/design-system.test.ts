// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * 元件只能用系統裡的值（#1141 第 2 刀；`.docs/web-ui-spec.md` §5、§11 第 12 條）：顏色、字級、圓角各有一份階梯，
 * 元件的 className 越過它就報錯。守的是**原始碼裡的字串字面值**（className、cva 的各段、`cn(...)` 的參數都是字串），
 * 做法同 `border-shadow.test.ts`；先把註解拿掉，註解裡講到類別名不算。
 *
 * 十三條：
 * 1. **不用 Tailwind 預設色板**（`text-red-500`、`bg-white`、`bg-black/50`…）：顏色只走語意 token（`bg-card`、`text-destructive`…）。
 * 2. **字級只走 `text-ui`／`text-body`／`text-tip`／`text-micro`**：不用 `text-xs`／`text-sm`／`text-base`…，也不寫 `text-[…px]`。
 * 3. **圓角只走階梯**（`rounded-sm`…`rounded-3xl`、`rounded-full`）：不寫 `rounded-[20px]` 這種數字。
 * 4. **不硬寫顏色字面值**：`#fff`、`rgb(…)`、沒有 `var(…)` 的 `oklch(…)`／`color-mix(…)`。從 token 推出來的（`oklch(from var(--primary) …)`）可以。
 * 5. **卡片與內層 stage 用 `Surface`，不手寫配方**：同一個字串裡有 `bg-stage`＋`shadow-stage`、`bg-card`＋`shadow-material`＋`rounded-3xl`，或 `bg-card`＋`border`＋`rounded-3xl`，就是又手寫了一份（#1141 第 3 刀）。
 * 6. **展開箭頭用 `Chevron`**（#1279）：同一個字串裡有 `transition-transform`＋`rotate-*`，或跟著 `data-state=open` 轉的 `rotate-*`，就是又手寫了一顆。
 * 7. **可展開列用 `RowTrigger`**（#1279）：同一個字串裡有 `hover:bg-chip-hover`＋`active:bg-chip-pressed`＋`w-full`＋`text-left`，就是又手寫了一列。
 * 8. **`ui/` 以外不寫 `focus-visible:ring-*`**（#1279）：`theme.css` 在 layer 外把 ring 清掉、改畫全域 outline，所以元件裡的 ring 畫不出來；
 *    再配上 `outline-none` 就是**完全看不到焦點**（#1279 之前有六處）。要改外框位置用 `focus-visible:-outline-offset-2` 之類，不要換成 ring。
 *    `ui/` 的 registry 原文不在這條：那裡的 ring 由 `theme.css` 統一處理。
 * 9. **對話泡泡用 `ChatBubble`**（#1280）：同一個字串裡有 `rounded-3xl`＋`px-4`＋`py-2.5`，就是又手寫了一個泡泡。
 * 10. **程式碼小框用 `MonoBlock`**（#1280）：同一個字串裡有 `bg-chip`＋`rounded-lg`＋`p-2`＋`font-mono`，就是又手寫了一塊。
 * 11. **`ui/` 以外不寫原生 `<textarea`**（#1280）：用 `ui/textarea` 的 `Textarea`（邊框、焦點、手機字級都在那裡）。
 *     輸入框裡的是 `InputGroupTextarea`，也在 `ui/`。這條掃 JSX，不是字串字面值。
 * 12. **時長走 `motion.css` 的 token**（#1280）：不寫 `duration-200`、`animation-duration-350` 這種數字，寫
 *     `duration-(--duration-fast)`。這條連 `ui/` 一起管：registry 原文寫死的時長已經換成 token。
 * 13. **不用細字重**（#1307；`COMPONENTS.md`「次要靠顏色不靠字重」）：`font-thin`／`font-extralight`／`font-light` 擋下。
 *     次要的字靠 `text-muted-foreground`，不靠把字變細——細字在中文與小字級下先糊掉。今天 0 次，是絆索。連 `ui/` 一起管。
 *
 * **例外只能列在 {@link ALLOWED}**，每一條寫明理由；列了卻再也沒有命中的條目會報錯，所以例外只會變少、不會悄悄留著。
 * 沒量的：間距與寬高的任意值（`max-h-[300px]`、`top-[50%]` 都是版面值，不是系統值）、`styles/*.css`（那裡就是 token 層）。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** 拿掉區塊註解與整行的 `//` 註解（字串裡的 `//`，例如網址，不在行首，不會被拿掉）。 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

/** 去掉 variant 前綴（`dark:`、`hover:`、`[&_svg]:`…）後的 utility 本體。 */
function utility(token: string): string {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '[' || token[i] === '(') depth++;
    else if (token[i] === ']' || token[i] === ')') depth--;
    else if (token[i] === ':' && depth === 0) last = i;
  }
  return token.slice(last + 1).replace(/^!/, '');
}

const COLOR_PROPS =
  'bg|text|border|ring|ring-offset|fill|stroke|from|via|to|outline|divide|decoration|accent|caret|placeholder|shadow|inset-ring';
const PALETTE = [
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
].join('|');
const RAW_PALETTE = new RegExp(
  `^(?:${COLOR_PROPS})-(?:(?:${PALETTE})-\\d{2,3}|white|black)(?:/\\d+)?$`,
);
const RAW_TEXT_SIZE = /^text-(?:xs|sm|base|lg|xl|[2-9]xl|\[\d*\.?\d+(?:px|rem|em)\])$/;
const RAW_RADIUS = /^rounded(?:-[a-z]{1,2})?-\[\s*\d/;
const HEX_WHOLE = /^#[0-9a-fA-F]{3,8}$/;
const HEX_IN_CLASS = /-\[#[0-9a-fA-F]{3,8}\]/;
const COLOR_FUNCTION = /\b(?:oklch|oklab|rgba?|hsla?|hwb|lab|lch|color-mix)\(/;

type Rule =
  | '色板'
  | '字級'
  | '圓角'
  | '色碼'
  | '表面'
  | '箭頭'
  | '可展開列'
  | '焦點'
  | '泡泡'
  | '程式碼小框'
  | '輸入框'
  | '時長'
  | '字重';

const ROTATE = /^-?rotate-\d+$/;
const ROTATE_ON_OPEN = /state=open\]?\]?(?:>[^:]*)?:-?rotate-\d+$/;
const RAW_DURATION = /^(?:animation-)?duration-\d/;
const THIN_WEIGHT = /^font-(?:thin|extralight|light)$/;

function rulesBroken(text: string): { rule: Rule; what: string }[] {
  const found: { rule: Rule; what: string }[] = [];
  const utilities = new Set(text.split(/\s+/).map(utility));
  if (utilities.has('bg-stage') && utilities.has('shadow-stage')) {
    found.push({ rule: '表面', what: 'bg-stage shadow-stage' });
  }
  if (
    utilities.has('bg-card') &&
    utilities.has('shadow-material') &&
    utilities.has('rounded-3xl')
  ) {
    found.push({ rule: '表面', what: 'bg-card shadow-material rounded-3xl' });
  }
  if (utilities.has('bg-card') && utilities.has('border') && utilities.has('rounded-3xl')) {
    found.push({ rule: '表面', what: 'bg-card border rounded-3xl' });
  }
  const tokens = new Set(text.split(/\s+/));
  if (utilities.has('transition-transform') && [...utilities].some((u) => ROTATE.test(u))) {
    found.push({ rule: '箭頭', what: 'transition-transform rotate-*' });
  }
  if (
    tokens.has('hover:bg-chip-hover') &&
    tokens.has('active:bg-chip-pressed') &&
    utilities.has('w-full') &&
    utilities.has('text-left')
  ) {
    found.push({
      rule: '可展開列',
      what: 'hover:bg-chip-hover active:bg-chip-pressed w-full text-left',
    });
  }
  if (utilities.has('rounded-3xl') && utilities.has('px-4') && utilities.has('py-2.5')) {
    found.push({ rule: '泡泡', what: 'rounded-3xl px-4 py-2.5' });
  }
  if (
    utilities.has('bg-chip') &&
    utilities.has('rounded-lg') &&
    utilities.has('p-2') &&
    utilities.has('font-mono')
  ) {
    found.push({ rule: '程式碼小框', what: 'bg-chip rounded-lg p-2 font-mono' });
  }
  for (const token of text.split(/\s+/)) {
    const u = utility(token);
    if (RAW_DURATION.test(u)) found.push({ rule: '時長', what: u });
    if (THIN_WEIGHT.test(u)) found.push({ rule: '字重', what: u });
    if (ROTATE_ON_OPEN.test(token)) found.push({ rule: '箭頭', what: token });
    if (/(?:^|:)focus-visible:/.test(token) && /^ring(?:-|$)/.test(u)) {
      found.push({ rule: '焦點', what: token });
    }
    if (RAW_PALETTE.test(u)) found.push({ rule: '色板', what: u });
    else if (RAW_TEXT_SIZE.test(u)) found.push({ rule: '字級', what: u });
    else if (RAW_RADIUS.test(u)) found.push({ rule: '圓角', what: u });
    else if (HEX_IN_CLASS.test(u)) found.push({ rule: '色碼', what: token });
  }
  // 整個字串就是一個色碼；字串裡夾著的 `#607` 多半是議題編號，不算。
  if (HEX_WHOLE.test(text.trim())) found.push({ rule: '色碼', what: text.trim() });
  if (COLOR_FUNCTION.test(text) && !/var\(/.test(text)) {
    found.push({ rule: '色碼', what: text.match(COLOR_FUNCTION)![0] + '…)' });
  }
  return found;
}

interface Allowed {
  readonly file: string;
  readonly what: string;
  readonly why: string;
}

/**
 * 已知的例外。**只能變少**：自己的元件要換掉，registry 原文的例外要等它們各自被改掉或確認要留。
 */
const ALLOWED: readonly Allowed[] = [
  // 自己的元件。
  {
    file: 'components/chevron.tsx',
    what: 'group-data-[state=open]:rotate-180',
    why: '`Chevron` 本身：全站唯一該寫展開箭頭旋轉的地方',
  },
  {
    file: 'components/row-trigger.tsx',
    what: 'hover:bg-chip-hover active:bg-chip-pressed w-full text-left',
    why: '`RowTrigger` 本身：全站唯一該寫可展開列配方的地方',
  },
  {
    file: 'components/chat-bubble.tsx',
    what: 'rounded-3xl px-4 py-2.5',
    why: '`ChatBubble` 本身：全站唯一該寫對話泡泡配方的地方',
  },
  {
    file: 'components/mono-block.tsx',
    what: 'bg-chip rounded-lg p-2 font-mono',
    why: '`MonoBlock` 本身：全站唯一該寫程式碼小框配方的地方',
  },
  {
    file: 'components/surface.tsx',
    what: 'bg-stage shadow-stage',
    why: '`Surface` 的 stage 配方本身：全站唯一該寫這串的地方',
  },
  {
    file: 'components/surface.tsx',
    what: 'bg-card shadow-material rounded-3xl',
    why: '`Surface` 的 raised 配方本身：全站唯一該寫這串的地方',
  },
  {
    file: 'components/surface.tsx',
    what: 'bg-card border rounded-3xl',
    why: '`Surface` 的 docked 配方本身：全站唯一該寫這串的地方',
  },
  {
    file: 'components/empty-hero.tsx',
    what: 'text-2xl',
    why: '空狀態的標題；規格 §5 的字級階只有內文與小字、沒有標題階。要不要加一階由第 3 刀的規則手冊定，定之前不再新增',
  },
  {
    file: 'components/session-reference.tsx',
    what: 'text-[0.9em]',
    why: '行內引用比周圍字小一點，要跟著周圍的字級走，所以用相對的 em，不是絕對值',
  },
  // `ui/` 的 registry 原文：裝進來就是我們的原始碼，沒有改的就照舊；之後要改或確認要留，逐條處理。
  {
    file: 'components/ui/badge.tsx',
    what: 'text-white',
    why: 'destructive 底上的白字；語意 token 沒有 `--destructive-foreground`',
  },
  {
    file: 'components/ui/button.tsx',
    what: 'text-white',
    why: '同 badge：destructive 底上的白字',
  },
  {
    file: 'components/ui/dialog.tsx',
    what: 'bg-black/50',
    why: '遮罩的黑色半透明；沒有對應的語意 token',
  },
  {
    file: 'components/ui/sheet.tsx',
    what: 'bg-black/50',
    why: '遮罩的黑色半透明；沒有對應的語意 token',
  },
  {
    file: 'components/ui/alert-dialog.tsx',
    what: 'bg-black/50',
    why: '遮罩的黑色半透明；沒有對應的語意 token（與 dialog、sheet 同一條，#437 手抄 alert-dialog 時帶進來）',
  },
  {
    file: 'components/ui/dialog.tsx',
    what: 'text-lg',
    why: 'registry 的標題尺寸；規格沒有標題階（同 empty-hero）',
  },
  {
    file: 'components/ui/input.tsx',
    what: 'text-base',
    why: '手機上維持 16px 免得 iOS 聚焦時放大頁面，`md:` 以上換成 `text-body`',
  },
  {
    file: 'components/ui/textarea.tsx',
    what: 'text-base',
    why: '同 input：手機上 16px，`md:` 以上換成 `text-body`',
  },
  {
    file: 'components/ui/questionnaire.tsx',
    what: 'text-base',
    why: '題目標題與輸入框；輸入框同 input 的手機 16px 理由，標題同 dialog 的標題尺寸',
  },
  {
    file: 'components/ui/questionnaire.tsx',
    what: 'rounded-[4px]',
    why: '選項的小方塊勾選框，registry 原文',
  },
  {
    file: 'components/ui/questionnaire.tsx',
    what: 'text-[0.625rem]',
    why: '快捷鍵小標籤（10px），比 `text-micro`（11px）還小，registry 原文',
  },
  {
    file: 'components/ui/tooltip.tsx',
    what: 'rounded-[2px]',
    why: '提示框的小箭頭，registry 原文',
  },
];

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: Rule;
  readonly what: string;
}

function scan(files: string[]): Violation[] {
  const found: Violation[] = [];
  for (const file of files) {
    const inRegistry = relative(SRC, file).startsWith('components/ui/');
    const source = withoutComments(readFileSync(file, 'utf8'));
    if (!inRegistry) {
      for (const match of source.matchAll(/<textarea\b/g)) {
        const line = source.slice(0, match.index).split('\n').length;
        found.push({ file: relative(SRC, file), line, rule: '輸入框', what: '<textarea' });
      }
    }
    for (const match of source.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      const broken = rulesBroken(match[2] ?? '');
      if (broken.length === 0) continue;
      const line = source.slice(0, match.index).split('\n').length;
      for (const { rule, what } of broken) {
        if (rule === '焦點' && inRegistry) continue;
        found.push({ file: relative(SRC, file), line, rule, what });
      }
    }
  }
  return found;
}

const files = sourceFiles(SRC);
const all = scan(files);
const isAllowed = (v: Violation) => ALLOWED.some((a) => a.file === v.file && a.what === v.what);

describe('元件只能用系統裡的值', () => {
  test('沒有越過色板、字級、圓角階梯或硬寫顏色（例外見 ALLOWED）', () => {
    const open = all.filter((v) => !isAllowed(v));
    expect(open.map((v) => `${v.file}:${v.line}：${v.rule} ${v.what}`)).toEqual([]);
  });

  test('例外都還有命中，沒有留著過期的條目', () => {
    const stale = ALLOWED.filter((a) => !all.some((v) => v.file === a.file && v.what === a.what));
    expect(stale.map((a) => `${a.file} ${a.what}`)).toEqual([]);
  });

  test('每條例外都寫了理由', () => {
    expect(ALLOWED.filter((a) => a.why.trim() === '')).toEqual([]);
  });

  test('量具有掃到東西（不是空過）', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('components/ui/button.tsx'))).toBe(true);
  });
});

describe('判準', () => {
  const rules = (text: string) => rulesBroken(text).map((b) => `${b.rule}:${b.what}`);

  test('`rounded-row` 有定義，且是卡片圓角 3xl 減內距 p-1（4）：讓列與卡片同心', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    const px = (name: string) => Number(new RegExp(`--radius-${name}:\\s*(\\d+)px`).exec(css)?.[1]);
    expect(px('3xl')).toBe(24);
    expect(px('row')).toBe(px('3xl') - 4);
    expect(rules('rounded-row rounded-3xl')).toEqual([]);
  });

  test('原生色板與 white／black，連同 variant 前綴與透明度', () => {
    expect(rules('text-red-500')).toEqual(['色板:text-red-500']);
    expect(rules('dark:hover:bg-blue-600/40')).toEqual(['色板:bg-blue-600/40']);
    expect(rules('bg-white')).toEqual(['色板:bg-white']);
    expect(rules('[&_svg]:fill-black/50')).toEqual(['色板:fill-black/50']);
    expect(rules('ring-offset-zinc-200')).toEqual(['色板:ring-offset-zinc-200']);
  });

  test('語意 token 與只是名字像的不算', () => {
    expect(rules('bg-card text-destructive text-muted-foreground bg-chip-hover')).toEqual([]);
    expect(rules('text-primary-foreground border-border ring-ring/50 bg-brand/15')).toEqual([]);
    expect(rules('bg-background text-foreground bg-stage shadow-material')).toEqual([]);
  });

  test('字級：預設階與任意值都擋，規格的四階與顏色的 text-* 不擋', () => {
    expect(rules('text-xs')).toEqual(['字級:text-xs']);
    expect(rules('md:text-sm')).toEqual(['字級:text-sm']);
    expect(rules('text-base text-lg')).toEqual(['字級:text-base', '字級:text-lg']);
    expect(rules('text-2xl')).toEqual(['字級:text-2xl']);
    expect(rules('text-[0.625rem]')).toEqual(['字級:text-[0.625rem]']);
    expect(rules('text-[11px]')).toEqual(['字級:text-[11px]']);
    expect(rules('text-ui text-body text-tip text-micro')).toEqual([]);
    expect(rules('text-center text-left text-pretty text-balance text-foreground')).toEqual([]);
    expect(rules('text-[color:var(--x)] text-[length:var(--y)]')).toEqual([]);
  });

  test('圓角：數字任意值擋，階梯、full、calc 不擋', () => {
    expect(rules('rounded-[20px]')).toEqual(['圓角:rounded-[20px]']);
    expect(rules('rounded-t-[4px]')).toEqual(['圓角:rounded-t-[4px]']);
    expect(rules('rounded-tl-[2px]')).toEqual(['圓角:rounded-tl-[2px]']);
    expect(rules('rounded-lg rounded-3xl rounded-full rounded-none rounded-xs')).toEqual([]);
    expect(rules('rounded-[calc(var(--radius)-2px)]')).toEqual([]);
  });

  test('色碼：十六進位與沒有 var 的色彩函式擋，從 token 推出來的不擋', () => {
    expect(rules('#fff')).toEqual(['色碼:#fff']);
    expect(rules('#cc0000')).toEqual(['色碼:#cc0000']);
    expect(rules('bg-[#ff00aa]')).toEqual(['色碼:bg-[#ff00aa]']);
    expect(rules('rgb(0 0 0 / 0.5)')).toEqual(['色碼:rgb(…)']);
    expect(rules('oklch(0.5 0.1 200)')).toEqual(['色碼:oklch(…)']);
    expect(rules('var(--destructive)')).toEqual([]);
    expect(rules('bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]')).toEqual([]);
    expect(rules('bg-[oklch(from_var(--primary)_0.93_calc(c*0.4)_h)]')).toEqual([]);
    expect(rules('第 #607 號、#1033 的說明')).toEqual([]);
  });

  test('表面：手寫 stage 或 raised 的整組配方擋，只用到一部分的不擋', () => {
    expect(rules('bg-stage shadow-stage rounded-xl p-3')).toEqual(['表面:bg-stage shadow-stage']);
    expect(rules('hover:bg-stage dark:shadow-stage')).toEqual(['表面:bg-stage shadow-stage']);
    expect(rules('bg-card shadow-material rounded-3xl p-1')).toEqual([
      '表面:bg-card shadow-material rounded-3xl',
    ]);
    expect(rules('bg-stage sticky bottom-0 pb-4')).toEqual([]);
    expect(rules('bg-card shadow-material rounded-lg')).toEqual([]);
    expect(rules('bg-card border rounded-3xl p-1')).toEqual(['表面:bg-card border rounded-3xl']);
    expect(rules('bg-card border rounded-lg')).toEqual([]);
  });

  test('註解裡寫到類別名不算', () => {
    expect(withoutComments("// 以前是 'text-xs'\nconst a = 1;").includes('text-xs')).toBe(false);
    expect(withoutComments("/* 'text-sm' */ const b = 'text-tip';").includes('text-sm')).toBe(
      false,
    );
    expect(withoutComments("const c = 'https://x.test/a';").includes('https://x.test/a')).toBe(
      true,
    );
  });

  test('展開箭頭：手寫的旋轉轉場與跟著 data-state 轉的都擋；不轉場、不跟展開走的旋轉不擋', () => {
    expect(
      rules(
        'size-4 transition-transform duration-(--duration-fast) group-data-[state=open]:rotate-180',
      ),
    ).toEqual(['箭頭:transition-transform rotate-*', '箭頭:group-data-[state=open]:rotate-180']);
    expect(rules('[&[data-state=open]>svg]:rotate-90')).toEqual([
      '箭頭:[&[data-state=open]>svg]:rotate-90',
    ]);
    expect(rules('transition-transform rotate-180')).toEqual([
      '箭頭:transition-transform rotate-*',
    ]);
    expect(rules('group-data-[side=right]:rotate-180')).toEqual([]);
    expect(rules('transition-transform scale-95')).toEqual([]);
  });

  test('可展開列：四樣湊齊才算，按鈕的 hover 底色不算', () => {
    expect(
      rules('group hover:bg-chip-hover active:bg-chip-pressed flex w-full rounded-xl text-left'),
    ).toEqual(['可展開列:hover:bg-chip-hover active:bg-chip-pressed w-full text-left']);
    expect(rules('hover:bg-chip-hover active:bg-chip-pressed size-11 rounded-full')).toEqual([]);
    expect(rules('hover:bg-chip-hover active:bg-chip-pressed rounded-lg text-left')).toEqual([]);
  });

  test('焦點：focus-visible 下的 ring 都擋，outline 與非焦點的 ring 不擋', () => {
    expect(rules('outline-none focus-visible:ring-2')).toEqual(['焦點:focus-visible:ring-2']);
    expect(rules('focus-visible:ring-ring/50 focus-visible:ring-[3px]')).toEqual([
      '焦點:focus-visible:ring-ring/50',
      '焦點:focus-visible:ring-[3px]',
    ]);
    expect(rules('group-focus-visible:ring-2')).toEqual([]);
    expect(rules('focus-visible:-outline-offset-2 ring-ring ring-2')).toEqual([]);
  });

  test('泡泡：三樣湊齊才算，只有圓角或內距的不算', () => {
    expect(rules('bg-chip text-body rounded-3xl px-4 py-2.5 whitespace-pre-wrap')).toEqual([
      '泡泡:rounded-3xl px-4 py-2.5',
    ]);
    expect(rules('rounded-3xl px-4 py-2')).toEqual([]);
    expect(rules('rounded-xl px-4 py-2.5')).toEqual([]);
  });

  test('程式碼小框：四樣湊齊才算，chip 底的標籤與別的等寬字不算', () => {
    expect(
      rules('bg-chip max-h-32 min-w-0 overflow-auto rounded-lg p-2 font-mono text-tip'),
    ).toEqual(['程式碼小框:bg-chip rounded-lg p-2 font-mono']);
    expect(rules('bg-chip rounded-full px-3 py-1 text-tip')).toEqual([]);
    expect(rules('max-h-[150px] overflow-auto px-3 pt-1 pb-2 font-mono text-tip')).toEqual([]);
  });

  test('時長：數字的 duration 與 animation-duration 都擋，連同 variant 前綴；token 與 delay 不擋', () => {
    expect(rules('transition-colors duration-200')).toEqual(['時長:duration-200']);
    expect(rules('data-[state=open]:animation-duration-350')).toEqual([
      '時長:animation-duration-350',
    ]);
    expect(rules('duration-(--duration-fast) animation-duration-(--duration-overlay)')).toEqual([]);
    expect(rules('delay-50 data-[state=closed]:delay-0')).toEqual([]);
  });

  test('字重：thin、extralight、light 擋，連同 variant 前綴；normal 以上與字型家族不擋', () => {
    expect(rules('font-light')).toEqual(['字重:font-light']);
    expect(rules('md:font-thin')).toEqual(['字重:font-thin']);
    expect(rules('dark:hover:font-extralight')).toEqual(['字重:font-extralight']);
    expect(rules('font-normal font-medium font-semibold font-bold font-mono font-sans')).toEqual(
      [],
    );
    expect(rules('font-lightish')).toEqual([]);
  });

  test('輸入框：ui/ 以外的原生 textarea 擋，ui/ 本身不擋', () => {
    expect(all.filter((v) => v.rule === '輸入框')).toEqual([]);
    expect(
      readFileSync(join(SRC, 'components/ui/textarea.tsx'), 'utf8').includes('<textarea'),
    ).toBe(true);
  });

  test('焦點那條不管 ui/ 的 registry 原文：那裡的 ring 由 theme.css 統一處理', () => {
    const registry = scan(files.filter((f) => relative(SRC, f).startsWith('components/ui/')));
    expect(registry.filter((v) => v.rule === '焦點')).toEqual([]);
    expect(
      readFileSync(join(SRC, 'components/ui/input.tsx'), 'utf8').includes('focus-visible:ring-'),
    ).toBe(true);
  });
});
