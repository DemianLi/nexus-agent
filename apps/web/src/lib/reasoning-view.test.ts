import { describe, expect, it } from 'vitest';

import { reasoningSummary } from '@/lib/reasoning-view';

describe('reasoningSummary', () => {
  it('講完的是第一行，跳過開頭的空行', () => {
    expect(reasoningSummary('\n\n  first line  \nsecond', false)).toBe('first line');
  });

  it('串流中是最新一行，跳過結尾的空行', () => {
    expect(reasoningSummary('first\nlatest so far\n\n', true)).toBe('latest so far');
  });

  it('只有一行時兩種都是那一行', () => {
    expect(reasoningSummary('only', false)).toBe('only');
    expect(reasoningSummary('only', true)).toBe('only');
  });

  it('拿掉 `**`', () => {
    expect(reasoningSummary('**Plan**: read **both** files', false)).toBe('Plan: read both files');
  });

  it('只有空白時是空字串', () => {
    expect(reasoningSummary(' \n \n', false)).toBe('');
    expect(reasoningSummary(' \n \n', true)).toBe('');
  });
});
