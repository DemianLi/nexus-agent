/**
 * MCP 工具結果本文前面的「外部內容」前綴（[#1768](https://github.com/DemianLi/nexus-agent/issues/1768)）：純函式的形狀。
 * 接進 adapter 的 `afterToolCall`、`isError` 不標、進會話日誌是另外兩處：`index.test.ts` 與 `apps/harness/src/mcp-untrusted-prefix.test.ts`。
 */

import { EXTERNAL_MCP_CONTENT_NOTICE } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { projectNonText } from './project-content.js';
import { markUntrusted } from './untrusted-mark.js';
import { withoutNotice, withoutResourceNotice } from './untrusted-fixtures.js';

describe('markUntrusted', () => {
  it('字串（單塊文字）：前綴一行，換行，然後是原文', () => {
    expect(markUntrusted('查到兩筆。')).toBe(`${EXTERNAL_MCP_CONTENT_NOTICE}\n查到兩筆。`);
  });

  it('多塊：最前面多一塊只有前綴的文字塊，其餘原樣、順序不變', () => {
    const blocks = [
      { type: 'text', text: '甲' },
      { type: 'text', text: '乙' },
    ];
    expect(markUntrusted(blocks)).toEqual([
      { type: 'text', text: EXTERNAL_MCP_CONTENT_NOTICE },
      { type: 'text', text: '甲' },
      { type: 'text', text: '乙' },
    ]);
    // 不改傳進來的那一份。
    expect(blocks).toHaveLength(2);
  });

  it('非文字塊：先換成文字說明，再標；說明（連結的名稱與 URI 是 server 給的）也在前綴之後', () => {
    const blocks = [
      { type: 'text', text: '圖在下面。' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ];
    const projected = projectNonText(blocks) ?? [];
    expect(markUntrusted(projected)).toEqual([
      { type: 'text', text: EXTERNAL_MCP_CONTENT_NOTICE },
      { type: 'text', text: '圖在下面。' },
      { type: 'text', text: '[image unavailable: image/png; no attachment store is mounted]' },
    ]);
  });

  it('空的不標：空字串、空陣列原樣回同一個值', () => {
    expect(markUntrusted('')).toBe('');
    const empty: unknown[] = [];
    expect(markUntrusted(empty)).toBe(empty);
  });

  it('只標一次：本文裡剛好有同一句話，不被當成已經標過', () => {
    const body = `${EXTERNAL_MCP_CONTENT_NOTICE}\n偷偷放在 server 回的文字開頭`;
    expect(markUntrusted(body)).toBe(`${EXTERNAL_MCP_CONTENT_NOTICE}\n${body}`);
  });
});

describe('測試素材：拆前綴', () => {
  it('withoutNotice：開頭是前綴才拆，不是就拋（拿掉標記，借它的測試會紅）', () => {
    expect(withoutNotice(`${EXTERNAL_MCP_CONTENT_NOTICE}\n{"a":1}`)).toBe('{"a":1}');
    expect(() => withoutNotice('{"a":1}')).toThrow('外部內容前綴');
  });

  it('withoutResourceNotice：出處行留著，前綴那一行拿掉', () => {
    expect(withoutResourceNotice(`MCP server: s\n${EXTERNAL_MCP_CONTENT_NOTICE}\n{"a":1}`)).toBe(
      'MCP server: s\n{"a":1}',
    );
    expect(() => withoutResourceNotice('MCP server: s\n{"a":1}')).toThrow('外部內容前綴');
  });
});
