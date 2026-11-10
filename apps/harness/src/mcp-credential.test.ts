/** MCP 那一列引用的憑證，值長什麼樣才代入（#2667）。接線（真的起 server）在 `mcp-credentials-wire.test.ts`。 */

import { describe, expect, it } from 'vitest';

import { InvalidCredentialError } from './api-key.js';
import type { ResolvedCredential } from './credentials.js';
import { assertUsableMcpCredential } from './mcp-credential.js';

const NAME = 'DB_PASSWORD';

function fromFile(value: string): ResolvedCredential {
  return { value, source: 'file', path: '/home/FAKE/.credentials.yaml' };
}

function rejection(value: string, use: 'env' | 'header'): InvalidCredentialError {
  try {
    assertUsableMcpCredential(NAME, fromFile(value), use);
  } catch (error) {
    if (error instanceof InvalidCredentialError) return error;
    throw error;
  }
  throw new Error('沒有拒絕');
}

describe('兩條路都一樣', () => {
  it.each(['env', 'header'] as const)('%s：修掉頭尾的空白與換行', (use) => {
    expect(assertUsableMcpCredential(NAME, fromFile('  FAKE-secret-0001\n'), use)).toBe(
      'FAKE-secret-0001',
    );
  });

  it.each(['env', 'header'] as const)('%s：修完是空的就拒絕，訊息指名來源層', (use) => {
    const error = rejection(' \n\t', use);
    expect(error.message).toContain(
      `${NAME}（來自受管憑證檔 /home/FAKE/.credentials.yaml）是空白的`,
    );
  });
});

describe('env', () => {
  it('中間的空白與非 ASCII 字元照收', () => {
    expect(assertUsableMcpCredential(NAME, fromFile('FAKE 密碼 pass word'), 'env')).toBe(
      'FAKE 密碼 pass word',
    );
  });

  it('NUL 拒絕，訊息不含值', () => {
    const value = 'FAKE-before\0FAKE-after';
    const error = rejection(value, 'env');
    expect(error.message).toContain('NUL');
    expect(error.message).not.toContain('FAKE-before');
    expect(error.message).not.toContain('FAKE-after');
  });
});

describe('header：照 Node http 的規則', () => {
  it.each([
    ['中間的空白', 'FAKE token 0002'],
    ['tab', 'FAKE\ttoken'],
    ['Latin-1', 'FAKE-é-0003'],
  ])('%s 照收', (_, value) => {
    expect(assertUsableMcpCredential(NAME, fromFile(value), 'header')).toBe(value);
  });

  it.each([
    ['CR LF', 'FAKE-head\r\nX-Injected: FAKE-tail'],
    ['LF', 'FAKE-head\nFAKE-tail'],
    ['NUL', 'FAKE-head\0FAKE-tail'],
    ['其他控制字元', 'FAKE-head\u0001FAKE-tail'],
    ['U+00FF 之後的字元', 'FAKE-head中FAKE-tail'],
  ])('%s 拒絕，訊息不含值', (_, value) => {
    const error = rejection(value, 'header');
    expect(error.message).toContain('HTTP header 放不下的字元');
    expect(error.message).not.toContain('FAKE-head');
    expect(error.message).not.toContain('FAKE-tail');
  });
});
