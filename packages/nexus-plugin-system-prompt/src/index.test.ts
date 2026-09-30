/**
 * `@nexus/plugin-system-prompt` 的單元測試（[#720](https://github.com/DemianLi/nexus-agent/issues/720)）：
 * 嚴格插值的每一條出口、前後段的組法、middleware 對請求的改寫、掛載的相依。
 *
 * 走得起一個 agent 的那些（CLI 與 serve 的產品組裝送出的文字、後綴排最後、子代理也帶）在
 * `@nexus/harness` 的 `system-prompt-persona.test.ts`。
 */

import { SystemMessage } from '@langchain/core/messages';
import { createHostServicesPlugin, loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import {
  composeSystemPromptParts,
  createSystemPromptPlugin,
  HARNESS_IDENTITY_SENTENCE,
  interpolateStrict,
  SYSTEM_PROMPT_MIDDLEWARE_NAME,
  SystemPromptTemplateError,
  systemPromptConfigSchema,
} from './index.js';

const VARIABLES = { model: 'gpt-x', cwd: '/' } as const;

describe('嚴格插值', () => {
  it('代入已登記的變數；沒有引用的文字原樣', () => {
    expect(interpolateStrict('用 {{model}} 在 {{cwd}}。', VARIABLES, 'personaPrefix')).toBe(
      '用 gpt-x 在 /。',
    );
    expect(interpolateStrict('沒有引用', VARIABLES, 'personaPrefix')).toBe('沒有引用');
  });

  it('未知的變數拋，訊息指名那一格、那個變數與可用的變數', () => {
    expect(() => interpolateStrict('你好 {{nope}}', VARIABLES, 'personaPrefix')).toThrow(
      /personaPrefix.*\{\{nope\}\}.*model、cwd/u,
    );
  });

  it('登記了卻沒有值的變數也拋', () => {
    expect(() => interpolateStrict('{{model}}', { model: undefined }, 'personaSuffix')).toThrow(
      /personaSuffix.*\{\{model\}\}.*沒有值/u,
    );
  });

  it('不從原型鏈上解析變數', () => {
    expect(() => interpolateStrict('{{constructor}}', {}, 'personaPrefix')).toThrow(
      SystemPromptTemplateError,
    );
    expect(() => interpolateStrict('{{toString}}', {}, 'personaPrefix')).toThrow(/toString/u);
  });

  it('寫壞的引用拋：名字不合規則、空的、內含空白', () => {
    for (const bad of ['{{Model}}', '{{}}', '{{ model }}', '{{a-b}}', '{{1x}}']) {
      expect(() => interpolateStrict(bad, VARIABLES, 'personaPrefix'), bad).toThrow(
        SystemPromptTemplateError,
      );
    }
  });

  it('後面還有 }} 卻不是完整一組，算寫壞', () => {
    expect(() => interpolateStrict('{{model {{cwd}}', VARIABLES, 'personaPrefix')).toThrow(/寫壞/u);
  });

  it('單獨一個 {{ 而後面沒有 }} 是普通的字', () => {
    expect(interpolateStrict('花括號 {{ 沒有收尾', VARIABLES, 'personaPrefix')).toBe(
      '花括號 {{ 沒有收尾',
    );
    // 前面的 `{{` 之後還有收尾的 `}}` 就算寫壞（照 dsh）：不是只要這個位置沒有收尾就行，要整段後面都沒有。
    expect(() => interpolateStrict('{{ 之後才是 {{model}}', VARIABLES, 'personaPrefix')).toThrow(
      /寫壞/u,
    );
  });

  it('代入進去的值不會再被掃一次', () => {
    expect(interpolateStrict('{{model}}', { model: '{{cwd}}', cwd: '/' }, 'personaPrefix')).toBe(
      '{{cwd}}',
    );
  });
});

describe('設定', () => {
  it('三格都選填，回到 dsh 的預設：開身分句、前後綴空', () => {
    expect(systemPromptConfigSchema.parse({})).toEqual({
      includeHarnessIdentity: true,
      personaPrefix: '',
      personaSuffix: '',
    });
  });

  it('多寫的鍵當場擋', () => {
    expect(systemPromptConfigSchema.safeParse({ personaPrefx: '打錯字' }).success).toBe(false);
  });
});

describe('前後段的組法', () => {
  it('身分句在前綴前面，中間隔一個空行；後綴自己一段', () => {
    const parts = composeSystemPromptParts(
      systemPromptConfigSchema.parse({ personaPrefix: '前綴 {{model}}', personaSuffix: '後綴' }),
      VARIABLES,
    );
    expect(parts).toEqual({ head: `${HARNESS_IDENTITY_SENTENCE}\n\n前綴 gpt-x`, tail: '後綴' });
  });

  it('includeHarnessIdentity: false 時身分句不在，空的段落不佔位', () => {
    const parts = composeSystemPromptParts(
      systemPromptConfigSchema.parse({ includeHarnessIdentity: false, personaPrefix: '只有前綴' }),
      VARIABLES,
    );
    expect(parts).toEqual({ head: '只有前綴', tail: '' });
  });

  it('全空時兩頭都是空字串', () => {
    expect(
      composeSystemPromptParts(
        systemPromptConfigSchema.parse({ includeHarnessIdentity: false }),
        VARIABLES,
      ),
    ).toEqual({ head: '', tail: '' });
  });
});

/** 抽出 plugin 掛上去的那顆 middleware 的 `wrapModelCall`。 */
async function mountedWrap(options: Parameters<typeof createSystemPromptPlugin>[0]) {
  const { registry } = await loadPlugins([
    createHostServicesPlugin({ systemPromptVariables: VARIABLES }),
    createSystemPromptPlugin(options),
  ]);
  const entries = registry.middleware.list();
  return {
    entries,
    wrap: (
      entries[0]?.value.middleware as unknown as {
        wrapModelCall: (
          request: Record<string, unknown>,
          handler: (request: Record<string, unknown>) => unknown,
        ) => unknown;
      }
    ).wrapModelCall,
  };
}

/** 把請求交給 middleware，回傳它往下傳的那一份。 */
async function through(
  wrap: Awaited<ReturnType<typeof mountedWrap>>['wrap'],
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

describe('middleware', () => {
  it('掛成一顆 last 的 middleware，名字固定', async () => {
    const { entries } = await mountedWrap({ personaPrefix: '前綴' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value.last).toBe(true);
    expect(entries[0]?.value.prepend).toBe(false);
    expect((entries[0]?.value.middleware as { name?: string }).name).toBe(
      SYSTEM_PROMPT_MIDDLEWARE_NAME,
    );
  });

  it('前綴前置、後綴附加，基座原有的那段在中間', async () => {
    const { wrap } = await mountedWrap({ personaPrefix: '前綴', personaSuffix: '後綴' });
    const next = await through(wrap, { systemMessage: new SystemMessage('基座的指引。') });
    const text = (next['systemMessage'] as SystemMessage).text;
    expect(text).toBe(`${HARNESS_IDENTITY_SENTENCE}\n\n前綴\n\n基座的指引。\n\n後綴`);
  });

  it('系統訊息的內容是區塊陣列時也前置得了，原有的區塊保留', async () => {
    const { wrap } = await mountedWrap({ personaPrefix: '前綴' });
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
    const { wrap } = await mountedWrap({ personaPrefix: '前綴', personaSuffix: '後綴' });
    const next = await through(wrap, { systemPrompt: '原本的字串' });
    expect(next['systemPrompt']).toBe(`${HARNESS_IDENTITY_SENTENCE}\n\n前綴\n\n原本的字串\n\n後綴`);
    expect(next['systemMessage']).toBeUndefined();
  });

  it('沒有任何要加的東西時連 middleware 都不掛', async () => {
    const { registry } = await loadPlugins([
      createHostServicesPlugin({ systemPromptVariables: VARIABLES }),
      createSystemPromptPlugin({ includeHarnessIdentity: false }),
    ]);
    expect(registry.middleware.list()).toEqual([]);
  });
});

describe('掛載', () => {
  it('沒有人提供變數服務就載入失敗，不退到猜的值', async () => {
    await expect(loadPlugins([createSystemPromptPlugin({})])).rejects.toThrow(
      /systemPromptVariables/u,
    );
  });

  it('前綴寫了不存在的變數：掛載當場拋，訊息指名那一格與變數', async () => {
    await expect(
      loadPlugins([
        createHostServicesPlugin({ systemPromptVariables: VARIABLES }),
        createSystemPromptPlugin({ personaPrefix: '你是 {{persona}}' }),
      ]),
    ).rejects.toThrow(/personaPrefix.*\{\{persona\}\}/u);
  });
});
