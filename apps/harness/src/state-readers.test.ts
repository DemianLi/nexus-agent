/**
 * **讀 LangGraph state 的地方只許白名單**（[#2348](https://github.com/DemianLi/nexus-agent/issues/2348)，
 * #2336 的 K0，設計 `.docs/agent-loop-off-langchain-design-2026-11-03.md` §四 W6）。
 *
 * #2336 把 agent loop 搬出 LangGraph 之後就沒有 state，模型看到的那一串從日誌推出來；今天讀 state 的每一處
 * 都要在 #2355、#2357、#2360 改讀推導或 `tool/call.arguments`。這條把清單釘成數得出來的：照下面三種寫法
 * 新增一個讀者就紅，改掉一個也紅（回來把白名單減掉）。
 *
 * 算讀者的三種寫法：
 *
 * - 呼叫 `.getState(...)` 方法（pump 讀整份 state）。
 * - 讀 `request.state`：`wrapModelCall`／`wrapToolCall` 收到的請求帶著 state。屬性存取（含 `(request as X).state`）、
 *   `request['state']` 與從 `request` 解構 `state` 都算。
 * - `beforeAgent`／`beforeModel`／`afterModel`／`afterAgent` 的第一個參數（state）有用到。物件寫法
 *   `{ hook }` 的 `hook` 與 `{ step }` 的 `step`（`@nexus/core` 的 `createHookStepMiddleware`）也算；沒有參數不算，參數名以 `_` 開頭的不看本體、一律不算。第一個參數是解構的、
 *   或掛鉤寫成別處的函式名（`beforeModel: fn`、`{ step: fn }`、簡寫 `{ step }`），這條看不到。
 *
 * 白名單按「檔案 › 頂層宣告 寫法」數次數，不記行號：`getState()` 與 `request.state` 每一處各數一次，掛鉤每顆
 * 數一次；同一個頂層宣告裡多一處就紅，無關的改動讓行號漂了不紅。參數不叫 `request` 的請求整個看不到；
 * `request.state` 轉手給別的函式之後的讀（例如交給 `resolveBackend` 之後）只數交出去的那一處。
 *
 * 用 TypeScript 的語法樹掃，不用逐行正則：註解裡寫到 `state.messages` 的說明文字不算，解構與元素存取正則會漏。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 第一個參數是 state 的 middleware 掛鉤。 */
const STATE_HOOKS = new Set(['beforeAgent', 'beforeModel', 'afterModel', 'afterAgent']);

interface Reader {
  readonly file: string;
  readonly line: number;
  /** {@link ownerOf} 認出的頂層宣告名字；認不出時是 `(模組頂層)`。 */
  readonly owner: string;
  readonly what: string;
}

/** 頂層敘述的名字：函式、類別，或第一個變數宣告。 */
function ownerOf(statement: ts.Statement): string {
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name !== undefined
  ) {
    return statement.name.text;
  }
  if (ts.isVariableStatement(statement)) {
    const [first] = statement.declarationList.declarations;
    if (first !== undefined && ts.isIdentifier(first.name)) return first.name.text;
  }
  return '(模組頂層)';
}

/** 屬性名或方法名的字面文字；計算出來的名字是 `undefined`。 */
function nameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/**
 * `node` 是 state 掛鉤時回傳掛鉤的函式：方法本身、屬性值的箭頭／function，或物件裡的 `hook`、`step`；
 * 屬性值是識別字或計算屬性名時不認。
 */
function hookFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  const fn = (value: ts.Node | undefined): ts.SignatureDeclaration | undefined =>
    value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
      ? value
      : undefined;
  if (ts.isMethodDeclaration(node) && STATE_HOOKS.has(nameText(node.name) ?? '')) return node;
  if (!ts.isPropertyAssignment(node) || !STATE_HOOKS.has(nameText(node.name) ?? '')) {
    return undefined;
  }
  const direct = fn(node.initializer);
  if (direct !== undefined) return direct;
  if (!ts.isObjectLiteralExpression(node.initializer)) return undefined;
  for (const property of node.initializer.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue;
    const key = nameText(property.name);
    if (key !== 'hook' && key !== 'step') continue;
    return ts.isPropertyAssignment(property) ? fn(property.initializer) : property;
  }
  return undefined;
}

/** 函式本體裡有沒有用到這個名字。 */
function usesName(fn: ts.SignatureDeclaration, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name && node.parent !== undefined) {
      const parent = node.parent;
      const isDeclaration = ts.isParameter(parent) && parent.name === node;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isDeclaration && !isPropertyName) found = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return found;
}

/** 剝掉括號、`as`、`!` 之後是不是名叫 `request` 的識別字。 */
function isRequest(node: ts.Expression): boolean {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  return ts.isIdentifier(inner) && inner.text === 'request';
}

/**
 * 找出一份原始碼裡讀 state 的位置。
 *
 * @param file - 顯示在結果裡的路徑；副檔名也決定照 TS 還是 TSX 解析。
 * @param text - 原始碼。
 * @returns 每一處讀一筆，照原始碼順序；掛鉤每顆一筆，不管本體裡讀幾處。判準見檔頭。
 */
export function findReaders(file: string, text: string): Reader[] {
  // 預篩：三種寫法各自要有其中一串字，都沒有的檔不必建語法樹。
  if (!/getState|state|beforeAgent|beforeModel|afterModel|afterAgent/u.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Reader[] = [];
  let owner = '(模組頂層)';
  const add = (node: ts.Node, what: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push({ file, line, owner, what });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'getState'
    ) {
      add(node, 'getState()');
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'state' &&
      isRequest(node.expression)
    ) {
      add(node, 'request.state');
    } else if (
      ts.isElementAccessExpression(node) &&
      isRequest(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'state'
    ) {
      add(node, 'request.state');
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      isRequest(node.initializer) &&
      node.name.elements.some(
        (element) => (element.propertyName ?? element.name).getText(source) === 'state',
      )
    ) {
      add(node, 'request.state');
    } else {
      const hook = hookFunction(node);
      const [state] = hook?.parameters ?? [];
      if (
        hook !== undefined &&
        state !== undefined &&
        ts.isIdentifier(state.name) &&
        !state.name.text.startsWith('_') &&
        usesName(hook, state.name.text)
      ) {
        add(state, '掛鉤的 state 參數');
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of source.statements) {
    owner = ownerOf(statement);
    visit(statement);
  }
  return found;
}

/** 遞迴列出產品程式碼的 `.ts`／`.tsx`：跳過 `node_modules`、`dist` 目錄與 `*.test.*`、`*.fixture.*` 檔。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/u.test(entry.name) && !/\.(test|fixture)\.tsx?$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('量具自檢：每一種寫法都抓得到，沒讀的不算', () => {
  const at = (text: string) => findReaders('x.ts', text).map((r) => `${r.owner} ${r.what}`);

  it.each([
    ['async function f(agent) { await agent.getState(config); }', 'f getState()'],
    ['const f = (request) => request.state;', 'f request.state'],
    ['const f = (request) => (request.state as X)?.messages;', 'f request.state'],
    ['const f = (request) => (request as X).state;', 'f request.state'],
    ['const f = (request) => request!.state;', 'f request.state'],
    ["const f = (request) => request['state'];", 'f request.state'],
    ['function f(request) { const { state } = request; }', 'f request.state'],
    ['function f(request) { const { state: s } = request; }', 'f request.state'],
    ['const m = { beforeAgent: async (state) => state.messages };', 'm 掛鉤的 state 參數'],
    ['const m = { beforeModel(state) { return f(state); } };', 'm 掛鉤的 state 參數'],
    ['const m = { afterModel: function (s) { return s; } };', 'm 掛鉤的 state 參數'],
    ['const m = { afterAgent: { hook: async (state) => state.x } };', 'm 掛鉤的 state 參數'],
    ['const m = { afterAgent: { step: async (state) => state.x } };', 'm 掛鉤的 state 參數'],
    [
      'createMiddleware({ beforeAgent: (state) => state.messages });',
      '(模組頂層) 掛鉤的 state 參數',
    ],
  ])('%s', (text, what) => {
    expect(at(text)).toEqual([what]);
  });

  it('沒讀 state 的不算', () => {
    expect(at('const m = { beforeModel: async (_state, runtime) => runtime };')).toEqual([]);
    expect(at('const m = { afterAgent: { hook: async (_state) => 1 } };')).toEqual([]);
    expect(at('const m = { afterAgent: { step: async (_state) => 1 } };')).toEqual([]);
    expect(at('const m = { beforeAgent: async () => 1 };')).toEqual([]);
    expect(at('const m = { beforeAgent: async (state, runtime) => runtime.state };')).toEqual([]);
    expect(at('const f = (request) => request.messages;')).toEqual([]);
    expect(at('const f = (fiber) => fiber.state;')).toEqual([]);
    expect(at('// request.state 與 state.messages 只在註解裡\nconst x = 1;')).toEqual([]);
  });

  it('同一個頂層宣告裡讀兩次就數兩次', () => {
    expect(at('function f(request) { g(request.state); h(request.state); }')).toEqual([
      'f request.state',
      'f request.state',
    ]);
  });
});

/**
 * 照檔頭三種寫法數到的每一處，鍵是「檔案 › 頂層宣告 寫法」。每改掉一處就減這裡的次數。
 * TODO(#2336): 清空。
 */
const ALLOWED: Readonly<Record<string, number>> = {
  'apps/harness/src/pre-step-middleware.ts › createPreStepMiddleware 掛鉤的 state 參數': 1,
  'apps/harness/src/thread-pump.ts › ThreadPump getState()': 2,
  // 照基座把 state 交給 `resolveBackend`，給工廠 backend 用；自己不讀（#2415 W3）。兩個 loop 都經過這一格。TODO(#2363)：隨相容層拿掉。
  'packages/nexus-core/src/filesystem-tool-admission.ts › filesystemToolListStep request.state': 1,
  // native loop 的相容層照 `createAgent` 把 state 交給 `wrapToolCall` 的那一處，自己不讀。TODO(#2363)：隨相容層拿掉。
  // 轉交基座的記憶中介層；基座在這裡拿 state 讀的是 `memoryContents`，不讀訊息（設計 §四 W9）。渲染讀宿主的那一份，不讀 state。
  'packages/nexus-core/src/memory-middleware.ts › createMemoryMiddleware 掛鉤的 state 參數': 1,
  'packages/nexus-core/src/native-loop/tool-node.ts › runTool request.state': 1,
  'packages/nexus-core/src/patch-tool-calls.ts › createPatchToolCallsMiddleware 掛鉤的 state 參數': 1,
  'packages/nexus-core/src/repeat-reminder.ts › createRepeatReminder 掛鉤的 state 參數': 1,
  // 轉交基座的 skills 中介層；基座在這裡拿 state 讀的是 `skillsMetadata`，不讀訊息（設計 §四 W9）。
  'packages/nexus-core/src/skills-middleware.ts › createSkillsMiddlewareQuietWhenEmpty 掛鉤的 state 參數': 1,
  // 同 `filesystemToolListStep`：照基座把 state 交給 `resolveBackend` 寫歷史檔（生摘要、溢出重摘共用這一處），給工廠 backend 用；自己不讀（#2416）。
  'packages/nexus-core/src/summarizer-engine.ts › createSummarizerEngine request.state': 1,
  // 環繞工具呼叫的一步拿到的 `state`，自己不讀；只有解不開參數與核准閘門兩步轉給 `toolCallOwner`（#2355）。
  'packages/nexus-core/src/tool-call-step.ts › toolCallSiteOf request.state': 1,
  // 屏障、`returnDirect` 的收尾、解不開參數的原字串三處共用；`history-source=log` 的 root 讀日誌，native loop 讀它交下來的那則，
  // 只有 `langgraph`（含子代理子圖，#2359）讀這裡（#2355）。TODO(#2363)：隨 `langgraph` 拿掉。
  'packages/nexus-core/src/tool-call-owner.ts › toolCallOwner request.state': 1,
  // 同 `filesystemToolListStep`：照基座交給 `resolveBackend`，結果是 `ToolMessage` 與 `Command` 的兩支各一處。
  'packages/nexus-core/src/tool-result-eviction.ts › toolResultEvictionWrap request.state': 2,
};

const SOURCE_ROOTS = ['apps/harness/src', 'packages'] as const;

describe('全樹掃描', () => {
  it('讀 state 的地方與白名單一致', () => {
    const counts = new Map<string, number>();
    const where = new Map<string, string[]>();
    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const path = relative(REPO_ROOT, file);
        for (const r of findReaders(path, readFileSync(file, 'utf8'))) {
          const key = `${r.file} › ${r.owner} ${r.what}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          where.set(key, [...(where.get(key) ?? []), `:${String(r.line)}`]);
        }
      }
    }
    // 不一致時把行號一起印出來，方便對到是哪一處多了或少了。
    expect(Object.fromEntries(counts), JSON.stringify(Object.fromEntries(where), null, 2)).toEqual(
      ALLOWED,
    );
  });
});
