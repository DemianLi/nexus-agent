// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { obscures } from '@/hooks/use-scroll-button-clearance';

/** 浮鈕壓不壓得到（#1295）。接線（標記、捲動、焦點）在 `components/tool/subagent-control.test.tsx`。 */

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('obscures', () => {
  const button = box(172, 626, 32, 32);

  it('交疊就算壓到', () => {
    expect(obscures(button, [box(141, 606, 70, 44)])).toBe(true);
  });

  it('隔開超過餘裕就沒壓到；貼邊（餘裕以內）也算壓到', () => {
    expect(obscures(button, [box(141, 500, 70, 44)])).toBe(false);
    expect(obscures(button, [box(210, 626, 70, 32)])).toBe(false);
    expect(obscures(button, [box(207, 626, 70, 32)])).toBe(true);
  });

  it('任一個目標壓到就算；沒有目標就沒壓到', () => {
    expect(obscures(button, [box(0, 0, 10, 10), box(180, 640, 10, 10)])).toBe(true);
    expect(obscures(button, [])).toBe(false);
  });
});
