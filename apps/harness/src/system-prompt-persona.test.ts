/**
 * 系統提示詞的身分與 persona（[#720](https://github.com/DemianLi/nexus-agent/issues/720)）：**產品組裝真的把它送到模型手上**。
 *
 * 量的是模型請求那一層實際收到的 system 文字（`ScriptedChatModel.prompts`），不是 plugin 自己算出來的字串——後者證不了
 * 順序（後綴是不是真的最後一段）、也證不了子代理有沒有帶。經 `createCliAgent`（CLI 與 serve 共用的組裝）與
 * `createNexusAgent`（掛了 skills 與 `task` 的手搭組裝）兩條，都用出貨清單，不手動掛 plugin。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { BaseMessage } from '@langchain/core/messages';
import type { PluginEntry } from '@nexus/core';
import { createMiddleware } from 'langchain';
import { createSkillsPlugin } from '@nexus/plugin-skills';
import { HARNESS_IDENTITY_SENTENCE } from '@nexus/plugin-system-prompt';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { runCli, createCliAgent, runTurn } from './cli.js';
import { generateConfigSchema } from './config-schema-dump.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { shippedPlugins } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { composeEntries, loadDefaultPlugins } from './plugin-config.js';
import { ScriptedChatModel } from './scripted-model.js';
import { runServe } from './serve.js';
import { StartupError } from './startup-audit.js';

const shipped = await shippedPlugins();
const silent = { log: () => undefined, error: () => undefined };

/** 出貨值三句，逐字（卡上 2026-09-26 拍板）。`scripted` 是假模型在 `{{model}}` 的名字。 */
const IDENTITY = 'You are an AI agent powered by nexus-agent.';
const OPENING = 'You are a helpful assistant powered by the scripted model.';
const CLOSING = 'Your working directory is /.';
/** 組裝點傳的那句指引，不是 persona，要留著。 */
const GUIDANCE = '需要動用工具時就真的呼叫';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(root);
  chmodSync(root, 0o700);
  return root;
}

/** 寫一份 patch 檔（權限 0600，載入器要求只有自己寫得動）。 */
function writePatch(root: string, source: string): string {
  const path = join(root, 'persona.patch.yml');
  writeFileSync(path, source);
  chmodSync(path, 0o600);
  return path;
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(flatten).join('\n');
  if (content !== null && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : JSON.stringify(content);
  }
  return String(content);
}

/** 一輪 prompt 裡的 system 訊息（攤平，`content` 可能是區塊陣列）。 */
function systemOf(prompt: readonly BaseMessage[]): string {
  return prompt
    .filter((message) => message.getType() === 'system')
    .map((message) => flatten(message.content))
    .join('\n');
}

/** 出現次數。 */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** 跑一輪 CLI 組裝，回模型收到的 system 文字。 */
async function cliPrompt(
  plugins: readonly PluginEntry[],
  invocation: { readonly workspace?: string } = {},
  cwd?: string,
): Promise<string> {
  const { agent, dispose, model, sessionLog } = await createCliAgent(
    { live: false, ...invocation },
    plugins,
    cwd,
  );
  try {
    await runTurn(agent, '嗨。', silent, sessionLog);
  } finally {
    await dispose();
  }
  return systemOf((model as unknown as { lastPrompt: readonly BaseMessage[] }).lastPrompt);
}

describe('CLI 與 serve 共用的產品組裝：出貨值', () => {
  it('三句逐字都在，順序是身分句 → 開頭句 → 指引 → 結尾句，結尾句是最後一段', async () => {
    const text = await cliPrompt(shipped);
    const positions = [IDENTITY, OPENING, GUIDANCE, CLOSING].map((part) => text.indexOf(part));
    expect(
      positions.every((position) => position >= 0),
      text,
    ).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text.trimEnd().endsWith(CLOSING)).toBe(true);
    expect(text.startsWith(IDENTITY)).toBe(true);
    expect(HARNESS_IDENTITY_SENTENCE).toBe(IDENTITY);
  });

  it('不再自稱命令列助手', async () => {
    // 字面拆開寫：驗收是 `git grep` 那個詞在 apps/harness/src 零命中，測試檔也算在內。
    expect(await cliPrompt(shipped)).not.toContain(`命令列${'助手'}`);
  });

  it('掛了 --workspace（沙箱政策句、`@` 引用句、AGENTS.md）之後，結尾句仍是最後一段', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-persona-'));
    temporary.push(root);
    await writeFile(join(root, 'AGENTS.md'), '# 這個專案的規矩\n先讀再改。\n');
    const text = await cliPrompt(shipped, { workspace: root }, root);
    expect(text).toContain('目前的檔案政策');
    expect(text.indexOf('目前的檔案政策')).toBeLessThan(text.indexOf(CLOSING));
    expect(text.trimEnd().endsWith(CLOSING)).toBe(true);
    expect(occurrences(text, CLOSING)).toBe(1);
  });
});

describe('掛了 skills 與 task 的組裝', () => {
  async function workspaceWithSkill(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'nexus-persona-skills-'));
    temporary.push(root);
    await mkdir(join(root, 'skills', 'web-research'), { recursive: true });
    await writeFile(
      join(root, 'skills', 'web-research', 'SKILL.md'),
      '---\nname: web-research\ndescription: 上網查資料。\n---\n\n正文。\n',
    );
    return root;
  }

  /** root 叫 writer 去做事，writer 說完，root 收工：三次模型呼叫。 */
  function delegation(): ScriptedChatModel {
    return new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '寫點東西', subagent_type: 'writer' } }],
        },
        { content: '寫好了。' },
        { content: '收工。' },
      ],
    });
  }

  /** 往 system prompt 附加一句話的 middleware，模擬「任何會附加文字的 plugin」。 */
  function appender(sentence: string) {
    return createMiddleware({
      name: `appender${sentence}`,
      wrapModelCall: (request, handler) =>
        handler({ ...request, systemMessage: request.systemMessage.concat(`\n${sentence}`) }),
    });
  }

  /** 排在出貨清單**後面**的全域附加者：沒有 `last` 的話，後綴會排在它前面。 */
  const lateAppender: PluginEntry = {
    plugin: {
      name: 'late-appender',
      apply: (registry) => void registry.middleware.use(appender('GLOBAL-APPENDER')),
    },
  };

  const crew: PluginEntry = {
    plugin: {
      name: 'crew',
      apply: (registry) =>
        void registry.subagents.register({
          name: 'writer',
          description: '負責寫東西。',
          systemPrompt: '你是 writer，只寫交代給你的東西。',
          middleware: [appender('SPEC-APPENDER')],
        }),
    },
  };

  it('root：Skills System 與委派說明都在結尾句前面，結尾句是最後一段；子代理：帶部署前綴，自己的提示詞在中間', async () => {
    const root = await workspaceWithSkill();
    const model = delegation();
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [...shipped, createSkillsPlugin({ sources: ['/skills/'] }), lateAppender, crew],
    });
    try {
      await agent.invoke(toAgentInvocation('叫 writer 去做事。'));
    } finally {
      await dispose();
    }

    const prompts = model.prompts.map(systemOf);
    expect(prompts).toHaveLength(3);
    const [rootFirst, subagent, rootLast] = prompts as [string, string, string];

    // root：skills 段落與委派說明（`task` 的說明）都排在結尾句之前，結尾句只出現一次而且是最後一段。
    for (const text of [rootFirst, rootLast]) {
      expect(text).toContain('## Skills System');
      expect(text.indexOf('## Skills System')).toBeLessThan(text.indexOf(CLOSING));
      // 排在出貨清單後面才註冊的附加者也在結尾句前面——結尾句排的是所有附加者的內側，不是清單裡的某個位置。
      expect(text.indexOf('GLOBAL-APPENDER')).toBeLessThan(text.indexOf(CLOSING));
      expect(text.startsWith(IDENTITY)).toBe(true);
      expect(text.trimEnd().endsWith(CLOSING)).toBe(true);
      expect(occurrences(text, CLOSING)).toBe(1);
      expect(occurrences(text, IDENTITY)).toBe(1);
    }

    // 子代理：這一輪的請求也帶部署 persona（卡上第 2 項），自己的提示詞夾在前後綴中間，後綴仍是最後一段。
    expect(subagent).toContain('你是 writer，只寫交代給你的東西。');
    expect(subagent.startsWith(IDENTITY)).toBe(true);
    expect(subagent.indexOf(OPENING)).toBeLessThan(subagent.indexOf('你是 writer'));
    expect(subagent.indexOf('你是 writer')).toBeLessThan(subagent.indexOf(CLOSING));
    // 子代理自己帶的 middleware（`spec.middleware`）與全域附加者都在結尾句前面。
    expect(subagent.indexOf('GLOBAL-APPENDER')).toBeLessThan(subagent.indexOf(CLOSING));
    expect(subagent.indexOf('SPEC-APPENDER')).toBeLessThan(subagent.indexOf(CLOSING));
    expect(subagent.trimEnd().endsWith(CLOSING)).toBe(true);
    expect(occurrences(subagent, CLOSING)).toBe(1);
    expect(occurrences(subagent, IDENTITY)).toBe(1);
  });
});

describe('部署方用 patch 改', () => {
  it('改前後綴，送出的文字跟著變；`{{model}}` 與 `{{cwd}}` 代入', async () => {
    const home = privateDirectory('nexus-persona-home-');
    const patch = writePatch(
      home,
      [
        '- id: system-prompt',
        '  config:',
        '    includeHarnessIdentity: true',
        "    personaPrefix: '你是 {{model}} 的客服。'",
        "    personaSuffix: '目錄 {{cwd}}，結束。'",
        '',
      ].join('\n'),
    );
    const { plugins } = await loadDefaultPlugins({
      env: { [HARNESS_HOME_ENV]: home },
      patches: [patch],
    });
    const text = await cliPrompt(plugins);
    expect(text).toContain('你是 scripted 的客服。');
    expect(text).not.toContain(OPENING);
    expect(text.trimEnd().endsWith('目錄 /，結束。')).toBe(true);
  });

  it('includeHarnessIdentity: false 時身分句不在（patch 是整份取代，前後綴一起回到空）', async () => {
    const home = privateDirectory('nexus-persona-home-');
    const patch = writePatch(
      home,
      '- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n',
    );
    const { plugins } = await loadDefaultPlugins({
      env: { [HARNESS_HOME_ENV]: home },
      patches: [patch],
    });
    const text = await cliPrompt(plugins);
    expect(text).not.toContain(IDENTITY);
    expect(text).not.toContain(OPENING);
    expect(text).not.toContain(CLOSING);
    expect(text).toContain(GUIDANCE);
  });

  it('關掉那一列（disabled: true）：沒有身分句也沒有前後綴，指引還在', async () => {
    const home = privateDirectory('nexus-persona-home-');
    const patch = writePatch(home, '- id: system-prompt\n  disabled: true\n');
    const { plugins } = await loadDefaultPlugins({
      env: { [HARNESS_HOME_ENV]: home },
      patches: [patch],
    });
    const text = await cliPrompt(plugins);
    expect(text).not.toContain(IDENTITY);
    expect(text).toContain(GUIDANCE);
  });
});

describe('寫壞的前後綴：起動就失敗，不把字面的 {{…}} 送給模型', () => {
  const BAD = "- id: system-prompt\n  config:\n    personaPrefix: '你是 {{nope}}'\n";

  function env(): NodeJS.ProcessEnv {
    const home = privateDirectory('nexus-persona-bad-');
    // 放在 home 底下的 cordis.patch.yml，兩個入口都會讀。
    writeFileSync(join(home, 'cordis.patch.yml'), BAD);
    chmodSync(join(home, 'cordis.patch.yml'), 0o600);
    return { [HARNESS_HOME_ENV]: home };
  }

  it('CLI：StartupError，訊息指名 system-prompt、那一格與 nope', async () => {
    const error = await runCli({
      argv: ['說點什麼'],
      env: env(),
      input: new PassThrough(),
      output: new PassThrough(),
      printer: silent,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StartupError);
    expect((error as Error).message).toMatch(/system-prompt/u);
    expect((error as Error).message).toMatch(/personaPrefix.*\{\{nope\}\}/u);
  });

  it('serve：一樣起不來，同一則', async () => {
    const error = await runServe({ argv: ['--port', '0'], log: () => undefined, env: env() }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StartupError);
    expect((error as Error).message).toMatch(/personaPrefix.*\{\{nope\}\}/u);
  });
});

describe('設定欄位規格表', () => {
  it('`system-prompt` 那一列是完整的（不是 partial），三格都收，寫錯型別驗不過', async () => {
    const dump = await generateConfigSchema(composeEntries());
    const row = dump['x-nexus'].entries.find((entry) => entry.id === 'system-prompt');
    expect(row).toMatchObject({ status: 'schema', losses: [] });

    const validate = new Ajv2020({ strict: false }).compile(dump);
    const entry = (config: unknown) => [
      { id: 'system-prompt', name: '@nexus/plugin-system-prompt', config },
    ];
    expect(
      validate(
        entry({ includeHarnessIdentity: true, personaPrefix: '前綴', personaSuffix: '後綴' }),
      ),
    ).toBe(true);
    expect(validate(entry({ includeHarnessIdentity: '是' }))).toBe(false);
    expect(validate(entry({ personaPrefx: '打錯字' }))).toBe(false);
  });
});
