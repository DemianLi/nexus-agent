import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createDeepAgent, registerHarnessProfile, StateBackend } from 'deepagents';
import { afterEach, describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import {
  assertHarnessProfileDeclared,
  describeHarnessProfileEffects,
  EXTRA_MIDDLEWARE_FACTORY,
  NO_HARNESS_PROFILE_EFFECTS,
  type HarnessProfileEffects,
} from './harness-profile.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 內建 Codex profile 的後綴裡最不像會被順手改掉的一句。 */
const CODEX_SUFFIX_MARKER = 'reconcile every TODO or plan item created via write_todos';

/** 內建 Codex profile 的 spec 之一。三個 spec 共用同一份 profile。 */
const CODEX_SPEC = 'openai:gpt-5.2-codex';

/** 基座自己的預設模型，也是 repo 宣告的預設供應商。 */
const ANTHROPIC_SPEC = 'anthropic:claude-sonnet-4-6';

function systemPrompt(messages: readonly BaseMessage[]): string {
  return messages
    .filter((message) => message.getType() === 'system')
    .map((message) => message.text)
    .join('\n');
}

/**
 * 把一個假模型偽裝成基座認得的供應商與型號。
 *
 * 基座的 `getModelProvider` 是對 `getName()` 這個**字串**查表（不是 `instanceof`），
 * `getModelIdentifier` 讀的是 `model_name` / `modelName`——所以偽裝這兩件事，就能讓真的
 * `createDeepAgent` 走進真的 profile 解析，而不必裝 `@langchain/anthropic` 或打任何一支
 * 供應商的 API。
 */
function spoofModelIdentity(
  model: ScriptedChatModel,
  identity: { readonly className: string; readonly modelName: string },
): ScriptedChatModel {
  Object.defineProperty(model, 'getName', {
    value: () => identity.className,
    configurable: true,
  });
  Object.defineProperty(model, 'model_name', {
    value: identity.modelName,
    configurable: true,
    enumerable: true,
  });
  return model;
}

describe('基座按模型改寫組裝', () => {
  it('偽裝成 Codex 就真的多一個 write_todos 與一段我們沒寫的提示詞', async () => {
    const model = spoofModelIdentity(new ScriptedChatModel({ turns: [{ content: '好。' }] }), {
      className: 'ChatOpenAI',
      modelName: 'gpt-5.2-codex',
    });

    // 刻意繞過 createNexusAgent 直接呼叫基座：這一條要證的是「基座真的會這樣做」，
    // 中間隔著我們自己那道宣告檢查就驗不到了。
    const agent = createDeepAgent({ model, backend: new StateBackend() });
    await agent.invoke({ messages: [new HumanMessage('嗨。')] });

    // 組裝參數裡沒有任何一個字提到 write_todos，它是 profile 的 extraMiddleware 帶進來的。
    expect(model.boundToolNames).toContain('write_todos');
    // 而基座組出來的 system prompt 會指著它——指的不是我們在管的那個 todo_write。
    expect(systemPrompt(model.lastPrompt)).toContain(CODEX_SUFFIX_MARKER);
  });

  it('同一份組裝、只把偽裝拿掉，那兩樣就都不見了', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });

    const agent = createDeepAgent({ model, backend: new StateBackend() });
    await agent.invoke({ messages: [new HumanMessage('嗨。')] });

    // 對照組：唯一的差別是模型的身分，組裝參數一字未改。
    expect(model.boundToolNames).not.toContain('write_todos');
    expect(systemPrompt(model.lastPrompt)).not.toContain(CODEX_SUFFIX_MARKER);
  });

  it('我們重寫的那兩個 hint 推得出跟基座一樣的結論', () => {
    const model = spoofModelIdentity(new ScriptedChatModel({ turns: [{ content: '好。' }] }), {
      className: 'ChatOpenAI',
      modelName: 'gpt-5.2-codex',
    });

    // 上面兩條觀測到的（多一個工具、多一段後綴），這裡在不建 agent 的情況下預測得出來。
    // `getModelProvider` / `getModelIdentifier` 是 @internal，這條是那份手抄的守衛。
    expect(describeHarnessProfileEffects(model)).toEqual({
      ...NO_HARNESS_PROFILE_EFFECTS,
      systemPromptSuffix: true,
      extraMiddleware: [EXTRA_MIDDLEWARE_FACTORY],
    });
  });

  it('字串 spec 那條路不必偽裝就到得了', () => {
    expect(describeHarnessProfileEffects(ANTHROPIC_SPEC)).toEqual({
      ...NO_HARNESS_PROFILE_EFFECTS,
      systemPromptSuffix: true,
    });
    expect(describeHarnessProfileEffects(CODEX_SPEC)).toEqual({
      ...NO_HARNESS_PROFILE_EFFECTS,
      systemPromptSuffix: true,
      extraMiddleware: [EXTRA_MIDDLEWARE_FACTORY],
    });
  });

  it('沒有人認領的模型解出來是「什麼都不做」', () => {
    expect(describeHarnessProfileEffects(new ScriptedChatModel({ turns: [] }))).toEqual(
      NO_HARNESS_PROFILE_EFFECTS,
    );
    // 裸供應商鍵沒有人註冊——這一條的守衛在 baseline.test.ts，那裡才是升版會紅的地方。
    expect(describeHarnessProfileEffects('openai:openai/gpt-oss-120b')).toEqual(
      NO_HARNESS_PROFILE_EFFECTS,
    );
  });
});

/**
 * 五根槓桿全部拉滿的一份 profile，註冊在一個沒有別人用的 spec 底下。
 *
 * **內建的四份只拉了兩根**（後綴與 extraMiddleware），所以
 * `describeHarnessProfileEffects` 裡讀 `toolDescriptionOverrides` / `excludedTools` /
 * `excludedMiddleware` 的那三行**從來沒有跑過非空值**。那三行是在組裝點跑的，寫錯的
 * 下場是「檢查自己拋」而不是「檢查報告出問題」——比它要防的缺陷更糟。
 *
 * registry 是全域而且 `registerHarnessProfile` 是累加的，所以鍵取一個只有這裡用的。
 */
const PROBE_SPEC = 'nexus-probe:all-levers';

describe('五根槓桿都描述得出來', () => {
  it('全部拉滿時七個欄位一個都不漏', () => {
    registerHarnessProfile(PROBE_SPEC, {
      baseSystemPrompt: '整份換掉。',
      systemPromptSuffix: '追加一段。',
      toolDescriptionOverrides: { echo: '被改寫的說明。', ls: '也被改寫。' },
      excludedTools: ['grep', 'delete'],
      excludedMiddleware: ['SomeOptionalMiddleware'],
      generalPurposeSubagent: { enabled: false },
    });

    expect(describeHarnessProfileEffects(PROBE_SPEC)).toEqual({
      baseSystemPrompt: true,
      systemPromptSuffix: true,
      toolDescriptionOverrides: ['echo', 'ls'],
      excludedTools: ['delete', 'grep'],
      excludedMiddleware: ['SomeOptionalMiddleware'],
      extraMiddleware: [],
      generalPurposeSubagent: true,
    });
  });
});

describe('宣告檢查', () => {
  const savedKey = process.env[LIVE_API_KEY_ENV];

  afterEach(() => {
    if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = savedKey;
  });

  it('真實 live model 今天過得了這道檢查', () => {
    // 只建模型，不發任何請求；key 的存在是 createLiveModel 的前置條件而已。
    process.env[LIVE_API_KEY_ENV] = 'test-key-not-used';

    // **絆索的方向是反的**：今天過得了，是因為 `@langchain/openai` 把型號存在 `model` 而
    // 不是 `model_name` / `modelName`。哪天它補齊那些欄位，這一條會紅——那正是我們要知道
    // 的那一刻，而不是等到生產上的 agent 多出一組沒人宣告的工具。
    expect(() => assertHarnessProfileDeclared(createLiveModel())).not.toThrow();
  });

  it('沒宣告卻有東西：擋下來，並且訊息可以直接貼回去', () => {
    let message = '';
    try {
      assertHarnessProfileDeclared(CODEX_SPEC);
      expect.unreachable('應該擋下來');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('沒有宣告');
    expect(message).toContain(CODEX_SPEC);
    // Codex 這份的 extraMiddleware 是工廠函式——訊息本身不能因為它而炸掉。
    expect(message).toContain(`extraMiddleware: ['${EXTRA_MIDDLEWARE_FACTORY}']`);
    expect(message).toContain('systemPromptSuffix: true');
  });

  it('宣告對了就放行', () => {
    const declared: HarnessProfileEffects = {
      ...NO_HARNESS_PROFILE_EFFECTS,
      systemPromptSuffix: true,
      extraMiddleware: [EXTRA_MIDDLEWARE_FACTORY],
    };

    expect(() => assertHarnessProfileDeclared(CODEX_SPEC, declared)).not.toThrow();
  });

  it('宣告了卻沒有那些東西：一樣擋', () => {
    // 過時的宣告也是謊。升版把槓桿拿掉時，這個方向才是會發生的那一個。
    expect(() =>
      assertHarnessProfileDeclared(new ScriptedChatModel({ turns: [] }), {
        ...NO_HARNESS_PROFILE_EFFECTS,
        systemPromptSuffix: true,
      }),
    ).toThrow('與組裝點宣告的不一致');
  });
});

describe('組裝點', () => {
  it('一個字串就到得了：預設供應商的 spec 會讓組裝失敗', async () => {
    // repo 宣告的預設供應商，而且 `AgentModel` 收字串——這不是潛在缺陷，是一次換模型的距離。
    await expect(createNexusAgent({ plugins: [], model: ANTHROPIC_SPEC })).rejects.toThrow(
      '沒有宣告',
    );
  });

  it('宣告過就組得起來', async () => {
    const { agent } = await createNexusAgent({
      plugins: [],
      model: ANTHROPIC_SPEC,
      expectedHarnessProfile: { ...NO_HARNESS_PROFILE_EFFECTS, systemPromptSuffix: true },
    });

    expect(agent).toBeDefined();
  });

  it('省略即宣告「什麼都不做」，今天的呼叫端一個都不受影響', async () => {
    const { agent } = await createNexusAgent({
      plugins: [],
      model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
    });

    expect(agent).toBeDefined();
  });
});
