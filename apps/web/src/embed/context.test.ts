import { describe, expect, it } from 'vitest';

import { parseContext } from './context';

describe('parseContext', () => {
  it('字串當成標籤，物件取 label', () => {
    expect(parseContext('A-12')).toEqual({ label: 'A-12' });
    expect(parseContext({ label: 'B-07', extra: 1 })).toEqual({ label: 'B-07' });
  });

  it('null、undefined、空字串是清掉', () => {
    expect(parseContext(null)).toBeUndefined();
    expect(parseContext(undefined)).toBeUndefined();
    expect(parseContext('')).toBeUndefined();
  });

  it('其餘的不收', () => {
    expect(parseContext(42)).toBe('invalid');
    expect(parseContext({ label: '' })).toBe('invalid');
    expect(parseContext({ name: 'A' })).toBe('invalid');
    expect(parseContext('  ')).toBe('invalid');
    expect(parseContext({ label: '\n\t' })).toBe('invalid');
  });
});
