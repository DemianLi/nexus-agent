/**
 * `@nexus/system-prompt`：**系統提示詞**這個接縫的定義套件（決議 §3-4 第 16 條，dsh 的三角色紀律；
 * [#1477](https://github.com/DemianLi/nexus-agent/issues/1477) Q1 (a)、Q1-1 (a)，Part of #1385）。
 *
 * 對應 dsh 的 `systemPrompt` 服務（`packages/core/system-prompt/src/index.ts`，`86a40220`）：其他插件經 `section()` 登記一段
 * 文字、經 `variable()` 登記一個可以在文字裡用 `{{名字}}` 引用的變數，宿主 `assemble()` 之後渲染。第一個提供者與消費者都是
 * `system-prompt` 那一列自己（身分句、前綴、後綴三段）；`plan-mode`、`sandbox-policy`、`goal` 遷移時對它登記 `section`。
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件：token、介面、契約版本、`SECTION_ORDERS`、嚴格插值與前後段的組法 | 只有 `@nexus/sdk`，**不 import `@nexus/core`**，也不碰訊息型別 |
 * | 提供者 | `@nexus/plugin-system-prompt` 那一列：`apply` 裡 `new` 一個 `ContractService`（同 #1456 的 `feedback`） | 這個套件、`@nexus/sdk` |
 * | 消費者 | 宿主（`apps/harness`）：組 thread 時取一次快照，之後每次模型呼叫只代入變數、渲染成請求；以及日後要加段的插件 | 這個套件 |
 *
 * ## 快照是資料（決議 §3-2 第 6 條）
 *
 * dsh 的 `section()` 是 `layers.effect`，列一卸載就撤。宿主若每次模型呼叫都問活服務，serve 中合法地改一次這一列
 * （`next-thread`），舊列卸載、段被撤，**開著的 thread 下一次呼叫就靜靜少了身分與 persona**。所以宿主在組 thread 的臨界區裡
 * （無樹的路徑則在單獨掛載卸載之前）`assemble()` 一次，留下 {@link SystemPromptAssembly}——各段的**原文**（還沒代入變數）與
 * 已登記的變數**名字**——之後只拿這份資料渲染，不再碰服務。`assemble()` 因此是 async（同 dsh），而且不可以碰 `this.ctx`。
 *
 * **活的服務不折進 thread 的 `registry.services`**：相容層的插件拿到行程級的活服務就能呼叫 `section()`，段會跨 thread 越疊越多。
 *
 * ## 偏離登記（AGENTS.md 的偏離規則；dsh 以 `86a40220` 為準）
 *
 * | # | dsh 怎麼做 | 我們怎麼做 | 為什麼表達不出來 |
 * | --- | --- | --- | --- |
 * | 1 | 整份提示詞由 `assemble` 組 | 只組頭尾兩段，中間是基座與相容層 middleware 已經組好的那一份 | 基座（deepagents）自己組它的提示詞，它的段不經我們的服務 |
 * | 2 | 每個 agent 一層 scoped layer | 行程級一層，root 與子代理同一份 | 今天就是這樣（子代理也走那顆 middleware）；逐委派 persona 是 #328 的事 |
 * | 3 | `context()`、`tools()`、`suppressRuntimeContext()`、`system-prompt/assemble` waterfall | 第一刀沒有 | 沒有消費者；第一個需要的遷移卡再加 |
 * | 4 | 每一步 `assemble`，段的增減即時生效 | 組 thread 時 `assemble` 一次取快照，之後只代入變數 | 決議 §3-2 第 6 條：插件更新只給新對話；列卸載會撤段 |
 * | 5 | section `text` 可以是 `(context) => string`，`PromptSection` 另有 `complete`、`interpolate` | 只收字串，其餘兩個欄位登記時拋 | 快照要完整；沒有消費者 |
 * | 6 | `model`、`provider` 由 agent loop 登記，名字開放；`variable(name, provider)` 每次 `assemble` 求值 | `model`、`cwd` 由 `system-prompt` 那一列登記；`variable(name)` **只登記名字**，值由宿主每次模型呼叫交 | #1477 Q2 (a) 與 PM 更正 2：`model` 要跟著那一步實際用的模型走（#723），組 thread 時求值就定死了 |
 * | 7 | Config 五格（另有 `includeRuntimeContext`、`toolOrder`） | 三格 | 另兩格管執行期上下文與工具段，第一刀沒有 |
 * | 8 | 沒有 `cwd` 變數 | 有，而且出貨值（`cordis.yml` 的後綴）依賴它 | 我們的出貨文案引用了 `{{cwd}}`；要不要拿掉不在 #1477。見 `@nexus/plugin-system-prompt` 檔頭 |
 * | 9 | 渲染時才嚴格插值、才拋，訊息是英文 | **掛載當下**驗語法與名字（寫壞起不來，#720），渲染照 `interpolateStrict`，訊息是中文 | #1446 Q1 (a)：遷移卡不改行為，#720 由 demian 拍板 |
 * | 10 | section 的 order 任意 | 只收 ≤ `DEPLOYMENT_PERSONA_PREFIX` 或 ≥ `DEPLOYMENT_PERSONA_SUFFIX`，中間的登記時拋 | 中間段的渲染規則留給第一個用到的遷移卡（`plan-mode`／`sandbox-policy`） |
 *
 * **撤除條件**：第 1、4、6、9 列各有各的卡（中間段、逐步 `assemble`、渲染時才拋）；撤除時先重審這張表。
 *
 * **`model` 名字的歸屬**：今天由 `system-prompt` 那一列登記。日後 `@nexus/agent-loop` 若照 dsh 再登記同名 `model`，同一個服務內重名當場拋；
 * 到時候把 `model` 的登記搬去 agent loop 那一列、`system-prompt` 改成只讀，是一次機械的搬動（登記只有一行）。
 *
 * @module
 */

import { defineToken } from '@nexus/sdk';

/**
 * 契約版本（semver）。介面破壞性改動跳 major，消費者的 `inject` 範圍與宿主取服務時的範圍檢查擋下不相容的提供者。
 */
export const SYSTEM_PROMPT_CONTRACT_VERSION = '1.0.0';

/**
 * 段的排序值，照 dsh `SECTION_ORDERS`（`packages/core/system-prompt/src/index.ts:131-165`）。**只放這張用到的三格**：
 * 其餘的數值（`PLAN_POLICY: 500`、`TOOL_GOAL: 2400`…）等第一個登記它們的遷移卡再加。
 */
export const SECTION_ORDERS = {
  /** 最前面一句身分句。 */
  HARNESS_IDENTITY: -1000,
  /** 部署方的前綴：身分句之後、其餘一切之前。 */
  DEPLOYMENT_PERSONA_PREFIX: 0,
  /** 部署方的後綴：整份提示詞的最後一段。 */
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
} as const;

/**
 * 宿主掛的那一顆 middleware 的名字。排序斷言與錯誤訊息用得到；`@nexus/plugin-system-prompt` 照舊從自己的入口再匯出它。
 */
export const SYSTEM_PROMPT_MIDDLEWARE_NAME = 'nexusSystemPrompt';

/** 一段文字。 */
export interface PromptSection {
  /** 段的名字（dsh 的 `harness:identity` 這種），同一個服務內不可重名。 */
  readonly name: string;
  /** 排序值，見 {@link SECTION_ORDERS}。小的在前，同值照登記順序。 */
  readonly order: number;
  /** 文字原文，可以含 `{{變數}}`。只收字串（偏離第 5 列）。 */
  readonly text: string;
}

/**
 * `assemble()` 的結果：快照。**純資料**——各段（依 order 再依登記順序）與已登記的變數名字（依登記順序）。
 * 變數的值不在裡面（偏離第 6 列），宿主每次模型呼叫才代入。
 */
export interface SystemPromptAssembly {
  readonly sections: readonly PromptSection[];
  readonly variables: readonly string[];
}

/** 系統提示詞服務。 */
export interface SystemPrompt {
  /**
   * 登記一段。登記就是 effect：登記者那一列卸載時這一段自己撤掉。
   *
   * @throws 名字是空的或重名、order 不是有限數字、order 落在 `DEPLOYMENT_PERSONA_PREFIX` 與 `DEPLOYMENT_PERSONA_SUFFIX` 之間、
   *   `text` 不是字串、帶了 `complete` 或 `interpolate`（第一刀不支援，大聲拒絕，不靜靜丟掉）。
   */
  section(section: PromptSection): () => void;
  /**
   * 登記一個變數名，之後 `{{名字}}` 才算已知。登記就是 effect。值不在這裡給：宿主每次模型呼叫交。
   *
   * @throws 名字不合 `/^[a-z][a-z0-9_]*$/`、或同一個服務內已經登記過。
   */
  variable(name: string): () => void;
  /**
   * 取目前的快照。**async 而且不碰 `this.ctx`**：宿主在列還活著的當下呼叫一次，之後列卸載也不影響拿到的資料。
   */
  assemble(): Promise<SystemPromptAssembly>;
}

/** `systemPrompt` 服務的 token。 */
export const systemPromptToken = defineToken<SystemPrompt>(
  'systemPrompt',
  SYSTEM_PROMPT_CONTRACT_VERSION,
);

/** 變數的名字：寫在括號裡的樣子。 */
export const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/u;

/** 掃描位置上一組完整的 `{{…}}`（之後再驗名字）。 */
const GROUP_AT = /^\{\{([^{}]*)\}\}/u;

/** 前後綴插值壞掉時拋的錯。訊息指名是哪一格、哪個變數。 */
export class SystemPromptTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemPromptTemplateError';
  }
}

/**
 * 嚴格插值一段文字。照 dsh 的 `interpolate`（`packages/core/system-prompt/src/index.ts:319-360`）：
 *
 * - 完整的 `{{name}}` 才算引用，名字要合 `/^[a-z][a-z0-9_]*$/`，不合就拋。
 * - 後面還有 `}}` 卻不是完整一組（例如 `{{a b}}` 之外的殘缺形狀），算寫壞，拋；後面沒有 `}}` 的單獨 `{{` 是普通的字。
 * - 名字沒登記拋，登記了卻沒有值也拋。用 `Object.hasOwn`，不從原型鏈上解析。
 * - 代入進去的值不會再被掃一次。
 *
 * @param text - 前後綴的原文。
 * @param variables - 變數表。
 * @param field - 這段文字在設定裡叫什麼，錯誤訊息指名用。
 * @returns 代入完的文字。
 * @throws {SystemPromptTemplateError} 有未知、沒有值或寫壞的引用。
 */
export function interpolateStrict(
  text: string,
  variables: Readonly<Record<string, string | undefined>>,
  field: string,
): string {
  let result = '';
  let last = 0;
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open));
    if (group === null) {
      // 後面還有收尾的 `}}` 代表這是一組寫壞的引用；沒有的話就是普通的字。
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new SystemPromptTemplateError(
          `system-prompt 的 ${field} 有寫壞的變數引用 "${text.slice(open, open + 16)}…"：引用是完整的 {{名字}}`,
        );
      }
      result += text.slice(last, open + 2);
      last = open + 2;
      continue;
    }
    const name = group[0].slice(2, -2);
    if (!VARIABLE_NAME.test(name)) {
      throw new SystemPromptTemplateError(
        `system-prompt 的 ${field} 有寫壞的變數引用 "{{${name}}}"：變數名要符合 ${String(VARIABLE_NAME)}`,
      );
    }
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables);
      throw new SystemPromptTemplateError(
        `system-prompt 的 ${field} 引用了不存在的變數 "{{${name}}}"；可用的變數：${known.length > 0 ? known.join('、') : '（沒有）'}`,
      );
    }
    const value = variables[name];
    if (value === undefined) {
      throw new SystemPromptTemplateError(
        `system-prompt 的 ${field} 引用的變數 "{{${name}}}" 在這次組裝沒有值`,
      );
    }
    result += text.slice(last, open) + value;
    last = open + group[0].length;
  }
  return result + text.slice(last);
}

/** 算好的兩段：接在最前面的，與接在最後面的。空字串代表那一頭不加東西。 */
export interface SystemPromptParts {
  readonly head: string;
  readonly tail: string;
}

/**
 * 把快照與這一次呼叫的變數值算成前後兩段。**空的段落不佔位**，段與段之間隔一個空行（dsh 的 `renderPrompt` 也是丟掉空段、以空行接）。
 *
 * 順序 ≤ `DEPLOYMENT_PERSONA_PREFIX` 的段進前段、≥ `DEPLOYMENT_PERSONA_SUFFIX` 的進後段（中間沒有段，登記時就拒絕）。
 * 只有快照裡登記過名字的變數可用；值是 `values` 裡同名的那一格，沒有就是「沒有值」。
 *
 * @param assembly - 快照。
 * @param values - 這一次呼叫的變數值（宿主交的，名字多於已登記的不算數）。
 * @param fieldOf - 段的名字 → 錯誤訊息裡指名的格子；沒有對照的用段的名字。
 * @returns 前段與後段。
 * @throws {SystemPromptTemplateError} 插值壞了。
 */
export function composeSystemPromptParts(
  assembly: SystemPromptAssembly,
  values: Readonly<Record<string, string | undefined>>,
  fieldOf: Readonly<Record<string, string>> = {},
): SystemPromptParts {
  const table: Record<string, string | undefined> = {};
  for (const name of assembly.variables) table[name] = values[name];
  const render = (section: PromptSection): string =>
    interpolateStrict(section.text, table, fieldOf[section.name] ?? section.name);
  const head: string[] = [];
  const tail: string[] = [];
  for (const section of assembly.sections) {
    if (section.order <= SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX) head.push(render(section));
    else tail.push(render(section));
  }
  const join = (parts: readonly string[]): string =>
    parts.filter((part) => part.length > 0).join('\n\n');
  return { head: join(head), tail: join(tail) };
}

/**
 * 檢查一段能不能登記；不合就拋。提供者的 `section()` 與測試共用，**第一刀不支援的一律在登記時大聲拒絕**（#1477 PM 條件 9）。
 *
 * @param section - 要登記的段（來自別的插件，形狀不可信）。
 * @throws 見 {@link SystemPrompt.section}。
 */
export function assertSectionRegistrable(section: unknown): asserts section is PromptSection {
  if (typeof section !== 'object' || section === null) {
    throw new TypeError('systemPrompt.section() 要收一個物件 { name, order, text }');
  }
  const { name, order, text } = section as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('systemPrompt.section() 的 name 要是非空字串');
  }
  if (typeof order !== 'number' || !Number.isFinite(order)) {
    throw new TypeError(`systemPrompt.section() "${name}" 的 order 要是有限的數字`);
  }
  if (typeof text === 'function') {
    throw new TypeError(
      `systemPrompt.section() "${name}" 的 text 是函式：第一刀只收字串（偏離登記第 5 列），不會靜靜丟掉`,
    );
  }
  if (typeof text !== 'string') {
    throw new TypeError(`systemPrompt.section() "${name}" 的 text 要是字串`);
  }
  for (const unsupported of ['complete', 'interpolate'] as const) {
    if (unsupported in section) {
      throw new TypeError(
        `systemPrompt.section() "${name}" 帶了 ${unsupported}：第一刀不支援（偏離登記第 5 列），不會靜靜丟掉`,
      );
    }
  }
  if (
    order > SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX &&
    order < SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX
  ) {
    throw new RangeError(
      `systemPrompt.section() "${name}" 的 order ${String(order)} 落在前綴（${String(SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX)}）與後綴（${String(SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX)}）之間：` +
        '第一刀只渲染頭尾兩段，中間段的規則留給第一個用到的遷移卡（偏離登記第 10 列）',
    );
  }
}
