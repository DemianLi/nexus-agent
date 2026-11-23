/**
 * `tool-resolution.ts` 的三種決定：放行拿掉不放行的名字，覆寫換上定義，加的接在尾端；認不出名字的那一筆都原樣留著。
 * 掛進 middleware 之後模型實際收到什麼，在各顆自己的測試與 `apps/harness/src/tool-catalog.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import {
  addedTools,
  admittedTools,
  originalToolOf,
  overriddenTools,
  toolDescriptionOf,
  toolNameOf,
} from './tool-resolution.js';

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

describe('addedTools', () => {
  it('接在尾端；一筆都不加時回原本那份清單', () => {
    const tools = [read, grep];
    expect(addedTools(tools, { additions: () => [nameless] })).toEqual([read, grep, nameless]);
    expect(addedTools(tools, { additions: () => [] })).toBe(tools);
  });
});

describe('originalToolOf', () => {
  it('換上的定義回最初那顆，換過兩層也一樣；沒換過的原樣', () => {
    const first = overriddenTools([read], { override: () => ({ layer: 1 }) });
    const second = overriddenTools(first, { override: () => ({ layer: 2 }) });
    expect(originalToolOf(first[0])).toBe(read);
    expect(originalToolOf(second[0])).toBe(read);
    expect(originalToolOf(grep)).toBe(grep);
    expect(originalToolOf(undefined)).toBeUndefined();
  });

  it('覆寫回同一個物件：不記成它自己頂替自己', () => {
    const definition = { name: 'read_file' };
    overriddenTools([definition], { override: (tool) => tool });
    expect(originalToolOf(definition)).toBe(definition);
  });
});

describe('toolDescriptionOf', () => {
  it('工具的 description，或 OpenAI 形狀的 function.description', () => {
    expect(toolDescriptionOf({ description: '讀檔' })).toBe('讀檔');
    expect(toolDescriptionOf({ type: 'function', function: { description: '派工' } })).toBe('派工');
    expect(toolDescriptionOf({ name: 'x' })).toBeUndefined();
    expect(toolDescriptionOf(null)).toBeUndefined();
  });
});
