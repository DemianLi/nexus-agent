/**
 * `tool-resolution.ts` 的兩種決定：放行拿掉不放行的名字，覆寫換上定義；認不出名字的那一筆都原樣留著。
 * 掛進 middleware 之後模型實際收到什麼，在各顆自己的測試與 `apps/harness/src/tool-catalog.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { admittedTools, overriddenTools, toolNameOf } from './tool-resolution.js';

const read = { name: 'read_file' };
const grep = { name: 'grep' };
const nameless = { description: '沒有名字' };

describe('admittedTools', () => {
  it('拿掉不放行的，認不出名字的留著，先後不變', () => {
    expect(admittedTools([read, nameless, grep], { admits: (name) => name !== 'grep' })).toEqual([
      read,
      nameless,
    ]);
  });
});

describe('overriddenTools', () => {
  it('只換覆寫回了定義的那幾筆，其餘是同一個物件', () => {
    const swapped = { name: 'read_file', swapped: true };
    const result = overriddenTools([read, grep, nameless], {
      override: (_tool, name) => (name === 'read_file' ? swapped : undefined),
    });
    expect(result).toEqual([swapped, grep, nameless]);
    expect(result[1]).toBe(grep);
  });

  it('一筆都不換：回原本那份清單', () => {
    const tools = [read, grep];
    expect(overriddenTools(tools, { override: () => undefined })).toBe(tools);
  });
});

describe('toolNameOf', () => {
  it('只認字串名字', () => {
    expect(toolNameOf(read)).toBe('read_file');
    expect(toolNameOf({ name: 3 })).toBeUndefined();
    expect(toolNameOf(null)).toBeUndefined();
  });
});
