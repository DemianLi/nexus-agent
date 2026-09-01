/**
 * `commands` 註冊點與它的中繼資料檢查。
 *
 * 對應 [#118](https://github.com/DemianLi/nexus-agent/issues/118)。這個檔案只管
 * **註冊那一半**（誰進得了表、清單長什麼樣）；解析與執行歸
 * `@nexus/plugin-commands`。
 */

import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry.js';
import { normalizeCommandDefinition } from './commands.js';
import type { CommandDefinition } from './commands.js';
import type { PluginOrigin } from './plugin.js';

const first: PluginOrigin = { id: 'alpha#0', name: 'alpha' };
const second: PluginOrigin = { id: 'beta#0', name: 'beta' };

function definition(name: string, description = `${name} 做的事`): CommandDefinition {
  return { name, description, handler: () => ({ kind: 'success' }) };
}

describe('中繼資料在註冊當下就驗', () => {
  it.each([
    ['大寫開頭', 'Plan'],
    ['數字開頭', '1plan'],
    ['帶斜線', '/plan'],
    ['帶空白', 'plan off'],
    ['空字串', ''],
    ['帶點', 'plan.off'],
  ])('%s 的名字進不了表', (_label, name) => {
    expect(() => normalizeCommandDefinition(definition(name))).toThrow(/命令名/);
  });

  it.each([['plan'], ['plan-mode'], ['plan_mode'], ['p2']])('%s 是合法的名字', (name) => {
    expect(normalizeCommandDefinition(definition(name)).definition.name).toBe(name);
  });

  it('description 是空的或只有空白都不收——描述不出來的命令在清單裡等於不存在', () => {
    expect(() => normalizeCommandDefinition(definition('plan', ''))).toThrow(/description/);
    expect(() => normalizeCommandDefinition(definition('plan', '   '))).toThrow(/description/);
  });

  it('handler 不是函式就不收', () => {
    const broken = { name: 'plan', description: '計劃', handler: '不是函式' };
    expect(() => normalizeCommandDefinition(broken as unknown as CommandDefinition)).toThrow(
      /handler/,
    );
  });

  it('input 給了就要有非空的 hint', () => {
    expect(() =>
      normalizeCommandDefinition({ ...definition('plan'), input: { hint: '  ' } }),
    ).toThrow(/hint/);
    expect(
      normalizeCommandDefinition({ ...definition('plan'), input: { hint: '[off]' } }).descriptor
        .input?.hint,
    ).toBe('[off]');
  });

  it('descriptor 帶不出 handler——交出去的清單不該讓別人執行任何東西', () => {
    const { descriptor } = normalizeCommandDefinition(definition('plan'));
    expect('handler' in descriptor).toBe(false);
  });

  it('descriptor 是凍過的', () => {
    const { descriptor } = normalizeCommandDefinition(definition('plan'));
    expect(Object.isFrozen(descriptor)).toBe(true);
  });
});

describe('commands 註冊點', () => {
  it('同名報錯，訊息同時指名兩個 plugin 與那個命令名', () => {
    const registry = createRegistry();
    const leaveFirst = registry.enter(first);
    registry.commands.register(definition('plan'));
    leaveFirst();

    const leaveSecond = registry.enter(second);
    expect(() => registry.commands.register(definition('plan'))).toThrow(
      /alpha#0 \(alpha\)[\s\S]*beta#0 \(beta\)/,
    );
    expect(() => registry.commands.register(definition('plan'))).toThrow('"/plan"');
    leaveSecond();
  });

  it('apply 之外註冊不了——沒有 origin 就指不出重名時是誰', () => {
    const registry = createRegistry();
    expect(() => registry.commands.register(definition('plan'))).toThrow(/只能在 plugin/);
  });

  it('undo 之後名字放得回去', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    const undo = registry.commands.register(definition('plan'));
    expect(registry.commands.find('plan')).toBeDefined();
    undo();
    expect(registry.commands.find('plan')).toBeUndefined();
    expect(() => registry.commands.register(definition('plan'))).not.toThrow();
    leave();
  });

  it('list 依名字排序，不隨註冊順序變動', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    for (const name of ['zed', 'alpha', 'mid']) registry.commands.register(definition(name));
    leave();
    expect(registry.commands.list().map((entry) => entry.name)).toEqual(['alpha', 'mid', 'zed']);
  });

  it('find 回得出 handler，list 回不出', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    registry.commands.register(definition('plan'));
    leave();
    expect(typeof registry.commands.find('plan')?.handler).toBe('function');
    expect(registry.commands.list().every((entry) => !('handler' in entry))).toBe(true);
  });

  it('find 不認得的名字回 undefined', () => {
    expect(createRegistry().commands.find('nope')).toBeUndefined();
  });
});
