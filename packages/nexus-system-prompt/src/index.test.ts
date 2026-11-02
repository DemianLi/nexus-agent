import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertSectionRegistrable,
  composeSystemPromptParts,
  interpolateStrict,
  SECTION_ORDERS,
  SYSTEM_PROMPT_CONTRACT_VERSION,
  SYSTEM_PROMPT_MIDDLEWARE_NAME,
  SystemPromptTemplateError,
  systemPromptToken,
} from './index.js';
import type { SystemPromptAssembly } from './index.js';

const VARIABLES = { model: 'gpt-x', cwd: '/' } as const;

describe('@nexus/system-prompt 的定義', () => {
  it('token 名是 systemPrompt（dsh 的服務名），契約版本是 semver 常數', () => {
    expect(systemPromptToken).toEqual({
      name: 'systemPrompt',
      version: SYSTEM_PROMPT_CONTRACT_VERSION,
    });
    expect(SYSTEM_PROMPT_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('SECTION_ORDERS 數值照 dsh，只放用到的三格', () => {
    expect(SECTION_ORDERS).toEqual({
      HARNESS_IDENTITY: -1000,
      DEPLOYMENT_PERSONA_PREFIX: 0,
      DEPLOYMENT_PERSONA_SUFFIX: 10200,
    });
    expect(SYSTEM_PROMPT_MIDDLEWARE_NAME).toBe('nexusSystemPrompt');
  });
});

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
    for (const bad of ['{{Model}}', '{{}}', '{{ model }}', '{{a-b}}', '{{1x}}', '{{a b}}']) {
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

const IDENTITY = 'You are an AI agent powered by nexus-agent.';

function assembly(over: Partial<SystemPromptAssembly> = {}): SystemPromptAssembly {
  return {
    sections: [
      { name: 'harness:identity', order: SECTION_ORDERS.HARNESS_IDENTITY, text: IDENTITY },
      {
        name: 'deployment:persona-prefix',
        order: SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX,
        text: '前綴 {{model}}',
      },
      {
        name: 'deployment:persona-suffix',
        order: SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX,
        text: '後綴 {{cwd}}',
      },
    ],
    variables: ['model', 'cwd'],
    ...over,
  };
}

describe('前後段的組法', () => {
  it('身分句在前綴前面，中間隔一個空行；後綴自己一段', () => {
    expect(composeSystemPromptParts(assembly(), VARIABLES)).toEqual({
      head: `${IDENTITY}\n\n前綴 gpt-x`,
      tail: '後綴 /',
    });
  });

  it('空的段落不佔位：前綴空時身分句後面不留空行，全空時兩頭都是空字串', () => {
    const emptyPrefix = assembly({
      sections: assembly().sections.map((s) =>
        s.name === 'deployment:persona-prefix' ? { ...s, text: '' } : s,
      ),
    });
    expect(composeSystemPromptParts(emptyPrefix, VARIABLES).head).toBe(IDENTITY);
    expect(composeSystemPromptParts({ sections: [], variables: [] }, {})).toEqual({
      head: '',
      tail: '',
    });
  });

  it('只有快照登記過的名字可用：值表裡多出來的不算，錯誤訊息指名那一格', () => {
    const narrow = assembly({ variables: ['model'] });
    expect(() =>
      composeSystemPromptParts(narrow, VARIABLES, { 'deployment:persona-suffix': 'personaSuffix' }),
    ).toThrow(/personaSuffix.*\{\{cwd\}\}.*可用的變數：model/u);
  });

  it('登記了名字但這一次沒有值：在那次呼叫拋', () => {
    expect(() => composeSystemPromptParts(assembly(), { cwd: '/' })).toThrow(
      /\{\{model\}\}.*沒有值/u,
    );
  });
});

describe('登記時大聲拒絕第一刀不支援的', () => {
  const ok = { name: 'x', order: SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX, text: '字' };

  it('合法的：頭端、尾端與邊界值', () => {
    for (const order of [-1000, -1, 0, 10200, 99999]) {
      expect(() => assertSectionRegistrable({ ...ok, order })).not.toThrow();
    }
  });

  it('order 落在前綴與後綴之間（含邊界外一格）', () => {
    for (const order of [1, 500, 2400, 10199]) {
      expect(() => assertSectionRegistrable({ ...ok, order }), String(order)).toThrow(
        /落在前綴.*之間/u,
      );
    }
  });

  it('函式型的 text', () => {
    expect(() => assertSectionRegistrable({ ...ok, text: () => '字' })).toThrow(/text 是函式/u);
  });

  it('dsh 的 complete、interpolate 欄位', () => {
    expect(() => assertSectionRegistrable({ ...ok, complete: true })).toThrow(/complete/u);
    expect(() => assertSectionRegistrable({ ...ok, interpolate: false })).toThrow(/interpolate/u);
  });

  it('名字空、order 不是有限數字、text 不是字串', () => {
    expect(() => assertSectionRegistrable({ ...ok, name: ' ' })).toThrow(/name/u);
    expect(() => assertSectionRegistrable({ ...ok, order: Number.NaN })).toThrow(/order/u);
    expect(() => assertSectionRegistrable({ ...ok, text: 3 })).toThrow(/text 要是字串/u);
    expect(() => assertSectionRegistrable(null)).toThrow(/物件/u);
  });
});

describe('相依關係', () => {
  it('sdk 放 peer、devDependencies 留 workspace 版本，沒有執行期相依', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.peerDependencies)).toEqual(['@nexus/sdk']);
    expect(pkg.devDependencies['@nexus/sdk']).toBe('workspace:*');
  });

  it('src 沒有 import core 或訊息型別（定義套件只管資料與文字）', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]);
    expect(specifiers).toEqual(['@nexus/sdk']);
  });
});
