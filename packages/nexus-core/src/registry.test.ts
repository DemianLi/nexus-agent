/**
 * 每個註冊點的規則：同層報錯、跨層遮蔽、錯誤訊息指得出是誰。
 *
 * 對應 [#29](https://github.com/DemianLi/nexus-agent/issues/29) 的「註冊表原語」驗收。
 * 判準是能不能只靠 registry 的輸入輸出斷言——規則真的產生效果（權限真的擋住、
 * subagent 真的看到那組工具）屬各擴充點落地的 phase。
 */

import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry.js';
import { fakeBackend, fakeMiddleware, fakeSink, fakeSubAgent, fakeTool } from './fixtures.js';
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

describe('其餘六個註冊點', () => {
  it('backend 同 routePrefix 報錯，跨前綴不報錯', () => {
    const registry = createRegistry();
    const leaveFirst = registry.enter(first);
    registry.backend.mount('/memories/', fakeBackend('store'));
    expect(() => registry.backend.mount('/workspace/', fakeBackend('disk'))).not.toThrow();
    leaveFirst();

    const leaveSecond = registry.enter(second);
    expect(() => registry.backend.mount('/memories/', fakeBackend('other'))).toThrow(
      '"/memories/"',
    );
    leaveSecond();
    expect(registry.backend.mounts().map(([prefix]) => prefix)).toEqual([
      '/memories/',
      '/workspace/',
    ]);
  });

  it('middleware 記得註冊順序與 prepend 旗標', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    registry.middleware.use(fakeMiddleware('a'));
    registry.middleware.use(fakeMiddleware('b'), { prepend: true });
    leave();
    expect(registry.middleware.list().map((entry) => entry.value.prepend)).toEqual([false, true]);
  });

  it('permissions 是純累加的 deny 清單，同樣的規則兩次也是兩筆', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    registry.permissions.deny(['/.env*']);
    registry.permissions.deny(['/.env*']);
    leave();
    expect(registry.permissions.rules()).toHaveLength(2);
  });

  it('permissions 收下的路徑是複本，呼叫端事後改陣列動不到註冊表', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    const paths = ['/.env*'];
    registry.permissions.deny(paths);
    paths.push('/injected');
    leave();
    expect(registry.permissions.rules()[0]?.value.paths).toEqual(['/.env*']);
  });

  it('interrupts 同一個工具被多方標記不報錯', () => {
    const registry = createRegistry();
    const leaveFirst = registry.enter(first);
    registry.interrupts.require('rm', { reason: '刪檔' });
    leaveFirst();

    const leaveSecond = registry.enter(second);
    expect(() => registry.interrupts.require('rm', { reason: '再一次' })).not.toThrow();
    leaveSecond();
    expect(registry.interrupts.requirements()).toHaveLength(2);
  });

  it('skills 同一來源路徑重複註冊報錯，結尾斜線不算另一個目錄', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    registry.skills.addSource('/skills/user/');
    // 訊息裡是正規化後的目錄（沒有結尾斜線）——重複檢查的 key 就是那一串。
    expect(() => registry.skills.addSource('/skills/user/')).toThrow('"/skills/user"');
    // 少了結尾斜線的同一個目錄照樣撞——這是 `assertLoadableSkillsPath` 同時接受兩種
    // 寫法之後才有的路徑，不擋的話「同一個目錄載兩次」就從這個縫溜過去了。
    expect(() => registry.skills.addSource('/skills/user')).toThrow('"/skills/user"');
    expect(() => registry.skills.addSource('/skills/project/')).not.toThrow();
    leave();
    // 交出去的是 plugin 真正寫下的那一串，不是 key。
    expect(registry.skills.sources()).toEqual(['/skills/user/', '/skills/project/']);
  });

  it('memory 純累加，同一路徑兩次不報錯', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    registry.memory.addSource('/AGENTS.md');
    expect(() => registry.memory.addSource('/AGENTS.md')).not.toThrow();
    leave();
    expect(registry.memory.sources()).toEqual(['/AGENTS.md', '/AGENTS.md']);
  });

  /**
   * 路徑格式是 `memory` 註冊點唯一會擋的東西，而它擋的理由跟別處不同：**基座那一側
   * 完全沒有檢查**。`createMemoryMiddleware` 讀不到就 `console.debug` 然後繼續，
   * prompt 裡只會變成 `(No memory loaded)`——所以這三種寫法不擋在這裡，就永遠不會有
   * 任何東西紅。細節見 `assertLoadableMemoryPath`。
   */
  describe('memory 來源的路徑格式', () => {
    const register = (path: string): void => {
      const registry = createRegistry();
      const leave = registry.enter(first);
      try {
        registry.memory.addSource(path);
      } finally {
        leave();
      }
    };

    // `~` 是最值得擋的那個：基座 JSDoc 的例子就長這樣，而那是已 deprecated 的
    // `createAgentMemoryMiddleware` 留下的——現在這條路上沒有任何一處展開它。
    it('"~" 開頭被擋，而且訊息指名是誰註冊的', () => {
      expect(() => register('~/.deepagents/AGENTS.md')).toThrow('"~"');
      expect(() => register('~/.deepagents/AGENTS.md')).toThrow('plugins[0] (alpha)');
    });

    it('相對路徑被擋', () => {
      expect(() => register('./AGENTS.md')).toThrow('絕對路徑');
      expect(() => register('AGENTS.md')).toThrow('絕對路徑');
    });

    // 這三種是照 dsh 的 `RESERVED_PATH_SEGMENTS`（`'' / '.' / '..'`）對齊的，差別只在
    // 它靜默濾掉、我們拋錯——理由見 `assertLoadableMemoryPath` 的偏離標註。
    it('".." / "." / 空路段都被擋', () => {
      expect(() => register('/專案/../etc/AGENTS.md')).toThrow('".."');
      expect(() => register('/專案/./AGENTS.md')).toThrow('"."');
      expect(() => register('/專案//AGENTS.md')).toThrow('空路段');
      expect(() => register('/專案/')).toThrow('空路段');
    });

    // 擋得住是一半。少了這一條，一個什麼都拒絕的檢查也會讓上面每一條通過。
    it('絕對路徑照樣進得去，含非 ASCII 與看起來像 ".." 的檔名', () => {
      expect(() => register('/AGENTS.md')).not.toThrow();
      expect(() => register('/專案/記憶/AGENTS.md')).not.toThrow();
      expect(() => register('/notes/..hidden.md')).not.toThrow();
    });
  });

  describe('skill 來源的路徑格式', () => {
    const register = (path: string): void => {
      const registry = createRegistry();
      const leave = registry.enter(first);
      try {
        registry.skills.addSource(path);
      } finally {
        leave();
      }
    };

    it('"~" 開頭被擋，而且訊息指名是誰註冊的', () => {
      expect(() => register('~/.dsh/skills/')).toThrow('"~"');
      expect(() => register('~/.dsh/skills/')).toThrow('plugins[0] (alpha)');
    });

    it('相對路徑被擋', () => {
      expect(() => register('./skills/')).toThrow('絕對路徑');
      expect(() => register('skills/')).toThrow('絕對路徑');
    });

    it('".." / "." / 連續斜線都被擋', () => {
      expect(() => register('/專案/../etc/skills/')).toThrow('".."');
      expect(() => register('/專案/./skills/')).toThrow('"."');
      expect(() => register('/專案//skills/')).toThrow('空路段');
    });

    // 基座支援 Windows 分隔（`sourcePath.includes('\\')` 決定 pathSep），我們刻意收窄。
    // 理由見 `assertLoadableSkillsPath`：backend 命名空間不是宿主檔案系統。
    it('反斜線被擋，即使整條看起來是合法的 Windows 路徑', () => {
      expect(() => register('/skills\\user\\')).toThrow('"\\"');
    });

    // 這一條是 skill 與 memory 唯一分岔的地方，錯了就會被上面那些「都擋掉」的斷言蓋過去。
    it('結尾斜線是合法的——skill 來源是目錄，不是檔', () => {
      expect(() => register('/skills/')).not.toThrow();
      expect(() => register('/skills')).not.toThrow();
    });

    // 接受兩種寫法就得讓重複檢查知道它們是同一個目錄，否則上面那條剛好開了個縫：
    // 兩個 plugin 各寫一種，兩筆都進去，而基座載兩次只會讓同名 skill 自己覆蓋自己。
    it('兩種寫法是同一個目錄，第二個撞得到第一個', () => {
      const registry = createRegistry();
      const leave = registry.enter(first);
      registry.skills.addSource('/skills/');
      expect(() => registry.skills.addSource('/skills')).toThrow('已經註冊過了');
      leave();
    });

    // 擋得住是一半。少了這一條，一個什麼都拒絕的檢查也會讓上面每一條通過。
    it('絕對目錄路徑照樣進得去，含非 ASCII 與看起來像 ".." 的目錄名', () => {
      expect(() => register('/專案/技能/')).not.toThrow();
      expect(() => register('/skills/..hidden/')).not.toThrow();
    });
  });

  it('六個註冊點在 apply 之外呼叫都當場報錯', () => {
    const registry = createRegistry();
    expect(() => registry.backend.mount('/m/', fakeBackend('b'))).toThrow('apply');
    expect(() => registry.middleware.use(fakeMiddleware('m'))).toThrow('apply');
    expect(() => registry.permissions.deny(['/x'])).toThrow('apply');
    expect(() => registry.interrupts.require('rm', { reason: 'r' })).toThrow('apply');
    expect(() => registry.skills.addSource('/skills/')).toThrow('apply');
    expect(() => registry.memory.addSource('/AGENTS.md')).toThrow('apply');
    expect(() => registry.lifecycle.onDispose(() => {})).toThrow('apply');
  });
});

describe('lifecycle 通道', () => {
  it('依登記順序留著，undo 撤掉的是登記本身、不是跑那個清理', () => {
    const registry = createRegistry();
    const ran: string[] = [];
    const leave = registry.enter(first);
    registry.lifecycle.onDispose(() => void ran.push('first'));
    const undoSecond = registry.lifecycle.onDispose(() => void ran.push('second'));
    leave();

    undoSecond();
    expect(ran).toEqual([]);
    expect(registry.lifecycle.disposers().map((entry) => entry.origin.name)).toEqual(['alpha']);
  });

  it('takeDisposers 取走就清空，第二次拿到空的', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    registry.lifecycle.onDispose(() => {});
    leave();

    expect(registry.lifecycle.takeDisposers()).toHaveLength(1);
    expect(registry.lifecycle.takeDisposers()).toEqual([]);
    expect(registry.lifecycle.disposers()).toEqual([]);
  });
});

describe('tools.own', () => {
  it('只回那一層自己註冊的，不含全域打底', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    registry.tools.register(fakeTool('search'));
    registry.tools.register(fakeTool('grep'), { scope: 'researcher' });
    leave();
    expect([...registry.tools.own('researcher').keys()]).toEqual(['grep']);
    expect([...registry.tools.effective('researcher').keys()]).toEqual(['search', 'grep']);
    expect(registry.tools.own('writer').size).toBe(0);
  });
});

describe('telemetry 註冊點', () => {
  it('脫敏規則依註冊順序排，每一條記得是誰掛的', () => {
    const registry = createRegistry();
    const leaveFirst = registry.enter(first);
    registry.telemetry.redact((record) => record);
    leaveFirst();

    const leaveSecond = registry.enter(second);
    registry.telemetry.redact((record) => record);
    leaveSecond();

    expect(registry.telemetry.rules().map((entry) => entry.origin.name)).toEqual(['alpha', 'mcp']);
  });

  it('撤銷是逐條的，撤掉一條不影響另一條', () => {
    const registry = createRegistry();
    const leave = registry.enter(first);
    const undo = registry.telemetry.redact((record) => record);
    registry.telemetry.redact((record) => record);
    leave();

    undo();
    undo();
    expect(registry.telemetry.rules()).toHaveLength(1);
  });

  it('第二個服務掛不上去，訊息同時指名兩個 plugin', () => {
    const registry = createRegistry();
    const leaveFirst = registry.enter(first);
    registry.telemetry.use(fakeSink());
    leaveFirst();

    const leaveSecond = registry.enter(second);
    expect(() => registry.telemetry.use(fakeSink())).toThrow(
      /plugins\[0\] \(alpha\)[\s\S]*plugins\[1\] \(mcp\)/,
    );
    leaveSecond();
  });

  it('撤掉服務之後那個位子是真的空的，別人掛得上', () => {
    const registry = createRegistry();
    const leaveFirst = registry.enter(first);
    const undo = registry.telemetry.use(fakeSink());
    leaveFirst();

    undo();
    expect(registry.telemetry.service()).toBeUndefined();

    const leaveSecond = registry.enter(second);
    registry.telemetry.use(fakeSink());
    leaveSecond();
    expect(registry.telemetry.service()?.origin.name).toBe('mcp');
  });

  it('沒掛服務時 service() 是 undefined——披露那一層要靠它回答', () => {
    expect(createRegistry().telemetry.service()).toBeUndefined();
  });

  it('兩個方法都只能在 apply 裡呼叫', () => {
    const registry = createRegistry();
    expect(() => registry.telemetry.redact((record) => record)).toThrow(
      'telemetry.redact()只能在 plugin 的 apply 裡呼叫',
    );
    expect(() => registry.telemetry.use(fakeSink())).toThrow(
      'telemetry.use()只能在 plugin 的 apply 裡呼叫',
    );
  });
});
