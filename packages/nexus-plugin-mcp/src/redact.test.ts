import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRedactor, NO_REDACTION, PLACEHOLDER } from './redact.js';

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
