import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { ContextOverflowError } from '@langchain/core/errors';
import { ChatOpenAI, wrapOpenAIClientError } from '@langchain/openai';
import {
  LIVE_API_KEY_ENV,
  LIVE_BASE_URL,
  LIVE_MAX_OUTPUT_TOKENS,
  LIVE_MAX_RETRIES,
  LIVE_MODEL_ID,
  LIVE_TIMEOUT_MS,
  classifyFailedAttempt,
  createLiveModel,
  isDerivedContextOverflow,
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

/**
 * **這個端點在上下文溢出時回什麼——2026-09-04 真打抓下來的。**
 *
 * 六次真請求（`openai/gpt-oss-20b`，三種輸入尺寸，送與不送 `max_tokens` 各試），
 * 回的都是這個形狀，只有數字不同。**它不是一句「上下文太長」**：伺服器自己用
 * `上限 − 輸入` 導 `max_tokens`，導成負的就報參數不合法。
 *
 * 一併量到的：`got -N` 的 N 對輸入長度線性（斜率 8/9 token/字元，三點一致），
 * 反解出 `gpt-oss-20b` 的有效上限 131,007 ＝ 131,072（128K）− 約 65 個 chat template overhead。
 */
const CAPTURED_OVERFLOW_BODY = {
  message: 'max_tokens must be at least 1, got -46771. (parameter=max_tokens, value=-46771)',
  type: 'BadRequestError',
  param: 'max_tokens',
  code: 400,
} as const;

/** 供應商錯誤在 SDK 手上的樣子：`param` 攤在頂層，原始 body 掛在 `error`。 */
function providerError(body: Record<string, unknown>): Error {
  return Object.assign(new Error(String(body.message)), {
    status: 400,
    param: body.param,
    error: body,
  });
}

describe('把導出來的負 max_tokens 認成上下文溢出', () => {
  it('真打抓到的那個 body，認得出來', () => {
    expect(isDerivedContextOverflow(providerError({ ...CAPTURED_OVERFLOW_BODY }))).toBe(true);
  });

  /**
   * **承重條：正的數字不是溢出。**
   *
   * 一顆輸出上限比我們送的 `LIVE_MAX_OUTPUT_TOKENS` 小的模型會抱怨同一個 `param`，
   * 而那件事**壓縮救不回來**——誤判成溢出的下場是壓一次、再送、再失敗。
   */
  it('抱怨的是正的 max_tokens 就不算溢出', () => {
    expect(
      isDerivedContextOverflow(
        providerError({
          message:
            'max_tokens must be at most 4096, got 16384. (parameter=max_tokens, value=16384)',
          param: 'max_tokens',
          code: 400,
        }),
      ),
    ).toBe(false);
  });

  /** 包過幾層都要認得——真正到手時它已經過了 SDK 與 middleware 好幾層。 */
  it('埋在 cause 底下照樣認得', () => {
    const buried = new Error('400 Bad Request', {
      cause: providerError({ ...CAPTURED_OVERFLOW_BODY }),
    });
    expect(isDerivedContextOverflow(buried)).toBe(true);
  });

  it('別的 param、或根本不是這種錯，一律不算', () => {
    expect(
      isDerivedContextOverflow(providerError({ message: '壞了', param: 'messages', code: 400 })),
    ).toBe(false);
    expect(isDerivedContextOverflow(new Error('連線斷了'))).toBe(false);
    expect(isDerivedContextOverflow(null)).toBe(false);
  });

  /** 取不到那個數字時**不猜**——寧可漏判維持今天的行為，也不要把別的 400 誤判成溢出。 */
  it('訊息裡沒有數字就不猜', () => {
    expect(
      isDerivedContextOverflow(
        providerError({ message: 'max_tokens is invalid', param: 'max_tokens', code: 400 }),
      ),
    ).toBe(false);
  });

  it('我們送出去的輸出上限是正數——判別式的前提', () => {
    expect(LIVE_MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
  });
});

/**
 * **升版絆索：上游哪天自己認得了，我們那一層就該刪。**
 *
 * `wrapOpenAIClientError`（`@langchain/openai`）是分類的正主——標準那側的規矩是
 * 「溢出分类由适配器维护」（dsh `compaction-basic/README.zh.md:241`），我們只是因為
 * 動不了那支才在工廠裡補一塊。LangChain 補 DeepSeek（`1.3.1`）、LiteLLM 補 Gemini
 * 都是同一種缺口，補上是遲早的事。
 *
 * **這條紅的那天，就是刪掉 {@link isDerivedContextOverflow} 與那行 `onFailedAttempt`
 * 的那天。** 它不是在斷言上游有缺陷，是在標記我們那塊補丁的到期條件。
 */
describe('上游還不認得這個 body（絆索）', () => {
  it('wrapOpenAIClientError 對這個 body 還不回 ContextOverflowError', () => {
    const wrapped = wrapOpenAIClientError(providerError({ ...CAPTURED_OVERFLOW_BODY }));

    expect(ContextOverflowError.isInstance(wrapped)).toBe(false);
  });

  /** 對照組：它認得的那些**現在就**認得——絆索紅的時候要分得出是上游變了還是這條壞了。 */
  it('它認得的措辭現在就認得', () => {
    const known = wrapOpenAIClientError(
      providerError({
        message: "This model's maximum context length is 128000 tokens.",
        code: 400,
      }),
    );

    expect(ContextOverflowError.isInstance(known)).toBe(true);
  });
});

/**
 * **整條鏈走一遍：供應商回那個 400 → 我們手上拿到的是 `ContextOverflowError`。**
 *
 * 這一格量的是**唯一還沒量過的一環**：`AsyncCaller` 到底會不會為一個不可重試的 400 叫
 * `onFailedAttempt`。讀原始碼說會（`async_caller.js:195`，`p-retry` 每次失敗都叫，預設的
 * handler 正是靠「在裡面拋」來實作不重試），但讀到不等於量到。
 *
 * **零憑證、零外部連線**：端點是一個 loopback 上的假伺服器，回的是 2026-09-04 真打抓下來
 * 的那個 body。key 是給假伺服器看的，不是秘密。
 *
 * 接上之後基座那側會發生什麼，由 `context-overflow.test.ts` 量（那邊證了緊急摘要接得住
 * 這個型別，埋在 `cause` 底下也認得）。兩個檔各證一半，合起來才是整條。
 */
describe('假端點回那個 400，到我們手上是 ContextOverflowError', () => {
  let server: Server;
  let baseURL: string;

  beforeEach(async () => {
    server = createServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { ...CAPTURED_OVERFLOW_BODY } }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('拿不到 loopback 埠');
    baseURL = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  /** 用的是 `createLiveModel` 那組設定的**同一支** handler，不是測試自己另寫一份。 */
  function modelAgainstFake(onFailedAttempt?: (error: unknown) => void): ChatOpenAI {
    return new ChatOpenAI({
      apiKey: 'fake-key-for-loopback',
      model: 'openai/gpt-oss-20b',
      configuration: { baseURL },
      maxTokens: LIVE_MAX_OUTPUT_TOKENS,
      maxRetries: LIVE_MAX_RETRIES,
      ...(onFailedAttempt !== undefined && { onFailedAttempt }),
    });
  }

  it('掛上我們的 handler → 拋的是 ContextOverflowError', async () => {
    const caught = await modelAgainstFake(classifyFailedAttempt)
      .invoke('嗨')
      .then(() => null)
      .catch((error: unknown) => error);

    expect(ContextOverflowError.isInstance(caught)).toBe(true);
  });

  /**
   * **對照組：不掛我們那支就認不出來。**
   *
   * 這條證明綠的來源是我們那一層，不是 `@langchain/openai` 或別的地方本來就會做。
   * 它同時是絆索的另一面——上游哪天自己認得了，**這條**會紅。
   */
  it('不掛我們的 handler → 就只是一個普通的 400', async () => {
    const caught = await modelAgainstFake()
      .invoke('嗨')
      .then(() => null)
      .catch((error: unknown) => error);

    expect(caught).not.toBeNull();
    expect(ContextOverflowError.isInstance(caught)).toBe(false);
  });
});
