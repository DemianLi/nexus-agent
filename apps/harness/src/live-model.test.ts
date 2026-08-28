import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LIVE_API_KEY_ENV,
  LIVE_BASE_URL,
  LIVE_MODEL_ID,
  LIVE_TIMEOUT_MS,
  createLiveModel,
} from './live-model.js';
import { ALL_MODELS_UNDER_TEST } from './eval/tiers.js';

/**
 * 這組測試不打真實 API，也不需要任何 key —— CI 不放模型 secret（issue #31）。
 * 驗的是 issue #31 第 4 項驗收裡「型別檢查攔不到」的那一半：缺 key 要當場失敗。
 */
describe('真實供應商的 key 處理', () => {
  const original = process.env[LIVE_API_KEY_ENV];

  beforeEach(() => {
    delete process.env[LIVE_API_KEY_ENV];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = original;
  });

  it('缺少環境變數時直接失敗，訊息指名缺哪一個', () => {
    expect(() => createLiveModel()).toThrow(LIVE_API_KEY_ENV);
  });

  it('不 fallback 到 OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-be-used';
    try {
      expect(() => createLiveModel()).toThrow(LIVE_API_KEY_ENV);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('有 key 時組出指向 NVIDIA 端點的 model', () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    const model = createLiveModel();
    expect(model.model).toBe(LIVE_MODEL_ID);
    expect(model.clientConfig.baseURL).toBe(LIVE_BASE_URL);
  });

  it('沒給 modelId 時仍是預設的那個 —— cli:live / serve:live / spike:live 走這條', () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    expect(createLiveModel().model).toBe(LIVE_MODEL_ID);
  });

  it('modelId 傳得進去，尺寸比較才換得動模型', () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    for (const tier of ALL_MODELS_UNDER_TEST) {
      const model = createLiveModel(tier.modelId);
      expect(model.model).toBe(tier.modelId);
      // **換掉的只有 model。** 端點與取樣設定跟著變的話，比出來的差異就不只是尺寸。
      expect(model.clientConfig.baseURL).toBe(LIVE_BASE_URL);
      expect(model.temperature).toBe(1);
      expect(model.topP).toBe(0.95);
    }
  });

  it('逾時有上限 —— #57 的失敗模式是永遠不回來，沒有上限就是整輪比較沒有結果', () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    expect(createLiveModel().timeout).toBe(LIVE_TIMEOUT_MS);
    expect(createLiveModel(ALL_MODELS_UNDER_TEST[0]?.modelId).timeout).toBe(LIVE_TIMEOUT_MS);
  });
});
