import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LIVE_API_KEY_ENV,
  LIVE_BASE_URL,
  LIVE_MAX_RETRIES,
  LIVE_MODEL_ID,
  LIVE_TIMEOUT_MS,
  createLiveModel,
  retryDecision,
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

  it('預設的那個 id 必須是我們真的量過的模型', () => {
    // **這條擋的是「憑感覺換預設」。** 上一個預設（`deepseek-v4-pro-0813`）從來不是被選出來的，
    // 它是 #57 那個不回應的模型的替代品，唯一判準是「回得出 tool_calls」——一次都沒有被
    // 基準任務量過。現在的這個是 12 次取樣 × 5 階比出來的，這條斷言讓那件事在程式碼裡也成立：
    // 換成一個沒進過 `ALL_MODELS_UNDER_TEST` 的 id，這裡當場紅。
    expect(ALL_MODELS_UNDER_TEST.map((tier) => tier.modelId)).toContain(LIVE_MODEL_ID);
  });

  it('逾時有上限 —— #57 的失敗模式是永遠不回來，沒有上限就是整輪比較沒有結果', () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    expect(createLiveModel().timeout).toBe(LIVE_TIMEOUT_MS);
    expect(createLiveModel(ALL_MODELS_UNDER_TEST[0]?.modelId).timeout).toBe(LIVE_TIMEOUT_MS);
  });

  /**
   * **這條驗的是設定真的到得了重試層，不是我們有沒有寫那一行。**
   *
   * `maxRetries` 與 `onFailedAttempt` 都不是 `ChatOpenAI` 的公開屬性 —— 它們被拿去建
   * `AsyncCaller`。傳錯名字、或哪天基座換了收法，`createLiveModel` 一樣建得起來、
   * 型別一樣是綠的，而重試會**靜默地沒有生效**。所以這裡直接問那個 caller。
   */
  it('重試設定到得了 AsyncCaller —— 不是只寫在建構參數裡', () => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
    const { caller } = createLiveModel() as unknown as {
      caller: { maxRetries: number; onFailedAttempt: (error: unknown) => void };
    };

    expect(caller.maxRetries).toBe(LIVE_MAX_RETRIES);
    expect(LIVE_MAX_RETRIES).toBeGreaterThan(0);

    // 裝上去的必須是**我們的**那個：對限流不拋（＝重試），對 4xx 拋（＝放棄）。
    // 只斷言 `typeof === 'function'` 的話，裝到基座的預設也會是綠的。
    expect(() =>
      caller.onFailedAttempt(Object.assign(new Error('429'), { status: 429 })),
    ).not.toThrow();
    expect(() =>
      caller.onFailedAttempt(Object.assign(new Error('400'), { status: 400 })),
    ).toThrow();
  });
});

/**
 * 重試決策。
 *
 * **這一組是行為表，不是實作細節。** 它釘住的是 `onFailedAttempt` 取代掉基座預設之後，
 * 我們有沒有把預設的形狀維持住 —— 只改「沒有 `retry-after` 的 429」那一支，其餘照舊。
 * 不打真實 API，錯誤都是手工組出來的形狀。
 */
describe('限流的重試決策', () => {
  const withProps = (message: string, props: Record<string, unknown>): Error =>
    Object.assign(new Error(message), props);

  it('沒有 retry-after 的 429 要重試 —— 基座對這個形狀是一次都不重試的', () => {
    expect(retryDecision(withProps('429', { status: 429 }))).toBe('retry');
    // `@langchain/core` 正規化之後掛上的名字。協定上的 status 有時被包掉，名字還在。
    expect(retryDecision(withProps('rate limited', { name: 'RateLimitCapacityError' }))).toBe(
      'retry',
    );
  });

  it('配額耗盡的 429 不重試 —— 它跟限流共用狀態碼，但重試幾次都一樣', () => {
    expect(retryDecision(withProps('quota', { status: 429, code: 'insufficient_quota' }))).toBe(
      'give-up',
    );
    expect(retryDecision(withProps('quota', { name: 'RateLimitQuotaExhaustedError' }))).toBe(
      'give-up',
    );
  });

  it('4xx 不重試 —— 判準對照那個「只支援單筆工具呼叫」重試幾次都一樣', () => {
    for (const status of [400, 401, 402, 403, 404, 405, 406, 407, 409, 413]) {
      expect(retryDecision(withProps(String(status), { status }))).toBe('give-up');
    }
  });

  it('5xx 與連線問題仍然重試 —— 這條擋的是「非限流一律放棄」那種退化', () => {
    // 自訂 onFailedAttempt 會**整個**取代基座的預設，所以很容易在只想改限流時，
    // 順手把本來會重試的那些也關掉。把它改成 give-up，這條當場紅。
    expect(retryDecision(withProps('500', { status: 500 }))).toBe('retry');
    expect(retryDecision(withProps('502', { status: 502 }))).toBe('retry');
    expect(retryDecision(new Error('socket hang up'))).toBe('retry');
  });

  it('中止不重試 —— 那是我們自己要的，重試等於違抗', () => {
    expect(retryDecision(withProps('x', { name: 'AbortError' }))).toBe('give-up');
    expect(retryDecision(new Error('Cancel: 使用者中止'))).toBe('give-up');
    expect(retryDecision(withProps('x', { code: 'ECONNABORTED' }))).toBe('give-up');
  });

  it('包在 cause 鏈深處也認得出來 —— 包裝層數是別人家的實作細節', () => {
    const inner = withProps('429', { status: 429 });
    const outer = new Error('外層', { cause: new Error('中層', { cause: inner }) });
    expect(retryDecision(outer)).toBe('retry');

    const innerBad = withProps('400', { status: 400 });
    const outerBad = new Error('外層', { cause: new Error('中層', { cause: innerBad }) });
    expect(retryDecision(outerBad)).toBe('give-up');
  });
});
