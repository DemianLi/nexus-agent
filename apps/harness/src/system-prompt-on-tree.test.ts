/**
 * system-prompt 在 Cordis 樹上，並提供 `systemPrompt` 服務（[#1477](https://github.com/DemianLi/nexus-agent/issues/1477)，
 * 逐條 thread 接縫之後第一顆「插件自己提供服務、宿主在組 thread 時取快照」的遷移）：驗收 B、D2、E。
 * 量的是產品路徑——真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的相容層 `assembly.create`（serve 每條 thread
 * 一次）、真的 `createNexusAgent`；不手搭 `ctx.plugin`。
 *
 * 驗收 A（SDK lint、一致性套件、套一次服務兩條 thread）在 `packages/nexus-plugin-system-prompt` 與 `migrated-plugin-gate.test.ts`；
 * 驗收 C（golden）是一次性錄製，做法與數字寫在 PR 內文；驗收 D（寫壞的變數在 CLI／serve 起動與 thread 組裝的失敗）在
 * `startup-audit.test.ts` 與 `serve-plugin-failed-record.test.ts`；既有的產品路徑測試（出貨值、後綴最後一段、子代理也帶、patch 改前後綴）
 * 是 `system-prompt-persona.test.ts`，斷言一個字沒動。`system-prompt-middleware.test.ts` 量宿主建的 middleware 本身。
 *
 * **D2 的核心風險**：快照是「組 thread 當下」取的，不是「每次模型呼叫」取的。後者的樣子是——開著的 thread 在設定改了之後，下一輪
 * 就講起新的前後綴，而且沒有任何例外。所以 D2 讓兩條 thread 跨過一次合法的設定變更，**各看各的**。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseMessage } from '@langchain/core/messages';
import { SessionRegistry } from '@nexus/core';
import { HARNESS_IDENTITY_SENTENCE } from '@nexus/plugin-system-prompt';
import * as systemPromptModule from '@nexus/plugin-system-prompt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HEADLESS_APPROVALS, createNexusAgent } from './agent-factory.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot, NexusAssembly } from './cordis-root.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { toAgentInvocation } from './messages.js';
import { isBridgeEntry, loadDefaultPlugins, loadPluginConfig } from './plugin-config.js';
import type { LoadedPluginConfig } from './plugin-config.js';
import { seedHomePatch } from './plugin-journal.fixture.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import { mountDetached } from './plugin-tree.js';
import { ScriptedChatModel } from './scripted-model.js';
import { liveModelConfigForModel } from './settings/live-model.js';
import { auditStartupEntries } from './startup-audit.js';
import { createSystemPromptMiddleware } from './system-prompt-middleware.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-system-prompt-tree-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

function home(): { readonly env: NodeJS.ProcessEnv; readonly dir: string } {
  const dir = scratch();
  return { env: { [HARNESS_HOME_ENV]: dir }, dir };
}

const warnNothing = (): void => {};
const ID = 'system-prompt';

function newRoot(): CordisRoot {
  const root = createCordisRoot({ channel: entryApprovalChannel(undefined) });
  roots.push(root);
  return root;
}

interface Booted {
  readonly root: CordisRoot;
  readonly loaded: LoadedPluginConfig;
  readonly assembly: NexusAssembly;
}

/** 入口的順序：讀清單（帶樹）→ 建根、掛相容層與入口那一列。 */
async function boot(env: NodeJS.ProcessEnv): Promise<Booted> {
  const root = newRoot();
  const loaded = await loadDefaultPlugins({ env, warn: warnNothing }, { tree: root.tree });
  const assembly = await root.boot('serve', { plugins: loaded.plugins });
  return { root, loaded, assembly };
}

/** 這一輪模型實際讀到的 system 文字（內容是區塊陣列時把各塊的字接起來）。 */
function systemOf(prompt: readonly BaseMessage[]): string {
  return prompt
    .filter((message) => message.getType() === 'system')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((block) => ('text' in block ? String(block.text) : '')).join(''),
    )
    .join('\n');
}

/** serve 的形狀：這條 thread 自己一次相容層組裝，用呼叫端給的那份載入結果，跑一輪，回模型讀到的 system 文字。 */
async function systemTextOn(
  booted: Booted,
  loaded: LoadedPluginConfig,
  threadId: string,
): Promise<{ text: string; dispose: () => Promise<void> }> {
  const plugins = withScriptedModel([...loaded.plugins], [{ content: '好。' }]);
  const built = await booted.assembly.create({ live: false }, { plugins });
  const attachment = built.attachSessions(new SessionRegistry(threadId));
  await built.agent.invoke(toAgentInvocation('開工'), { configurable: { thread_id: threadId } });
  const model = built.model as unknown as ScriptedChatModel;
  return {
    text: systemOf(model.prompts[0] ?? []),
    dispose: async () => {
      await attachment.detach();
      await built.dispose();
    },
  };
}

describe('B：出貨清單上的 system-prompt 經樹進來，提供 systemPrompt 服務，位置不變', () => {
  it('是橋接列、樹上 include 列 ACTIVE、沒有掉列；啟動稽核過；快照上是 mounted', async () => {
    const root = newRoot();
    const loaded = await loadDefaultPlugins(
      { env: home().env, warn: warnNothing },
      { tree: root.tree },
    );
    const entry = loaded.plugins.find((candidate) => loaded.rows.get(candidate)?.id === ID);
    expect(entry).toBeDefined();
    expect(entry !== undefined && isBridgeEntry(entry)).toBe(true);
    expect(entry?.plugin.name).toBe(ID);
    expect(loaded.dropped).toEqual([]);
    expect(loaded.rows.get(entry as never)).toEqual({
      id: ID,
      module: '@nexus/plugin-system-prompt',
    });
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();

    const tree = await root.tree.context();
    expect(tree.loader.resolve(`include:${ID}`).fiber?.ctx.fiber.state).toBe(2);

    const source = {
      entries: loaded.entries,
      ids: loaded.ids,
      plugins: loaded.plugins,
      rows: loaded.rows,
      drops: loaded.dropped.map(({ id, stage }) => ({ id, stage })),
    };
    const snapshot = buildPluginSnapshot({
      running: source,
      saved: source,
      generatedAt: new Date(0),
    });
    expect(snapshot.rows.find((row) => row.id === ID)).toMatchObject({
      module: '@nexus/plugin-system-prompt',
      running: { state: 'mounted' },
      saved: { state: 'mounted' },
      sync: 'same',
    });
  }, 60000);

  it('樹上的 systemPrompt 服務：歸屬是 system-prompt 那一列、契約 1.0.0', async () => {
    const root = newRoot();
    await loadDefaultPlugins({ env: home().env, warn: warnNothing }, { tree: root.tree });
    const tree = await root.tree.context();
    const service = tree.get('systemPrompt') as
      { provider?: string; contractVersion?: string } | undefined;
    expect(service?.provider).toBe(`include:${ID}`);
    expect(service?.contractVersion).toBe('1.0.0');
  }, 60000);

  it('一條 thread 組裝後模型讀到身分句開頭、出貨前後綴；兩條 thread 各組一次也一樣', async () => {
    const booted = await boot(home().env);
    const a = await systemTextOn(booted, booted.loaded, 'thread-a');
    const b = await systemTextOn(booted, booted.loaded, 'thread-b');
    for (const { text } of [a, b]) {
      expect(text.startsWith(HARNESS_IDENTITY_SENTENCE)).toBe(true);
      expect(text).toContain('You are a helpful assistant powered by the scripted model.');
      expect(text.trimEnd().endsWith('Your working directory is /.')).toBe(true);
    }
    await a.dispose();
    await b.dispose();
  }, 60000);
});

describe('D2：快照在組 thread 當下取，之後設定改了，開著的 thread 不動、新的 thread 看新的', () => {
  it('合法的 personaSuffix 變更：舊 thread 再說一輪仍是舊後綴與身分句；新 thread 是新後綴', async () => {
    const h = home();
    const booted = await boot(h.env);

    // 第一條 thread：出貨值。
    const plugins = withScriptedModel(
      [...booted.loaded.plugins],
      [{ content: '一。' }, { content: '二。' }],
    );
    const built = await booted.assembly.create({ live: false }, { plugins });
    const attachment = built.attachSessions(new SessionRegistry('old'));
    const model = built.model as unknown as ScriptedChatModel;
    await built.agent.invoke(toAgentInvocation('第一句'), { configurable: { thread_id: 'old' } });

    // 設定在中間改了：同一棵樹再讀一次（home 層 patch 生效，樹上的列換成新的一列）。
    seedHomePatch(
      h.dir,
      ['- id: system-prompt', '  config:', "    personaSuffix: '新的收尾。'", ''].join('\n'),
    );
    const reloaded = await loadDefaultPlugins(
      { env: h.env, warn: warnNothing },
      { tree: booted.root.tree },
    );
    expect(reloaded.dropped).toEqual([]);

    // 舊 thread 再說一輪：它那顆 middleware 是組裝當下用快照建的，不會跟著變。
    await built.agent.invoke(toAgentInvocation('第二句'), { configurable: { thread_id: 'old' } });
    const oldFirst = systemOf(model.prompts[0] ?? []);
    const oldSecond = systemOf(model.prompts[1] ?? []);
    expect(oldSecond).toBe(oldFirst);
    expect(oldSecond).not.toContain('新的收尾。');
    expect(oldSecond.startsWith(HARNESS_IDENTITY_SENTENCE)).toBe(true);
    expect(oldSecond.trimEnd().endsWith('Your working directory is /.')).toBe(true);

    // 新 thread：用新讀的那份清單組裝，看到新的後綴。
    const fresh = await systemTextOn(booted, reloaded, 'new');
    expect(fresh.text.trimEnd().endsWith('新的收尾。')).toBe(true);
    expect(fresh.text).not.toContain('Your working directory is /.');
    expect(fresh.text.startsWith(HARNESS_IDENTITY_SENTENCE)).toBe(true);

    await attachment.detach();
    await built.dispose();
    await fresh.dispose();
  }, 60000);
});

describe('serve 跑到一半設定壞了：開著的 thread 不受影響，下一次讀清單那一列掉在 apply', () => {
  it('舊 thread 再說一輪文字不變；重讀時 system-prompt 掉了，訊息逐字是內層那句', async () => {
    const h = home();
    const booted = await boot(h.env);
    const plugins = withScriptedModel(
      [...booted.loaded.plugins],
      [{ content: '一。' }, { content: '二。' }],
    );
    const built = await booted.assembly.create({ live: false }, { plugins });
    const attachment = built.attachSessions(new SessionRegistry('open'));
    const model = built.model as unknown as ScriptedChatModel;
    await built.agent.invoke(toAgentInvocation('第一句'), { configurable: { thread_id: 'open' } });

    seedHomePatch(
      h.dir,
      ['- id: system-prompt', '  config:', "    personaSuffix: '收尾 {{modle}}'", ''].join('\n'),
    );
    const reloaded = await loadDefaultPlugins(
      { env: h.env, warn: warnNothing },
      { tree: booted.root.tree },
    );
    const drop = reloaded.dropped.find((item) => item.id === ID);
    expect(drop?.stage).toBe('apply');
    expect(drop?.message).toContain(
      'system-prompt 的 personaSuffix 引用了不存在的變數 "{{modle}}"；可用的變數：model、cwd',
    );

    await built.agent.invoke(toAgentInvocation('第二句'), { configurable: { thread_id: 'open' } });
    expect(systemOf(model.prompts[1] ?? [])).toBe(systemOf(model.prompts[0] ?? []));

    await attachment.detach();
    await built.dispose();
  }, 60000);
});

describe('快照缺席：宣告了 systemPrompt 卻沒有提供', () => {
  it('取不到服務的列掉在 apply，原因指名 systemPrompt；其餘列照樣起來', async () => {
    const dir = scratch();
    const module = join(dir, 'ghost.mjs');
    writeFileSync(
      module,
      `import { z } from 'zod';
export const name = 'ghost-sp';
export const inject = {};
export const Config = z.strictObject({});
export const manifest = {
  id: 'ghost-sp', version: '1.0.0', owner: 't',
  provides: [{ token: 'systemPrompt', version: '1.0.0' }], consumes: [],
  config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [],
};
export function apply() {}
`,
      { mode: 0o600 },
    );
    chmodSync(module, 0o600);
    const shipped = join(dir, 'cordis.yml');
    writeFileSync(shipped, `- id: ghost-sp\n  name: 'file://${module}'\n`, { mode: 0o600 });
    chmodSync(shipped, 0o600);
    const root = newRoot();
    const loaded = await loadPluginConfig({ shipped, warn: warnNothing }, { tree: root.tree });
    const drop = loaded.dropped.find((item) => item.id === 'ghost-sp');
    expect(drop?.stage).toBe('apply');
    expect(drop?.message).toMatch(/systemPrompt/u);
  }, 60000);
});

describe('E：同一棵樹／同一份清單上多條 thread，`{{model}}` 與 `{{cwd}}` 各是各的', () => {
  const originalKey = process.env[LIVE_API_KEY_ENV];
  beforeEach(() => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-fake-for-system-prompt-e';
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = originalKey;
  });

  it('同一份出貨清單組兩條 createNexusAgent thread、交錯跑：各代入各的 model 與 cwd，互不串線', async () => {
    const shipped = await shippedPlugins();
    const mk = async (model: string, cwd: string) => {
      const scripted = new ScriptedChatModel({ turns: [{ content: '好。' }] });
      const built = await createNexusAgent({
        model: scripted,
        plugins: shipped,
        approvals: HEADLESS_APPROVALS,
        systemPromptVariables: { model, cwd },
      });
      return { built, scripted };
    };
    const a = await mk('alpha-model', '/work/alpha');
    const b = await mk('beta-model', '/work/beta');
    await Promise.all([
      a.built.agent.invoke(toAgentInvocation('甲')),
      b.built.agent.invoke(toAgentInvocation('乙')),
    ]);
    const aText = systemOf(a.scripted.prompts[0] ?? []);
    const bText = systemOf(b.scripted.prompts[0] ?? []);
    expect(aText).toContain('powered by the alpha-model model');
    expect(aText).toContain('Your working directory is /work/alpha.');
    expect(aText).not.toContain('beta-model');
    expect(aText).not.toContain('/work/beta');
    expect(bText).toContain('powered by the beta-model model');
    expect(bText).toContain('Your working directory is /work/beta.');
    expect(bText).not.toContain('alpha-model');
    expect(bText).not.toContain('/work/alpha');
    await a.built.dispose();
    await b.built.dispose();
  }, 60000);

  it('組裝點建的模型實例（貼了路由標籤）：同一顆 middleware 面對兩個不同模型，{{model}} 跟著各自那一步走', async () => {
    // 快照：真的把 system-prompt 那一列掛一次、取快照（與組 thread 時宿主取的是同一條路）。
    const contributions = await mountDetached({
      id: ID,
      module: systemPromptModule,
      provides: ['systemPrompt'],
      config: { includeHarnessIdentity: false, personaPrefix: '你是 {{model}}。' },
    });
    if (contributions.systemPrompt === undefined) throw new Error('沒有取到快照');
    const middleware = createSystemPromptMiddleware(contributions.systemPrompt, {
      model: 'assembly-id',
      cwd: '/',
    });
    if (middleware === undefined) throw new Error('預期要掛 middleware');
    const wrap = (
      middleware as unknown as {
        wrapModelCall: (
          request: Record<string, unknown>,
          handler: (request: Record<string, unknown>) => unknown,
        ) => unknown;
      }
    ).wrapModelCall;

    // 模型實例走組裝點的建構式（`createLiveModel` 會貼路由標籤），不手貼標籤。
    const one = createLiveModel(liveModelConfigForModel('google/gemma-4-31b-it'));
    const two = createLiveModel(liveModelConfigForModel('openai/gpt-oss-120b'));
    const seen: string[] = [];
    for (const model of [one, two, one]) {
      await wrap({ systemPrompt: '', model }, (next) => {
        seen.push(String(next['systemPrompt']));
        return undefined;
      });
    }
    expect(seen).toEqual([
      '你是 google/gemma-4-31b-it。',
      '你是 openai/gpt-oss-120b。',
      '你是 google/gemma-4-31b-it。',
    ]);
  }, 60000);
});
