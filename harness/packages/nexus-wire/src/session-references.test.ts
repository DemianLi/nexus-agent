import { describe, expect, it } from 'vitest';

import {
  decodeSessionReferenceUri,
  encodeSessionReferenceUri,
  formatSessionReferenceMention,
  parseSessionReferenceText,
  SESSION_REFERENCE_SCHEME,
  SessionReferenceError,
  sessionReferencesPath,
} from './session-references.js';

describe('引用網址', () => {
  it.each(['cli', 'thread/子代理-1', '含空白 和 "引號"', '😀 emoji', '', 'a'.repeat(300)])(
    '編了再解得回原來的 id：%j',
    (id) => {
      const uri = encodeSessionReferenceUri(id);
      expect(uri.startsWith(SESSION_REFERENCE_SCHEME)).toBe(true);
      expect(uri).toMatch(/^nexus-session:[A-Za-z0-9_-]+$/u);
      expect(decodeSessionReferenceUri(uri)).toBe(id);
    },
  );

  it('不是正規形式的都拒絕：別的 scheme、空的、非 base64url、解出來不是字串、多餘的補齊、壞的 UTF-8', () => {
    const good = encodeSessionReferenceUri('abc');
    const payload = good.slice(SESSION_REFERENCE_SCHEME.length);
    const asBase64Url = (text: string) => Buffer.from(text).toString('base64url');
    for (const bad of [
      'dsh-session:' + payload,
      SESSION_REFERENCE_SCHEME,
      `${SESSION_REFERENCE_SCHEME}${payload}=`,
      `${SESSION_REFERENCE_SCHEME}${payload}!`,
      `${SESSION_REFERENCE_SCHEME}${asBase64Url('123')}`,
      `${SESSION_REFERENCE_SCHEME}${asBase64Url('{"a":1}')}`,
      // 同一個 id 的另一種編法（JSON 多一個跳脫）：解得出來但不是正規形式。
      `${SESSION_REFERENCE_SCHEME}${asBase64Url('"\\u0061bc"')}`,
      `${SESSION_REFERENCE_SCHEME}${Buffer.from([0x22, 0xff, 0xfe, 0x22]).toString('base64url')}`,
    ]) {
      expect(() => decodeSessionReferenceUri(bad), bad).toThrow(SessionReferenceError);
    }
    try {
      decodeSessionReferenceUri('nope');
    } catch (error) {
      expect((error as SessionReferenceError).code).toBe('SESSION_REFERENCE_INVALID_REFERENCE');
    }
  });
});

describe('引用文字', () => {
  it('mention 的標題跳脫 ] 與 \\，解析時還原', () => {
    const mention = formatSessionReferenceMention({ sessionId: 's/1', label: '查 [x]\\y' });
    expect(mention).toBe(`@[查 [x\\]\\\\y](${encodeSessionReferenceUri('s/1')})`);
    expect(parseSessionReferenceText(mention)).toEqual({
      text: '@查 [x]\\y',
      references: [{ sessionId: 's/1', label: '查 [x]\\y' }],
    });
  });

  it('沒給標題就用 id', () => {
    expect(formatSessionReferenceMention({ sessionId: 'abc' })).toBe(
      `@[abc](${encodeSessionReferenceUri('abc')})`,
    );
  });

  it('文字裡的每一段換成 @標題，依出現先後收；光禿禿的網址也認，標題是 id', () => {
    const a = formatSessionReferenceMention({ sessionId: 'a', label: '甲' });
    const b = formatSessionReferenceMention({ sessionId: 'b', label: '乙' });
    const bare = encodeSessionReferenceUri('c');
    expect(parseSessionReferenceText(`看 ${a} 跟 ${b}，再比 ${a} 還有 ${bare}。`)).toEqual({
      text: '看 @甲 跟 @乙，再比 @甲 還有 @c。',
      references: [
        { sessionId: 'a', label: '甲' },
        { sessionId: 'b', label: '乙' },
        { sessionId: 'a', label: '甲' },
        { sessionId: 'c', label: 'c' },
      ],
    });
  });

  it('沒有引用的文字原樣回來；明寫的網址壞了整個拒絕', () => {
    expect(parseSessionReferenceText('普通的 @file 與 nexus-session 字樣')).toEqual({
      text: '普通的 @file 與 nexus-session 字樣',
      references: [],
    });
    expect(() => parseSessionReferenceText('@[x](nexus-session:@@@)')).toThrow(
      SessionReferenceError,
    );
    expect(() => parseSessionReferenceText('@[x](nexus-session:YWJj)')).toThrow(
      SessionReferenceError,
    );
  });
});

describe('sessionReferencesPath', () => {
  it('掛在 thread 底下，id 編碼', () => {
    expect(sessionReferencesPath('t 1/x')).toBe('/threads/t%201%2Fx/session-references');
  });
});
