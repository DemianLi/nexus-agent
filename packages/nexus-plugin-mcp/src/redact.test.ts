import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isRequestTimeout } from './connection.js';
import { createRedactor, NO_REDACTION, PLACEHOLDER, scrubbedCopy } from './redact.js';

/** 與 Rust 宿主共用的樣本（唯讀引用，樣本不一致就回報，不在這裡改）。 */
const VECTORS_URL = new URL(
  '../../../native/sandbox-spawner/credentials-vectors.json',
  import.meta.url,
);

interface RedactVector {
  readonly name: string;
  readonly values: readonly string[];
  readonly text: string;
  readonly expect: string;
  readonly scope?: 'result' | 'error';
  readonly absent?: readonly string[];
}

const vectors = (JSON.parse(readFileSync(VECTORS_URL, 'utf8')) as { redact: RedactVector[] })
  .redact;

describe('遮蔽器：同 Rust 宿主的樣本（credentials-vectors.json redact[]）', () => {
  it('樣本不是空的', () => {
    expect(vectors.length).toBeGreaterThan(10);
  });

  for (const vector of vectors) {
    it(vector.name, () => {
      const redactor = createRedactor(vector.values);
      const out =
        vector.scope === 'error'
          ? redactor.scrubText(vector.text)
          : redactor.redactText(vector.text);
      expect(out).toBe(vector.expect);
      for (const secret of vector.absent ?? []) expect(out).not.toContain(secret);
    });
  }
});

describe('遮蔽器：樣本之外的邊界', () => {
  it('沒有值 → 原樣、empty', () => {
    expect(createRedactor([])).toBe(NO_REDACTION);
    expect(createRedactor(['']).empty).toBe(true);
    expect(NO_REDACTION.scrubText('abc')).toBe('abc');
  });

  it('沒命中 → 原文逐位元組不變', () => {
    const text = '完全沒有秘密 {"a":1}';
    const redactor = createRedactor(['FAKE-token-0001']);
    expect(redactor.redactText(text)).toBe(text);
    expect(redactor.scrubText(text)).toBe(text);
  });

  it('補充平面字元的 \\u 代理對形式也遮', () => {
    const redactor = createRedactor(['😀FAKE-0001😀']);
    const escaped = '\\ud83d\\ude00FAKE-0001\\ud83d\\ude00';
    expect(redactor.redactText(`x ${escaped} y`)).toBe(`x ${PLACEHOLDER} y`);
  });
});

describe('scrubbedCopy：遮訊息、保留連線層要讀的欄位', () => {
  const redactor = createRedactor(['FAKE-token-0001']);

  it('訊息被遮；name、status、字串與數字的 code 都留著，cause 與其他屬性不沿用', () => {
    const original = Object.assign(new Error('x FAKE-token-0001 y', { cause: 'FAKE-token-0001' }), {
      name: 'TimeoutError',
      status: 504,
      code: 'REQUEST_TIMEOUT',
      extra: 'FAKE-token-0001',
    });
    const copy = scrubbedCopy(original, redactor);
    expect(copy.message).toBe(`x ${PLACEHOLDER} y`);
    expect(copy).toMatchObject({ name: 'TimeoutError', status: 504, code: 'REQUEST_TIMEOUT' });
    expect(copy.cause).toBeUndefined();
    expect(Object.keys(copy)).not.toContain('extra');
  });

  it('遮過的錯誤連線層仍認得是逾時（工具呼叫逾時要觸發探活）', () => {
    const timeout = Object.assign(new Error('timed out FAKE-token-0001'), {
      code: 'REQUEST_TIMEOUT',
    });
    const wrapped = new Error('Error calling tool t', { cause: scrubbedCopy(timeout, redactor) });
    expect(isRequestTimeout(wrapped)).toBe(true);
    const named = Object.assign(new Error('FAKE-token-0001'), { name: 'TimeoutError' });
    expect(isRequestTimeout(new Error('x', { cause: scrubbedCopy(named, redactor) }))).toBe(true);
  });

  it('不是 Error 的丟出物也遮', () => {
    expect(scrubbedCopy('FAKE-token-0001', redactor).message).toBe(PLACEHOLDER);
  });
});
