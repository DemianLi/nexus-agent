/**
 * 金鑰能不能放進標頭（[#1541](https://github.com/DemianLi/nexus-agent/issues/1541)）。
 *
 * 純函式的表：頭尾空白靜靜修掉，空白、中間的空白／換行、非 ASCII 要講，合法的金鑰字元全部放行。
 */

import { describe, expect, it } from 'vitest';

import { InvalidCredentialError, assertUsableApiKey, normalizeApiKey } from './api-key.js';

describe('normalizeApiKey', () => {
  it.each([
    ['k', 'k'],
    [' k ', 'k'],
    ['\tnvapi-abc\n', 'nvapi-abc'],
    ['\r\nnvapi-abc\r\n', 'nvapi-abc'],
    ['nvapi-ABC_123.~', 'nvapi-ABC_123.~'],
    [
      '!"#$%&\'()*+,-./0123456789:;<=>?@AZ[\\]^_`az{|}~',
      '!"#$%&\'()*+,-./0123456789:;<=>?@AZ[\\]^_`az{|}~',
    ],
  ])('%j → 收下 %j', (raw, value) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: true, value });
  });

  it.each(['', '   ', '\n', '\t \r\n'])('%j → empty', (raw) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: false, reason: 'empty' });
  });

  it.each([
    ['中間空白', 'a b'],
    ['中間換行', 'a\nb'],
    ['中間 tab', 'a\tb'],
    ['Latin-1 字母', 'aé'],
    ['全形括號', 'a（'],
    ['零寬空白', 'a​b'],
    ['頭尾之外的零寬空白（trim 不處理）', '​ab'],
    ['控制字元', 'a\u0001b'],
    ['DEL', 'a\u007Fb'],
  ])('%s → illegalCharacters', (_label, raw) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: false, reason: 'illegalCharacters' });
  });
});

describe('assertUsableApiKey', () => {
  it('合格：回修過頭尾的值', () => {
    expect(assertUsableApiKey('NVIDIA_API_KEY', { value: ' k\n', source: 'env' })).toBe('k');
  });

  it.each([
    ['env' as const, undefined, '啟動環境'],
    ['file' as const, '/h/.credentials.yaml', '/h/.credentials.yaml'],
    ['project-env' as const, '/w/.env', '/w/.env'],
    ['user-env' as const, '/h/.env', '/h/.env'],
  ])('不合格：訊息指名 NVIDIA_API_KEY 與來源層（%s）', (source, path, shown) => {
    const secret = 'SECRETSECRETvalue';
    const hit = { value: `${secret}\n${secret}`, source, ...(path === undefined ? {} : { path }) };
    let thrown: unknown;
    try {
      assertUsableApiKey('NVIDIA_API_KEY', hit);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidCredentialError);
    const error = thrown as InvalidCredentialError;
    expect(error.code).toBe('INVALID_CREDENTIAL');
    expect(error.name).toBe('InvalidCredentialError');
    expect(error.message).toContain('NVIDIA_API_KEY');
    expect(error.message).toContain(shown);
    expect(error.message).not.toContain('SECRET');
  });

  it('空白的值也拒收，且講「空白」不講字元', () => {
    expect(() => assertUsableApiKey('NVIDIA_API_KEY', { value: '  ', source: 'file' })).toThrow(
      /空白/u,
    );
  });
});
