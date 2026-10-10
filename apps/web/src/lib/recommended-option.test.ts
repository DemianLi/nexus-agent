// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { RECOMMENDED_SUFFIX, splitRecommended } from '@/lib/recommended-option';
import { catalogToolSection } from '@/test/tool-catalog';

/** 「（推薦）」字尾（#1306）。 */

describe('splitRecommended', () => {
  it('拆掉全形、半形的字尾與前面的空白', () => {
    expect(splitRecommended('方案甲（推薦）')).toEqual({ text: '方案甲', recommended: true });
    expect(splitRecommended('方案甲 (推薦)')).toEqual({ text: '方案甲', recommended: true });
    expect(splitRecommended('Plan A（推薦） ')).toEqual({ text: 'Plan A', recommended: true });
  });

  it('不在字尾、沒有字尾、整個標籤就是字尾的，原樣不動', () => {
    for (const label of ['（推薦）方案甲', '方案甲', '（推薦）', '推薦']) {
      expect(splitRecommended(label)).toEqual({ text: label, recommended: false });
    }
  });

  it('跟插件要模型加的字尾是同一個（讀工具目錄，插件改說法這裡會紅）', () => {
    expect(catalogToolSection('ask_user_question')).toContain(`「${RECOMMENDED_SUFFIX}」`);
  });
});
