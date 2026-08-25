/**
 * 三個註冊點的規則：同層報錯、跨層遮蔽、錯誤訊息指得出是誰。
 *
 * 對應 [#29](https://github.com/DemianLi/nexus-agent/issues/29) 的「註冊表原語」驗收。
 * 判準是能不能只靠 registry 的輸入輸出斷言——規則真的產生效果（權限真的擋住、
 * subagent 真的看到那組工具）屬各擴充點落地的 phase。
 */

import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry.js';
import { fakeSubAgent, fakeTool } from './fixtures.js';
import type { PluginOrigin } from './plugin.js';

const first: PluginOrigin = { index: 0, name: 'alpha' };
const second: PluginOrigin = { index: 1, name: 'mcp' };

describe('tools 註冊點', () => {
  it('同層同名報錯，訊息同時指名兩個 plugin 與那個工具名', () => {
    const registry = createRegistry();
    const leaveFirst = registry.enter(first);
    registry.tools.register(fakeTool('search'));
    leaveFirst();

    const leaveSecond = registry.enter(second);
    expect(() => registry.tools.register(fakeTool('search'))).toThrow(
      /plugins\[0\] \(alpha\)[\s\S]*plugins\[1\] \(mcp\)/,
    );
    leaveSecond();
  });

  it('同層同名的錯誤訊息含工具名', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    registry.tools.register(fakeTool('search'));
    expect(() => registry.tools.register(fakeTool('search'))).toThrow('"search"');
    leave();
  });

  it('全域與 subagent 層同名不報錯，該層查找到最近的那個', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    const globalTool = fakeTool('search');
    const scopedTool = fakeTool('search');
    registry.tools.register(globalTool);
    expect(() => registry.tools.register(scopedTool, { scope: 'researcher' })).not.toThrow();
    leave();

    expect(registry.tools.resolve('search')?.value).toBe(globalTool);
    expect(registry.tools.resolve('search', 'researcher')?.value).toBe(scopedTool);
    // 沒註冊過東西的層看到的是全域那個。
    expect(registry.tools.resolve('search', 'writer')?.value).toBe(globalTool);
  });

  it('某一層的有效集合是全域打底、該層同名項覆蓋其上', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    registry.tools.register(fakeTool('search'));
    registry.tools.register(fakeTool('ls'));
    const scopedSearch = fakeTool('search');
    registry.tools.register(scopedSearch, { scope: 'researcher' });
    registry.tools.register(fakeTool('cite'), { scope: 'researcher' });
    leave();

    const effective = registry.tools.effective('researcher');
    expect([...effective.keys()].sort()).toEqual(['cite', 'ls', 'search']);
    expect(effective.get('search')?.value).toBe(scopedSearch);
    expect([...registry.tools.effective().keys()].sort()).toEqual(['ls', 'search']);
  });

  it('subagent 層按名字延遲建立，不驗那個 subagent 存不存在', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    // requires 不排序，靠前的 plugin 本來就可以往靠後的 plugin 才註冊的 subagent 上加工具。
    expect(() => registry.tools.register(fakeTool('cite'), { scope: 'not-yet' })).not.toThrow();
    leave();
    expect(registry.tools.scopes()).toEqual(['not-yet']);
  });

  it('撤銷該層最後一個工具後，那一層不再出現在 scopes()', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    const undo = registry.tools.register(fakeTool('cite'), { scope: 'researcher' });
    expect(registry.tools.scopes()).toEqual(['researcher']);
    undo();
    leave();
    expect(registry.tools.scopes()).toEqual([]);
  });
});

describe('subagents 註冊點', () => {
  it('同名報錯，訊息指名兩個 plugin', () => {
    const registry = createRegistry();
    const leaveFirst = registry.enter(first);
    registry.subagents.register(fakeSubAgent('researcher'));
    leaveFirst();

    const leaveSecond = registry.enter(second);
    expect(() => registry.subagents.register(fakeSubAgent('researcher'))).toThrow(
      /plugins\[0\] \(alpha\)[\s\S]*plugins\[1\] \(mcp\)/,
    );
    leaveSecond();
  });

  it('不同名字各自登記', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    registry.subagents.register(fakeSubAgent('researcher'));
    registry.subagents.register(fakeSubAgent('writer'));
    leave();
    expect([...registry.subagents.entries()].map(([name]) => name)).toEqual([
      'researcher',
      'writer',
    ]);
  });
});

describe('capabilities 註冊點', () => {
  it('同一能力被兩個 plugin 提供不報錯，對照表兩邊都在', () => {
    const registry = createRegistry();
    const leaveFirst = registry.enter(first);
    registry.capabilities.provide('filesystem');
    leaveFirst();

    const leaveSecond = registry.enter(second);
    expect(() => registry.capabilities.provide('filesystem')).not.toThrow();
    leaveSecond();

    expect(registry.capabilities.providers('filesystem')).toEqual([first, second]);
  });
});

describe('註冊者身分', () => {
  it('不在任何 plugin 的 apply 裡就註冊，當場報錯', () => {
    const registry = createRegistry();
    expect(() => registry.tools.register(fakeTool('search'))).toThrow('apply');
    expect(() => registry.subagents.register(fakeSubAgent('r'))).toThrow('apply');
    expect(() => registry.capabilities.provide('fs')).toThrow('apply');
  });

  it('apply 不巢狀執行', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    expect(() => registry.enter(second)).toThrow('plugins[0] (alpha)');
    leave();
    expect(() => registry.enter(second)).not.toThrow();
  });
});
