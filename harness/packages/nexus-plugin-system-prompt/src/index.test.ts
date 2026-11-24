/**
 * `@nexus/plugin-system-prompt` 的單元測試（[#720](https://github.com/DemianLi/nexus-agent/issues/720)、
 * [#1477](https://github.com/DemianLi/nexus-agent/issues/1477)）：設定、掛載當下的驗證、服務的快照語意、一致性套件。
 *
 * 走得起一個 agent 的那些（CLI 與 serve 的產品組裝送出的文字、後綴排最後、子代理也帶）與宿主那顆 middleware 對請求的改寫在
 * `@nexus/harness` 的 `system-prompt-persona.test.ts`、`system-prompt-middleware.test.ts`。
 */

import { Context } from '@nexus/cordis';
import type { Context as CordisContext } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { checkConformance } from '@nexus/sdk';
import {
  SECTION_ORDERS,
  SYSTEM_PROMPT_CONTRACT_VERSION,
  systemPromptToken,
} from '@nexus/system-prompt';
import type { SystemPrompt } from '@nexus/system-prompt';
import { describe, expect, it } from 'vitest';

import * as systemPrompt from './index.js';
import {
  HARNESS_IDENTITY_SENTENCE,
  mount,
  SystemPromptTemplateError,
  systemPromptConfigSchema,
  systemPromptSectionsOf,
} from './index.js';
import type { SystemPromptServiceHandle } from './index.js';

type ServiceOnRoot = SystemPrompt & { provider: string; contractVersion: string };

/** 一棵只有 system-prompt 這一列的樹（設定可換）；回傳樹上取得的服務。 */
async function boot(config: unknown = {}, row = 'system-prompt') {
  const root = new Context();
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, { 'system-prompt': systemPrompt });
  await root.loader.create({ id: row, name: 'cordis:system-prompt', config } as never, null);
  await root.loader.await();
  return {
    root,
    service: root.get(systemPromptToken.name) as ServiceOnRoot | undefined,
    dispose: () => root.fiber.dispose(),
  };
}

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

describe('設定對應的三段', () => {
  it('身分句開著：三段，order 照 dsh；關掉：只剩前後綴（空字串也登記）', () => {
    const full = systemPromptSectionsOf(systemPromptConfigSchema.parse({ personaPrefix: '前' }));
    expect(full.map((section) => [section.name, section.order, section.text])).toEqual([
      ['harness:identity', SECTION_ORDERS.HARNESS_IDENTITY, HARNESS_IDENTITY_SENTENCE],
      ['deployment:persona-prefix', SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX, '前'],
      ['deployment:persona-suffix', SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX, ''],
    ]);
    const bare = systemPromptSectionsOf(
      systemPromptConfigSchema.parse({ includeHarnessIdentity: false }),
    );
    expect(bare.map((section) => section.name)).toEqual([
      'deployment:persona-prefix',
      'deployment:persona-suffix',
    ]);
  });
});

describe('一致性套件：真的 Loader', () => {
  it('system-prompt 全格通過：manifest、匯出形式、載入→卸載後登記與服務都撤掉、沒有必要依賴就直接起來', async () => {
    let latest: SystemPromptServiceHandle | undefined;
    const wrapped = {
      ...systemPrompt,
      // 量的是真的 `mount`（`apply` 就是它）：把它回的把手留下來，residue 讀把手的登記筆數。
      apply(ctx: CordisContext, config: systemPrompt.SystemPromptConfig): void {
        latest = mount(ctx, config);
      },
    };
    const failures = await checkConformance({
      row: 'system-prompt',
      module: wrapped,
      config: { personaPrefix: '你是 {{model}}。', personaSuffix: '在 {{cwd}}。' },
      residue: () => latest?.registrations() ?? 0,
    });
    expect(failures).toEqual([]);
  });
});

describe('掛上之後', () => {
  it('提供 systemPrompt 服務，歸屬是這一列、契約版本是定義套件的', async () => {
    const run = await boot({}, 'system-prompt-row');
    try {
      expect(run.service?.provider).toBe('system-prompt-row');
      expect(run.service?.contractVersion).toBe(SYSTEM_PROMPT_CONTRACT_VERSION);
    } finally {
      await run.dispose();
    }
  });

  it('這一列自己登記 model、cwd 兩個變數名，依這個順序；三段是設定的原文（還沒代入）', async () => {
    const run = await boot({ personaPrefix: '你是 {{model}}。', personaSuffix: '在 {{cwd}}。' });
    try {
      const assembly = await run.service!.assemble();
      expect(assembly.variables).toEqual(['model', 'cwd']);
      expect(assembly.sections).toEqual([
        { name: 'harness:identity', order: -1000, text: HARNESS_IDENTITY_SENTENCE },
        { name: 'deployment:persona-prefix', order: 0, text: '你是 {{model}}。' },
        { name: 'deployment:persona-suffix', order: 10200, text: '在 {{cwd}}。' },
      ]);
    } finally {
      await run.dispose();
    }
  });

  it('**一次掛載一份服務**：兩棵樹各掛一次，兩邊的設定各算各的', async () => {
    const first = await boot({ personaSuffix: '甲' });
    const second = await boot({ personaSuffix: '乙' });
    try {
      const a = await first.service!.assemble();
      const b = await second.service!.assemble();
      expect(a.sections.at(-1)?.text).toBe('甲');
      expect(b.sections.at(-1)?.text).toBe('乙');
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('套一次、服務兩條 thread：同一份服務連續 assemble 兩次，各拿一份獨立的資料，互不影響', async () => {
    const run = await boot({ personaSuffix: '尾' });
    try {
      const one = await run.service!.assemble();
      const two = await run.service!.assemble();
      expect(two).toEqual(one);
      expect(two.sections).not.toBe(one.sections);
      expect(two.sections[0]).not.toBe(one.sections[0]);
    } finally {
      await run.dispose();
    }
  });

  it('快照是資料：列卸載之後，已經拿到的快照仍完整', async () => {
    const run = await boot({ personaPrefix: '前', personaSuffix: '後' });
    const service = run.service!;
    const taken = await service.assemble();
    await run.dispose();
    expect(taken.sections.map((section) => section.text)).toEqual([
      HARNESS_IDENTITY_SENTENCE,
      '前',
      '後',
    ]);
    // 卸載之後再問，登記已隨列撤掉：空的，不是舊資料。
    expect(await service.assemble()).toEqual({ sections: [], variables: [] });
  });

  it('其他列對服務登記的段：隨登記者那一列撤掉，且依 order 排進去', async () => {
    const root = new Context();
    await root.plugin(Loader);
    const guest = {
      name: 'guest',
      inject: { systemPrompt: { range: '^1.0.0' } },
      apply(ctx: CordisContext) {
        (ctx as unknown as { systemPrompt: SystemPrompt }).systemPrompt.section({
          name: 'guest:tail',
          order: SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX + 5,
          text: '客人的尾巴',
        });
      },
    };
    Object.assign(root.loader.builtins, { 'system-prompt': systemPrompt, guest });
    await root.loader.create({ id: 'sp', name: 'cordis:system-prompt', config: {} } as never, null);
    await root.loader.create({ id: 'g', name: 'cordis:guest' } as never, null);
    await root.loader.await();
    try {
      const service = root.get(systemPromptToken.name) as SystemPrompt;
      expect((await service.assemble()).sections.map((section) => section.name)).toEqual([
        'harness:identity',
        'deployment:persona-prefix',
        'deployment:persona-suffix',
        'guest:tail',
      ]);
      await root.loader.resolve('g').fiber?.ctx.fiber.dispose();
      expect((await service.assemble()).sections.map((section) => section.name)).toEqual([
        'harness:identity',
        'deployment:persona-prefix',
        'deployment:persona-suffix',
      ]);
    } finally {
      await root.fiber.dispose();
    }
  });

  it('登記時大聲拒絕：中間的 order、函式型 text、complete／interpolate、重名', async () => {
    const run = await boot({});
    try {
      const service = run.service!;
      expect(() => service.section({ name: 'a', order: 500, text: 'x' })).toThrow(/之間/u);
      expect(() =>
        service.section({ name: 'b', order: 10200, text: (() => 'x') as never }),
      ).toThrow(/函式/u);
      expect(() =>
        service.section({ name: 'c', order: 10200, text: 'x', complete: true } as never),
      ).toThrow(/complete/u);
      expect(() =>
        service.section({ name: 'd', order: 10200, text: 'x', interpolate: false } as never),
      ).toThrow(/interpolate/u);
      expect(() =>
        service.section({ name: 'deployment:persona-suffix', order: 10200, text: 'x' }),
      ).toThrow(/已經登記過/u);
      expect(() => service.variable('model')).toThrow(/已經登記過/u);
      expect(() => service.variable('Bad-Name')).toThrow(/不合規則/u);
    } finally {
      await run.dispose();
    }
  });
});

describe('掛載當下驗', () => {
  async function failureOf(config: unknown): Promise<string> {
    const run = await boot(config);
    try {
      expect(run.service).toBeUndefined();
      const fiber = run.root.loader.resolve('system-prompt').fiber?.ctx.fiber;
      const error = await fiber?.await().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(SystemPromptTemplateError);
      return (error as Error).message;
    } finally {
      await run.dispose();
    }
  }

  it('前綴寫了不存在的變數：那一列起不來，訊息逐字是 #720 的那句', async () => {
    expect(await failureOf({ personaPrefix: '你是 {{modle}}' })).toBe(
      'system-prompt 的 personaPrefix 引用了不存在的變數 "{{modle}}"；可用的變數：model、cwd',
    );
  });

  it('後綴寫壞的引用：指名 personaSuffix 這一格', async () => {
    expect(await failureOf({ personaSuffix: '{{a b}}' })).toBe(
      'system-prompt 的 personaSuffix 有寫壞的變數引用 "{{a b}}"：變數名要符合 /^[a-z][a-z0-9_]*$/u',
    );
  });

  it('壞的設定先驗後建：失敗時 root 上沒有服務', async () => {
    const run = await boot({ personaPrefix: '{{nope}}' });
    try {
      expect(run.root.get(systemPromptToken.name, false)).toBeUndefined();
    } finally {
      await run.dispose();
    }
  });
});
