/**
 * **型錄的推理強度宣告驗證**——[#1561](https://github.com/DemianLi/nexus-agent/issues/1561)（N0448）。
 *
 * 照 dsh `resolveModelReasoning` 的前三條（`packages/llm/llm-pi-ai/src/catalog.ts:741-756`，`687f282e`）：空 dict、`off` 以外的等級沒有線上的寫法、
 * 值是空字串，三種都在載入時拒收，訊息指名是哪一顆模型的哪一級。以前這三種都靜靜收下：`{}` 讓 `selectableEfforts` 回空清單，選單上不出現強度，
 * 也看不出是設定寫錯。
 *
 * **不搬第四條（「`off` 以外至少一級」）**：nexus 裡 `default` 是隱含的等級，`{ off: null }` 是有意義的宣告，所以它要照常過，
 * 而且 `selectableEfforts` 回 `['off']`（見 `model-selection-host.ts` 開頭那一條已登記的差異）。
 *
 * 照常過的那一組**用產品實際載入的設定跑**（`loadDefaultPlugins`，CLI 與 serve 兩份出廠清單），不另抄一份。
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { DEFAULT_LIVE_MODEL_ENTRY, DEFAULT_LIVE_MODEL_ID } from './live-model.js';
import { modelCatalogSchema, modelEntrySchema } from './model-catalog.js';
import { selectableEfforts } from './model-selection-host.js';
import { loadDefaultPlugins } from './plugin-config.js';
import {
  liveModelConfigForModel,
  liveModelConfigSchema,
  liveModelPlugin,
} from './settings/live-model.js';
import { startupSetting } from './settings/startup.js';

const ID = 'nexus-test/reasoning-model';

/** 一筆合格條目，`reasoningEfforts` 換成 `efforts`（`undefined` 就是整格不寫）。 */
function entryWith(efforts: unknown): Record<string, unknown> {
  return {
    id: ID,
    contextWindow: 32_768,
    maxTokens: 4096,
    ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
  };
}

/** 解析失敗時每一條問題的訊息（一行一條）；沒拋就讓測試紅。 */
function failureOf(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
    }
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('應該解析失敗，卻過了');
}

describe('reasoningEfforts：寫錯的宣告在載入時拒收，指名哪一顆的哪一級', () => {
  it.each([
    ['空 dict', {}, /reasoningEfforts 是空的/],
    ['非 off 的等級沒有線上的寫法', { low: null }, /reasoningEfforts\.low 沒有線上的寫法/],
    [
      'default 也一樣（只有 off 可以留空）',
      { off: null, default: null },
      /reasoningEfforts\.default 沒有線上的寫法/,
    ],
    ['值是空字串', { low: '' }, /reasoningEfforts\.low 不能是空字串/],
    ['off 寫成空字串（null 才是沒有寫法）', { off: '' }, /reasoningEfforts\.off 不能是空字串/],
  ] as const)('%s', (_name, efforts, expected) => {
    for (const parse of [
      () => modelEntrySchema.parse(entryWith(efforts)),
      () => liveModelConfigSchema.parse({ models: [entryWith(efforts)] }),
    ]) {
      const message = failureOf(parse);
      expect(message).toContain(`"${ID}"`);
      expect(message).toMatch(expected);
    }
  });

  it('多個等級壞掉時一起指名，不只報第一個', () => {
    const message = failureOf(() => modelEntrySchema.parse(entryWith({ low: null, high: '' })));
    expect(message).toMatch(/reasoningEfforts\.low/);
    expect(message).toMatch(/reasoningEfforts\.high/);
  });

  it('型錄裡壞的是第二筆：路徑指到那一筆，訊息指名那一顆', () => {
    const good = entryWith({ off: null });
    const bad = { ...entryWith({ low: '' }), id: 'nexus-test/second' };
    const message = failureOf(() => modelCatalogSchema.parse([good, bad]));
    expect(message).toContain('"nexus-test/second"');
    expect(message).not.toContain(`"${ID}"`);
  });
});

describe('reasoningEfforts：合格的宣告照常過', () => {
  it.each([
    ['整格不寫', undefined],
    ['false（這顆不推理）', false],
    ['{ off: null }（第四條不搬：可以關、預設照模型自己的）', { off: null }],
    ['出廠那一筆的寫法', { off: null, default: 'default' }],
    ['有線上寫法的等級', { low: 'low', high: 'high' }],
  ] as const)('%s', (_name, efforts) => {
    expect(() => modelEntrySchema.parse(entryWith(efforts))).not.toThrow();
  });

  it('{ off: null } 的可選等級是 off（把第四條也搬進來，這一條就會連帶變紅）', () => {
    const entry = modelEntrySchema.parse(entryWith({ off: null }));
    expect(selectableEfforts(entry)).toEqual(['off']);
  });

  it('出廠預設那一筆與 liveModelConfigForModel 合成的條目都過', () => {
    expect(() => modelEntrySchema.parse(DEFAULT_LIVE_MODEL_ENTRY)).not.toThrow();
    for (const model of [DEFAULT_LIVE_MODEL_ID, 'some/other-model']) {
      const config = liveModelConfigForModel(model);
      expect(() => liveModelConfigSchema.parse(config)).not.toThrow();
      expect(() => modelCatalogSchema.parse(config.models)).not.toThrow();
    }
  });

  it.each([
    ['CLI', false],
    ['serve', true],
  ] as const)('產品實際載入的出廠設定（%s）每一筆條目都過', async (_name, serve) => {
    const { plugins } = await loadDefaultPlugins({ env: {}, serve });
    const { models } = startupSetting(plugins, liveModelPlugin);

    expect(() => modelCatalogSchema.parse(models)).not.toThrow();
    // 前提：出廠設定裡真的有宣告了推理等級的條目，不然上面那句只是在驗一份沒有推理宣告的型錄。
    expect(models.some((entry) => typeof entry.reasoningEfforts === 'object')).toBe(true);
  });
});
