/**
 * 宿主端的 `nexusSystemPrompt` middleware（[#1477](https://github.com/DemianLi/nexus-agent/issues/1477)）：快照怎麼渲染成對模型請求的改寫。
 *
 * 這一組是從 `@nexus/plugin-system-prompt` 的 `index.test.ts` **搬來**的——遷移之前 middleware 是插件自己掛的，那一份測試跟著
 * 渲染搬到宿主；插件那邊只剩「登記了哪些段、驗不驗得過」。斷言逐條照舊（`last`、固定名字、前置後附、區塊陣列、`systemPrompt` 字串、
 * 全空不掛），多出來的是 `{{model}}` 跟著路由標籤走（原本在 `system-prompt-persona.test.ts` 的整機測試裡，這裡補單元層）與「預設值沒交就拋」。
 *
 * 走得起一個 agent 的那些（CLI 與 serve 的產品組裝送出的文字、後綴排最後、子代理也帶）在 `system-prompt-persona.test.ts`，
 * 經樹的接線在 `system-prompt-on-tree.test.ts`。
 */

import { SystemMessage } from '@langchain/core/messages';
import { createRegistry, tagModelRoute } from '@nexus/core';
import {
  HARNESS_IDENTITY_SENTENCE,
  SYSTEM_PROMPT_VARIABLE_NAMES,
  systemPromptConfigSchema,
  systemPromptSectionsOf,
} from '@nexus/plugin-system-prompt';
import type { SystemPromptPluginOptions } from '@nexus/plugin-system-prompt';
import { SystemPromptTemplateError } from '@nexus/system-prompt';
import type { SystemPromptAssembly } from '@nexus/system-prompt';
import { describe, expect, it } from 'vitest';

import {
  applySystemPromptParts,
  createSystemPromptMiddleware,
  systemPromptDefaultsEntry,
  systemPromptDefaultsOf,
} from './system-prompt-middleware.js';

const DEFAULTS = { model: 'gpt-x', cwd: '/' } as const;

/** 插件在樹上登記的那份快照（三格都在、變數是 `model`、`cwd`）。 */
function assemblyOf(options: SystemPromptPluginOptions): SystemPromptAssembly {
  return {
    sections: systemPromptSectionsOf(systemPromptConfigSchema.parse(options)),
    variables: SYSTEM_PROMPT_VARIABLE_NAMES,
  };
}

type Wrap = (
  request: Record<string, unknown>,
  handler: (request: Record<string, unknown>) => unknown,
) => unknown;

function wrapOf(options: SystemPromptPluginOptions): {
  readonly wrap: Wrap;
  readonly name: string | undefined;
} {
  const middleware = createSystemPromptMiddleware(assemblyOf(options), DEFAULTS);
  if (middleware === undefined) throw new Error('預期要掛 middleware');
  return {
    wrap: (middleware as unknown as { wrapModelCall: Wrap }).wrapModelCall,
    name: middleware.name,
  };
}

/** 把請求交給 middleware，回傳它往下傳的那一份。 */
async function through(
  wrap: Wrap,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> | undefined;
  await wrap(request, (next) => {
    seen = next;
    return undefined;
  });
  if (seen === undefined) throw new Error('middleware 沒有把請求往下傳');
  return seen;
}

describe('middleware（從插件搬來）', () => {
  it('名字固定為 nexusSystemPrompt', () => {
    expect(wrapOf({ personaPrefix: '前綴' }).name).toBe('nexusSystemPrompt');
  });

  it('前綴前置、後綴附加，基座原有的那段在中間', async () => {
    const { wrap } = wrapOf({ personaPrefix: '前綴', personaSuffix: '後綴' });
    const next = await through(wrap, { systemMessage: new SystemMessage('基座的指引。') });
    const text = (next['systemMessage'] as SystemMessage).text;
    expect(text).toBe(`${HARNESS_IDENTITY_SENTENCE}\n\n前綴\n\n基座的指引。\n\n後綴`);
  });

  it('系統訊息的內容是區塊陣列時也前置得了，原有的區塊保留', async () => {
    const { wrap } = wrapOf({ personaPrefix: '前綴' });
    const original = new SystemMessage({
      content: [
        { type: 'text', text: '第一塊' },
        { type: 'text', text: '第二塊' },
      ],
    });
    const next = await through(wrap, { systemMessage: original });
    const content = (next['systemMessage'] as SystemMessage).content as { text: string }[];
    expect(content.map((block) => block.text)).toEqual([
      `${HARNESS_IDENTITY_SENTENCE}\n\n前綴\n\n`,
      '第一塊',
      '第二塊',
    ]);
  });

  it('請求沒有 systemMessage 時走 systemPrompt 這個字串欄位，而且不同時改兩個', async () => {
    const { wrap } = wrapOf({ personaPrefix: '前綴', personaSuffix: '後綴' });
    const next = await through(wrap, { systemPrompt: '原本的字串' });
    expect(next['systemPrompt']).toBe(`${HARNESS_IDENTITY_SENTENCE}\n\n前綴\n\n原本的字串\n\n後綴`);
    expect(next['systemMessage']).toBeUndefined();
  });

  it('有 systemMessage 時不碰 systemPrompt 字串欄位', async () => {
    const { wrap } = wrapOf({ personaPrefix: '前綴' });
    const next = await through(wrap, {
      systemMessage: new SystemMessage('訊息'),
      systemPrompt: '字串',
    });
    expect(next['systemPrompt']).toBe('字串');
  });

  it('只有後段時不動前面；只有前段時不動後面', () => {
    const base = { systemMessage: new SystemMessage('中') };
    const tailOnly = applySystemPromptParts(base, { head: '', tail: '尾' });
    expect(tailOnly.systemMessage.text).toBe('中\n\n尾');
    const headOnly = applySystemPromptParts(base, { head: '頭', tail: '' });
    expect(headOnly.systemMessage.text).toBe('頭\n\n中');
  });

  it('代入之後頭尾都是空的：連 middleware 都不掛', () => {
    expect(
      createSystemPromptMiddleware(assemblyOf({ includeHarnessIdentity: false }), DEFAULTS),
    ).toBeUndefined();
  });

  it('頭尾都空是看代入之後的結果，不是看有沒有這幾段：段還在、文字全空一樣不掛', () => {
    const assembly = assemblyOf({ includeHarnessIdentity: false });
    // 三格以內的兩格（前後綴）登記著，只是文字是空的
    expect(assembly.sections.map((section) => section.text)).toEqual(['', '']);
    expect(createSystemPromptMiddleware(assembly, DEFAULTS)).toBeUndefined();
  });
});

describe('{{model}} 與 {{cwd}}', () => {
  const opts = { personaPrefix: '你是 {{model}}，在 {{cwd}}', personaSuffix: '收尾 {{model}}' };

  it('沒有路由標籤的模型：用組裝時定的那份', async () => {
    const { wrap } = wrapOf(opts);
    const next = await through(wrap, { systemMessage: new SystemMessage('基座'), model: {} });
    const text = (next['systemMessage'] as SystemMessage).text;
    expect(text).toContain('你是 gpt-x，在 /');
    expect(text.endsWith('收尾 gpt-x')).toBe(true);
  });

  it('貼了路由標籤的模型：{{model}} 跟著那一步實際用的模型走，{{cwd}} 不變', async () => {
    const { wrap } = wrapOf(opts);
    const other = tagModelRoute({}, { model: 'other-model' });
    const next = await through(wrap, { systemMessage: new SystemMessage('基座'), model: other });
    const text = (next['systemMessage'] as SystemMessage).text;
    expect(text).toContain('你是 other-model，在 /');
    expect(text.endsWith('收尾 other-model')).toBe(true);
  });

  it('標籤與組裝時的 id 相同：不重算，直接用原本那份', async () => {
    const { wrap } = wrapOf(opts);
    const same = tagModelRoute({}, { model: 'gpt-x' });
    const next = await through(wrap, { systemMessage: new SystemMessage('基座'), model: same });
    expect((next['systemMessage'] as SystemMessage).text).toContain('你是 gpt-x，在 /');
  });

  it('同一個 id 重複出現：算一次（結果相同）', async () => {
    const { wrap } = wrapOf(opts);
    const other = tagModelRoute({}, { model: 'other-model' });
    const a = await through(wrap, { systemMessage: new SystemMessage('x'), model: other });
    const b = await through(wrap, { systemMessage: new SystemMessage('x'), model: other });
    expect((a['systemMessage'] as SystemMessage).text).toBe(
      (b['systemMessage'] as SystemMessage).text,
    );
  });

  it('快照上有、值表沒有的變數名：那一次呼叫拋，訊息是「沒有值」', () => {
    const assembly: SystemPromptAssembly = {
      sections: [{ name: 'x', order: 0, text: '{{extra}}' }],
      variables: ['model', 'cwd', 'extra'],
    };
    expect(() => createSystemPromptMiddleware(assembly, DEFAULTS)).toThrow(
      SystemPromptTemplateError,
    );
    expect(() => createSystemPromptMiddleware(assembly, DEFAULTS)).toThrow(/extra/u);
  });
});

describe('預設值的交接', () => {
  it('條目在 apply 時記在這次組裝的 registry 上，讀回同一份', () => {
    const registry = createRegistry();
    const entry = systemPromptDefaultsEntry({ model: 'm', cwd: '/w' });
    entry.plugin.apply(registry, entry.config as never);
    expect(systemPromptDefaultsOf(registry)).toEqual({ model: 'm', cwd: '/w' });
  });

  it('兩次組裝各讀各的', () => {
    const a = createRegistry();
    const b = createRegistry();
    const first = systemPromptDefaultsEntry({ model: 'a', cwd: '/' });
    const second = systemPromptDefaultsEntry({ model: 'b', cwd: '/' });
    first.plugin.apply(a, first.config as never);
    second.plugin.apply(b, second.config as never);
    expect(systemPromptDefaultsOf(a)?.model).toBe('a');
    expect(systemPromptDefaultsOf(b)?.model).toBe('b');
  });

  it('組裝點沒交：讀回 undefined（registerFolded 會把這當成組裝錯誤，不退到猜的值）', () => {
    expect(systemPromptDefaultsOf(createRegistry())).toBeUndefined();
  });
});
