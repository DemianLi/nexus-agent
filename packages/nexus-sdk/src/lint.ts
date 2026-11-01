/**
 * 插件規範的 lint 設定（`@nexus/sdk/lint`，[#1420](https://github.com/DemianLi/nexus-agent/issues/1420)）。
 *
 * 決議 §3-4 第 12 條四層強制的第二層：禁用 API、`internal/*`、`ctx.root`、`ctx.registry`。**遷出的插件**（模組有
 * `manifest` 匯出）在自己的 `eslint.config.js` 套用它，由 `apps/harness` 的 gate 保證每顆都套、每顆都有一條跑
 * `checkConformance` 的測試（`migrated-plugin-gate.ts`）。
 *
 * ## 形狀
 *
 * 一份 ESLint flat config 陣列（{@link pluginLintConfig}），**只用 ESLint 內建的 `no-restricted-*`**，純語法：
 * SDK 不多任何相依，也不帶 parser——parser（`typescript-eslint`）由消費者自己的 base 設定提供，套用時排在它後面：
 *
 * ```js
 * import base from '../../eslint.config.js';
 * import { pluginLintConfig } from '@nexus/sdk/lint';
 *
 * export default [...base, ...pluginLintConfig];
 * ```
 *
 * 範圍只到 `src/`，**不含測試檔**：測試可以用假計時器，也可以直接操作 fiber。
 *
 * ## 已知的洞（Q3 (a) 的代價）
 *
 * 純語法認不出別名：`const c = ctx; c.root`、把參數取別的名字、`const { root } = someOtherName`、把 `Context` 改名 import
 * 後的 `ctx[C.root]`、先把 `Symbol.for('cordis.root')` 存進變數再取、`const { [Context.root]: r } = ctx`，都抓不到；
 * 頂層的 `const state = { count: 0 }` 這種「物件本身可變」也不在清單裡。這些由審查與一致性套件的 `unload`
 * 那一格補（副作用沒走 `ctx.effect`，卸載後就有殘留，`unload` 會紅）。真的有人繞過，再升級成帶型別的規則。
 *
 * ## 例外
 *
 * 一律窄：`// eslint-disable-next-line <規則> -- <理由>`，不整檔關、不整條關。
 *
 * **這個檔不 import 任何東西**：它會被消費者的 `eslint.config.js` 用 Node 原生載入，只准用 erasable 的 TS 語法。
 *
 * @module
 */

/** 一條語法限制：ESLint `no-restricted-syntax` 的一筆。 */
export interface PluginLintSyntaxRestriction {
  /** 穩定的名字，測試與文件用它指到這一條。 */
  readonly id: string;
  readonly selector: string;
  readonly message: string;
}

/**
 * 正則放進 esquery 選擇器時不能含字面的 `/`（它的正則文法以 `/` 收尾），所以斜線寫成 `\x2F`。
 */
const INTERNAL_PREFIX = '^internal\\x2F';

const COLLECTION_NEW = 'NewExpression[callee.name=/^(Map|Set|WeakMap|WeakSet)$/]';

/** 取一個 `ctx.<member>` 在各種寫法下的選擇器：點取、方括號取、`this.ctx.<member>`、從 `ctx` 解構。 */
function ctxMember(member: string): string {
  return [
    `MemberExpression[object.name='ctx'][property.name='${member}']`,
    `MemberExpression[object.name='ctx'][computed=true][property.value='${member}']`,
    `MemberExpression[object.type='MemberExpression'][object.object.type='ThisExpression'][object.property.name='ctx'][property.name='${member}']`,
    `VariableDeclarator[init.name='ctx'] > ObjectPattern > Property[key.name='${member}']`,
  ].join(', ');
}

/**
 * 樹根的另一種寫法：上游 #207（rc.12）把 `ctx.root` 搬到 `ctx[Context.root]`，鍵是 `Symbol.for('cordis.root')`。
 * 兩種寫法都擋：`ctx[Context.root]`／`ctx[Symbol.for('cordis.root')]`，以及 `this.ctx[…]`。`Context` 被改名 import 時抓不到，
 * 同上面「已知的洞」。
 */
function ctxRootSymbol(): string {
  const keys = [
    `[property.type='MemberExpression'][property.object.name='Context'][property.property.name='root']`,
    `[property.type='CallExpression'][property.callee.object.name='Symbol'][property.callee.property.name='for'][property.arguments.0.value='cordis.root']`,
  ];
  const owners = [
    `[object.name='ctx']`,
    `[object.type='MemberExpression'][object.object.type='ThisExpression'][object.property.name='ctx']`,
  ];
  return owners
    .flatMap((owner) => keys.map((key) => `MemberExpression${owner}[computed=true]${key}`))
    .join(', ');
}

/** 頂層宣告的位置：`Program > …` 與 `Program > ExportNamedDeclaration > …`。 */
function topLevel(rest: string): string {
  return [`Program > ${rest}`, `Program > ExportNamedDeclaration > ${rest}`].join(', ');
}

/**
 * 語法限制。每一條的訊息都指名「不准什麼」與「改用什麼」。
 *
 * 順序無意義；`id` 是給測試與文件指到某一條用的，不進 ESLint 的訊息。
 */
export const pluginLintSyntaxRestrictions: readonly PluginLintSyntaxRestriction[] = [
  {
    id: 'ctx-root',
    selector: [ctxMember('root'), ctxRootSymbol()].join(', '),
    message:
      '插件不准碰 `ctx.root`（含 `ctx[Context.root]`）：它拿到整棵樹，繞過 `inject` 宣告與卸載追蹤。要別的服務就用 `inject` 宣告，在 `apply` 裡 `ctx.get(token)` 取。',
  },
  {
    id: 'ctx-registry',
    selector: ctxMember('registry'),
    message:
      '插件不准碰 `ctx.registry`：它是 Loader 自己的內部表，不是插件的介面。要登記東西就經服務的 `register()`（內部包 `ctx.effect`），要用服務就 `inject` 宣告後 `ctx.get(token)` 取。',
  },
  {
    id: 'internal-name',
    selector: [
      `Literal[value=/${INTERNAL_PREFIX}/]`,
      `TemplateLiteral > TemplateElement:first-child[value.raw=/${INTERNAL_PREFIX}/]`,
    ].join(', '),
    message:
      '插件不准用 `internal/` 開頭的服務名或事件名：那是 Cordis 內部的，版本一換就變。要訂事件用公開的（`ctx.on`），要登記東西用 `ctx.effect`。',
  },
  {
    id: 'top-level-let-var',
    selector: [
      topLevel("VariableDeclaration[kind='let']"),
      topLevel("VariableDeclaration[kind='var']"),
    ].join(', '),
    message:
      '插件不准有模組層級的 `let`／`var`：卸載後它還留著，下一次掛載會讀到上一次的值。狀態放進 `apply` 的閉包，生命週期交給 `ctx.effect`。',
  },
  {
    id: 'top-level-collection',
    selector: [
      topLevel(`VariableDeclaration > VariableDeclarator > ${COLLECTION_NEW}`),
      topLevel(
        `VariableDeclaration > VariableDeclarator > :matches(TSAsExpression, TSSatisfiesExpression, TSNonNullExpression) > ${COLLECTION_NEW}`,
      ),
    ].join(', '),
    message:
      '插件不准在模組層級 `new Map`／`Set`／`WeakMap`／`WeakSet`：它跨掛載存活，卸載不會清。放進 `apply` 的閉包，要撤的交給 `ctx.effect`。',
  },
  {
    id: 'dynamic-import-nexus-core',
    selector: 'ImportExpression[source.value=/^@nexus\\x2Fcore(\\x2F|$)/]',
    message:
      '插件不准動態 import `@nexus/core`：外部插件只相依 `@nexus/sdk` 與服務定義套件（例如 `@nexus/tools`）。型別與 token 從那邊取。',
  },
];

/** 一條屬性限制：ESLint `no-restricted-properties` 的一筆。 */
export interface PluginLintPropertyRestriction {
  readonly id: string;
  readonly object: string;
  readonly property: string;
  readonly message: string;
}

const PROCESS_MESSAGE =
  '插件不准自己掛行程層級的監聽器：卸載時沒有人撤，掛幾次留幾個。今天宿主沒有提供行程事件的服務；必須用時，在 `ctx.effect` 裡掛、回傳撤除函式（`process.off`），並在該行寫窄例外 `// eslint-disable-next-line <被報的規則> -- <理由>`。';

const INTERVAL_MESSAGE =
  '插件不准直接用全域 `setInterval`：卸載後它還會一直跑。今天沒有不經全域的計時器服務（vendor 的 Cordis 沒有）；必須用時，在 `ctx.effect` 裡呼叫、回傳清除函式（`clearInterval`），並在該行寫窄例外 `// eslint-disable-next-line <被報的規則> -- <理由>`。';

/** 屬性限制。 */
export const pluginLintPropertyRestrictions: readonly PluginLintPropertyRestriction[] = [
  { id: 'process-on', object: 'process', property: 'on', message: PROCESS_MESSAGE },
  { id: 'process-once', object: 'process', property: 'once', message: PROCESS_MESSAGE },
  {
    id: 'process-addListener',
    object: 'process',
    property: 'addListener',
    message: PROCESS_MESSAGE,
  },
  {
    id: 'process-prependListener',
    object: 'process',
    property: 'prependListener',
    message: PROCESS_MESSAGE,
  },
  {
    id: 'globalThis-setInterval',
    object: 'globalThis',
    property: 'setInterval',
    message: INTERVAL_MESSAGE,
  },
  {
    id: 'global-setInterval',
    object: 'global',
    property: 'setInterval',
    message: INTERVAL_MESSAGE,
  },
];

/** 全域名稱限制：ESLint `no-restricted-globals` 的一筆。 */
export const pluginLintGlobalRestrictions = [
  { id: 'setInterval', name: 'setInterval', message: INTERVAL_MESSAGE },
] as const;

const CORE_MESSAGE =
  '插件不准 import `@nexus/core`：外部插件只相依 `@nexus/sdk` 與服務定義套件（例如 `@nexus/tools`），不相依整個 core。型別與 token 從那邊取。';

/**
 * import 限制：ESLint `no-restricted-imports` 的選項。
 *
 * `setInterval` 與行程監聽器各有一組具名 import 的出口（`import { setInterval } from 'node:timers'` 會讓
 * `no-restricted-globals` 看不到，因為名字已經被本地宣告蓋過）。
 */
export const pluginLintImportRestrictions = {
  patterns: [{ group: ['@nexus/core', '@nexus/core/*'], message: CORE_MESSAGE }],
  paths: [
    ...['node:timers', 'timers', 'node:timers/promises', 'timers/promises'].map((name) => ({
      name,
      importNames: ['setInterval'],
      message: INTERVAL_MESSAGE,
    })),
    ...['node:process', 'process'].map((name) => ({
      name,
      importNames: ['on', 'once', 'addListener', 'prependListener'],
      message: PROCESS_MESSAGE,
    })),
  ],
};

/**
 * 這份設定放進 ESLint 的規則。gate 對一顆插件的**解析後設定**逐條比對它，所以只准是這四個內建規則，值是
 * `['error', …options]`。
 */
export const pluginLintRules = {
  'no-restricted-syntax': [
    'error',
    ...pluginLintSyntaxRestrictions.map(({ selector, message }) => ({ selector, message })),
  ],
  'no-restricted-properties': [
    'error',
    ...pluginLintPropertyRestrictions.map(({ object, property, message }) => ({
      object,
      property,
      message,
    })),
  ],
  'no-restricted-globals': [
    'error',
    ...pluginLintGlobalRestrictions.map(({ name, message }) => ({ name, message })),
  ],
  'no-restricted-imports': ['error', pluginLintImportRestrictions],
} as const;

/** 管到哪些檔：插件 `src/` 底下，測試檔除外。 */
export const PLUGIN_LINT_FILES = ['src/**/*.{ts,tsx,mts,cts,js,mjs}'] as const;

/** 測試檔與規格檔不受管。 */
export const PLUGIN_LINT_IGNORES = ['**/*.test.*', '**/*.spec.*'] as const;

/**
 * 給 `eslint.config.js` 展開用的 flat config。
 *
 * 後面又寫一份 `no-restricted-syntax` 等於整份蓋掉它（flat config 的規則不合併）：gate 看的是解析後的設定，
 * 蓋掉的那一顆會紅。
 */
export const pluginLintConfig = [
  {
    name: '@nexus/sdk/lint',
    files: [...PLUGIN_LINT_FILES],
    ignores: [...PLUGIN_LINT_IGNORES],
    rules: pluginLintRules,
  },
];
