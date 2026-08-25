import { describe, expect, it } from 'vitest';
import { CapabilitySet, NamedEntries } from './entries.js';
import type { PluginOrigin } from './plugin.js';

const a: PluginOrigin = { index: 0, name: 'a' };
const b: PluginOrigin = { index: 1, name: 'b' };

function entries(): NamedEntries<string> {
  return new NamedEntries<string>(
    (name, existing, incoming) =>
      new Error(`"${name}" 撞了：${existing.name} 對上 ${incoming.name}`),
  );
}

describe('NamedEntries', () => {
  it('保留插入順序', () => {
    const table = entries();
    table.insert('z', 'Z', a);
    table.insert('m', 'M', a);
    table.insert('c', 'C', b);
    expect([...table.entries()].map(([name]) => name)).toEqual(['z', 'm', 'c']);
  });

  it('同名插入用呼叫端給的訊息報錯，訊息帶得到雙方', () => {
    const table = entries();
    table.insert('x', 'first', a);
    expect(() => table.insert('x', 'second', b)).toThrow('"x" 撞了：a 對上 b');
  });

  it('每一筆記得是誰註冊的', () => {
    const table = entries();
    table.insert('x', 'v', b);
    expect(table.get('x')?.origin).toEqual(b);
  });

  it('撤銷是冪等的', () => {
    const table = entries();
    const undo = table.insert('x', 'v', a);
    undo();
    undo();
    expect(table.get('x')).toBeUndefined();
    expect(table.size).toBe(0);
  });

  it('撤銷後名字真的空出來，不留墓碑佔名', () => {
    const table = entries();
    const undo = table.insert('x', 'first', a);
    undo();
    expect(() => table.insert('x', 'second', b)).not.toThrow();
    expect(table.get('x')?.value).toBe('second');
  });

  it('撤銷只移除自己那一筆，不誤刪後來占用同名的別人', () => {
    const table = entries();
    const undo = table.insert('x', 'first', a);
    undo();
    table.insert('x', 'second', b);
    undo(); // 已經失效的 undo 再叫一次
    expect(table.get('x')?.value).toBe('second');
  });
});

describe('CapabilitySet', () => {
  it('重複提供同一個能力不報錯，兩個提供者都記著', () => {
    const set = new CapabilitySet();
    expect(() => {
      set.provide('fs', a);
      set.provide('fs', b);
    }).not.toThrow();
    expect(set.providers('fs')).toEqual([a, b]);
  });

  it('撤銷其中一個提供者，能力還在', () => {
    const set = new CapabilitySet();
    const undoA = set.provide('fs', a);
    set.provide('fs', b);
    undoA();
    expect(set.has('fs')).toBe(true);
    expect(set.providers('fs')).toEqual([b]);
  });

  it('最後一個提供者撤銷後能力才消失', () => {
    const set = new CapabilitySet();
    const undo = set.provide('fs', a);
    undo();
    expect(set.has('fs')).toBe(false);
    expect(set.names()).toEqual([]);
  });

  it('同一個 plugin 提供兩次要撤銷兩次才消失', () => {
    const set = new CapabilitySet();
    const first = set.provide('fs', a);
    const second = set.provide('fs', a);
    first();
    expect(set.has('fs')).toBe(true);
    second();
    expect(set.has('fs')).toBe(false);
  });
});
