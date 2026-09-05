/**
 * 基座**按模型改寫組裝**這件事，在我們這側現形。
 *
 * `createDeepAgent()` 一進門就從 `model` 解出一份 **harness profile**，然後才開始組
 * middleware。那份 profile 有五根槓桿：拿掉檔案工具、改寫我們自己註冊的工具的
 * description、加 middleware（連同它帶的工具）、按名字移除 middleware、換掉或追加系統
 * 提示詞。**這五件 `foldRegistry` 一件都看不到**——fold 交出去的是參數，profile 是在
 * 參數之後、在基座裡面套上去的。詳見
 * [#140](https://github.com/DemianLi/nexus-agent/issues/140)。
 *
 * 所以這裡不擋、也不代替人決定，而是要求**宣告**：組裝點聲明「我知道這個模型會對組裝
 * 做這些事」，解出來的與宣告的不一致就當場失敗。沒宣告等於宣告「什麼都不做」——這是
 * 預設，也是今天所有呼叫端的實情。
 *
 * **為什麼是宣告而不是一律擋。** 一律擋等於把 `model: 'anthropic:claude-sonnet-4-6'`
 * 這個字串永久封死，而那正好是 repo 宣告的預設供應商（見
 * {@link CreateNexusAgentOptions.model} 的 JSDoc）——那種護欄會被人惱怒地拔掉，不會被
 * 遵守。形狀照 dsh 的 `modelPolicies`（`dsh-compaction-basic`）：**按模型的變化允許存在，
 * 但要在設定裡寫得出來，而且載入時驗得到**。這樣 Q1（我們支不支援 Codex 模型）不再是
 * 前置條件：不支援就沒有人宣告，撞上就紅；支援了就有人宣告，而升版改掉那份 profile 的
 * 槓桿組合時照樣紅。
 *
 * **宣告的是拉了哪幾根槓桿，不是槓桿的內容。** system prompt 後綴的**文字**變了不會讓
 * 這裡紅——那是升版絆索的事（[`baseline.test.ts`](./baseline.test.ts)），不該讓
 * deepagents 的一次 patch 升版變成生產組裝失敗。這裡管的是「我的 agent 的組成是不是我
 * 宣告的那個」，而文字漂移不改變組成。
 */

import type { AgentModel } from '@nexus/core';
import { getHarnessProfile } from 'deepagents';
import type { HarnessProfile } from 'deepagents';

/**
 * 一份 harness profile 會對組裝做的事，**照槓桿列，不照內容列**。
 *
 * 欄位與 `HarnessProfile` 的七個欄位一一對應。字串陣列一律排序後比較，所以宣告時的
 * 順序不重要。
 */
export interface HarnessProfileEffects {
  /** 整份換掉系統提示詞的 base。 */
  readonly baseSystemPrompt: boolean;
  /** 在系統提示詞後面追加一段。 */
  readonly systemPromptSuffix: boolean;
  /** description 被改寫的工具名——**包含我們自己 plugin 註冊的工具**。 */
  readonly toolDescriptionOverrides: readonly string[];
  /** 被拿掉的工具名。 */
  readonly excludedTools: readonly string[];
  /** 被按名字移除的 middleware。 */
  readonly excludedMiddleware: readonly string[];
  /**
   * 額外掛上的 middleware（連同它帶的工具）。
   *
   * 靜態陣列時是它們的 `name`；**工廠函式時是 {@link EXTRA_MIDDLEWARE_FACTORY} 這個哨兵**
   * ——名字要把 middleware 建出來才知道，而一道檢查不該有建構的副作用。內建的 Codex
   * profile 走的正是工廠那條。
   */
  readonly extraMiddleware: readonly string[];
  /** 自動附加的 general-purpose subagent 被改設定。 */
  readonly generalPurposeSubagent: boolean;
}

/**
 * `extraMiddleware` 是工廠函式時放進 {@link HarnessProfileEffects.extraMiddleware} 的哨兵。
 *
 * 它說的是「有東西會被掛上，但這道檢查不建它所以不知道叫什麼」，不是「掛了一個叫這個
 * 名字的 middleware」。
 */
export const EXTRA_MIDDLEWARE_FACTORY = '<factory>';

/** 什麼都不做的 profile——**也是沒有宣告時的預設宣告**。 */
export const NO_HARNESS_PROFILE_EFFECTS: HarnessProfileEffects = {
  baseSystemPrompt: false,
  systemPromptSuffix: false,
  toolDescriptionOverrides: [],
  excludedTools: [],
  excludedMiddleware: [],
  extraMiddleware: [],
  generalPurposeSubagent: false,
};

/**
 * 模型實例的類別名 → 供應商，出處是基座的 `getModelProvider`（`src/agent.ts`）。
 *
 * **手抄的**，跟 [`base-tools.ts`](./base-tools.ts) 同一個理由：`getModelProvider` 與
 * `getModelIdentifier` 都是 `@internal`，`dist/` 的每一份 `.d.ts` 裡都是零命中。所以
 * [`harness-profile.test.ts`](./harness-profile.test.ts) 裡有一條**跑完整
 * `createDeepAgent`** 的測試當守衛：抄錯了，那條會紅。
 *
 * 注意 Google 那個值是 `google` 而不是 `google_genai`——照抄，不照猜。
 */
const PROVIDER_BY_MODEL_CLASS: Readonly<Record<string, string>> = {
  ChatAnthropic: 'anthropic',
  ChatOpenAI: 'openai',
  ChatGoogleGenerativeAI: 'google',
};

/** `getName()` 回這個名字時，供應商與型號都改從 `_defaultConfig` 讀。 */
const CONFIGURABLE_MODEL_CLASS = 'ConfigurableModel';

interface ModelInstanceShape {
  readonly getName?: () => string;
  readonly _defaultConfig?: { readonly modelProvider?: string; readonly model?: string };
  readonly model_name?: string;
  readonly modelName?: string;
}

function modelClassName(model: ModelInstanceShape): string | undefined {
  return typeof model.getName === 'function' ? model.getName() : undefined;
}

/** 基座的 `getModelProvider` 的重寫。 */
function providerHint(model: ModelInstanceShape): string | undefined {
  const className = modelClassName(model);
  if (className === CONFIGURABLE_MODEL_CLASS) return model._defaultConfig?.modelProvider;
  return className === undefined ? undefined : PROVIDER_BY_MODEL_CLASS[className];
}

/**
 * 基座的 `getModelIdentifier` 的重寫。
 *
 * **`_defaultConfig.model` 只有 `ConfigurableModel` 走得到**——其餘類別直接落到
 * `model_name` / `modelName`。今天的 `ChatOpenAI`（`@langchain/openai` 1.5.10）這兩個都是
 * `undefined`（它把型號存在 `model`），所以實例那條路現在解不出任何 profile。**那不是
 * 我們選的安全**：哪天欄位補齊，這裡與基座會同時開始解得出東西，而
 * [`harness-profile.test.ts`](./harness-profile.test.ts) 裡對真實 live model 的那條會紅。
 */
function identifierHint(model: ModelInstanceShape): string | undefined {
  const fromConfig =
    modelClassName(model) === CONFIGURABLE_MODEL_CLASS ? model._defaultConfig?.model : undefined;
  return fromConfig ?? model.model_name ?? model.modelName ?? undefined;
}

/**
 * 基座的 `resolveHarnessProfile` 的重寫，**查表那一步用的是 public 的
 * `getHarnessProfile`**。
 *
 * 重寫的只有「從一個模型湊出查詢鍵」的順序，不含 registry 的合併規則——後者
 * `getHarnessProfile` 自己就做完了（exact 與 provider 都在時合併，provider 當 base）。
 *
 * @returns 解出來的 profile，或沒有任何鍵命中時的 `undefined`。
 */
function resolveProfile(model: AgentModel): HarnessProfile | undefined {
  if (typeof model === 'string') return getHarnessProfile(model);
  if (typeof model !== 'object' || model === null) return undefined;

  const instance = model as ModelInstanceShape;
  const provider = providerHint(instance);
  const identifier = identifierHint(instance);

  if (provider !== undefined && identifier !== undefined && !identifier.includes(':')) {
    const exact = getHarnessProfile(`${provider}:${identifier}`);
    if (exact !== undefined) return exact;
  }
  if (identifier !== undefined && identifier.includes(':')) {
    const byIdentifier = getHarnessProfile(identifier);
    if (byIdentifier !== undefined) return byIdentifier;
  }
  if (provider !== undefined) return getHarnessProfile(provider);
  return undefined;
}

function describeExtraMiddleware(extra: HarnessProfile['extraMiddleware']): readonly string[] {
  if (typeof extra === 'function') return [EXTRA_MIDDLEWARE_FACTORY];
  return extra.map((middleware) => middleware.name ?? '<anonymous>').sort();
}

/**
 * 這個模型會讓基座對組裝做什麼。
 *
 * 解不出 profile、或解出一份什麼都不拉的 profile，兩者都回
 * {@link NO_HARNESS_PROFILE_EFFECTS}——**「沒有人認領這個模型」與「認領了但不做事」對
 * 組裝的後果一模一樣**，不該有兩種宣告寫法。
 *
 * @param model - 要交給基座的模型。字串 spec 與模型實例都收。
 * @returns 這次組裝會被改成什麼樣。
 */
export function describeHarnessProfileEffects(model: AgentModel): HarnessProfileEffects {
  const profile = resolveProfile(model);
  if (profile === undefined) return NO_HARNESS_PROFILE_EFFECTS;

  return {
    baseSystemPrompt: profile.baseSystemPrompt !== undefined,
    systemPromptSuffix: profile.systemPromptSuffix !== undefined,
    toolDescriptionOverrides: Object.keys(profile.toolDescriptionOverrides).sort(),
    excludedTools: [...profile.excludedTools].sort(),
    excludedMiddleware: [...profile.excludedMiddleware].sort(),
    extraMiddleware: describeExtraMiddleware(profile.extraMiddleware),
    generalPurposeSubagent: profile.generalPurposeSubagent !== undefined,
  };
}

/**
 * 這個模型解 profile 時用的查詢鍵，寫給人看。
 *
 * 只用在錯誤訊息裡——「為什麼是這份 profile」的答案就是這個字串，而實例那條路的鍵是
 * 湊出來的，不寫出來沒人猜得到。
 */
function describeLookupKey(model: AgentModel): string {
  if (typeof model === 'string') return `字串 spec \`${model}\``;
  if (typeof model !== 'object' || model === null) return '無法辨識的 model';

  const instance = model as ModelInstanceShape;
  const className = modelClassName(instance) ?? '<沒有 getName()>';
  const provider = providerHint(instance) ?? '<無>';
  const identifier = identifierHint(instance) ?? '<無>';
  return `模型實例 \`${className}\`（供應商 ${provider}、型號 ${identifier}）`;
}

function sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

function effectsEqual(left: HarnessProfileEffects, right: HarnessProfileEffects): boolean {
  return (
    left.baseSystemPrompt === right.baseSystemPrompt &&
    left.systemPromptSuffix === right.systemPromptSuffix &&
    left.generalPurposeSubagent === right.generalPurposeSubagent &&
    sameNames(left.toolDescriptionOverrides, right.toolDescriptionOverrides) &&
    sameNames(left.excludedTools, right.excludedTools) &&
    sameNames(left.excludedMiddleware, right.excludedMiddleware) &&
    sameNames(left.extraMiddleware, right.extraMiddleware)
  );
}

/**
 * 把一份 effects 印成可以直接貼回組裝點的 TS 字面量。
 *
 * **刻意不是 `JSON.stringify`**：錯誤訊息的用途是「照著補上宣告」，而 JSON 的引號貼回
 * TS 是要再改一次的。
 */
export function formatHarnessProfileEffects(effects: HarnessProfileEffects): string {
  const list = (names: readonly string[]): string =>
    `[${sorted(names)
      .map((name) => `'${name}'`)
      .join(', ')}]`;

  return [
    '{',
    `  baseSystemPrompt: ${effects.baseSystemPrompt},`,
    `  systemPromptSuffix: ${effects.systemPromptSuffix},`,
    `  toolDescriptionOverrides: ${list(effects.toolDescriptionOverrides)},`,
    `  excludedTools: ${list(effects.excludedTools)},`,
    `  excludedMiddleware: ${list(effects.excludedMiddleware)},`,
    `  extraMiddleware: ${list(effects.extraMiddleware)},`,
    `  generalPurposeSubagent: ${effects.generalPurposeSubagent},`,
    '}',
  ].join('\n');
}

/**
 * 解出來的 profile 與宣告的不一致就當場失敗。
 *
 * 兩個方向都擋：**沒宣告卻有東西**（今天的預設，也是這道檢查存在的理由），與**宣告了
 * 卻沒有那些東西**（升版把槓桿拿掉了，宣告變成過時的謊）。所以比較是對稱的，沒宣告時
 * 拿 {@link NO_HARNESS_PROFILE_EFFECTS} 當宣告。
 *
 * @param model - 要交給基座的模型。
 * @param expected - 組裝點的宣告。省略即宣告「這個模型不會改動組裝」。
 * @throws 解出來的與宣告的不一致。訊息含查詢鍵、實際的槓桿組合，以及可以直接貼回去的
 *   宣告字面量。
 */
export function assertHarnessProfileDeclared(
  model: AgentModel,
  expected?: HarnessProfileEffects,
): void {
  const actual = describeHarnessProfileEffects(model);
  const declared = expected ?? NO_HARNESS_PROFILE_EFFECTS;
  if (effectsEqual(actual, declared)) return;

  const undeclared = expected === undefined;
  const headline = undeclared
    ? '基座會依這個模型改寫組裝，而組裝點沒有宣告這件事。'
    : '基座對這個模型改寫組裝的方式，與組裝點宣告的不一致。';

  throw new Error(
    `${headline}\n` +
      `模型：${describeLookupKey(model)}\n` +
      `實際：\n${formatHarnessProfileEffects(actual)}\n` +
      `宣告：\n${formatHarnessProfileEffects(declared)}\n` +
      '確認過這些改動可以接受之後，把「實際」那一份填進 `expectedHarnessProfile`；' +
      '不能接受就換模型。這道檢查不替人決定該不該接受。',
  );
}
