/**
 * fold 規則：把載入完的 registry 折成 `createDeepAgent(...)` 的參數。
 *
 * 對應 [#29](https://github.com/DemianLi/nexus-agent/issues/29) 的「fold 規則」與
 * 「工具呈現順序」驗收。判準是**能不能只靠 fold 的輸入輸出斷言**——規則真的產生
 * 效果（deny 真的擋住檔案、中斷真的停下來）屬各擴充點落地的 phase。
 */

import { describe, expect, it, vi } from 'vitest';
import type { CreateDeepAgentParams, SubAgent } from 'deepagents';
import { CompositeBackend } from 'deepagents';
import { foldRegistry, TOOL_ORDER_REST } from './fold.js';
import type { FoldOptions } from './fold.js';
import { loadPlugins } from './load.js';
import { fakeBackend, fakeMiddleware, fakePlugin, fakeSubAgent, fakeTool } from './fixtures.js';
import type { NexusPlugin } from './plugin.js';
import type { WhenPredicate } from './base-types.js';

/** 跑一份清單再折，測試裡唯一的入口——fold 的輸入永遠是載入完的 registry。 */
async function fold(plugins: NexusPlugin[], options: FoldOptions = {}) {
  const { registry } = await loadPlugins(plugins);
  return foldRegistry(registry, options);
}

/** 有 checkpointer 的組裝點。`interrupts` 的測試多數需要它。 */
const withCheckpointer: FoldOptions = { checkpointer: true };

/** `when` 拿到的那個請求，測試裡只當作不透明的參數傳遞。 */
const anyRequest = {} as Parameters<WhenPredicate>[0];

function toolNames(tools: { name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

describe('backend 註冊點', () => {
  it('同 routePrefix 的掛載點報錯，訊息指名兩個 plugin 與那個前綴', async () => {
    const plugins = [
      fakePlugin('store', (r) => void r.backend.mount('/memories/', fakeBackend('store'))),
      fakePlugin('disk', (r) => void r.backend.mount('/memories/', fakeBackend('disk'))),
    ];
    await expect(loadPlugins(plugins)).rejects.toThrow(
      /"\/memories\/"[\s\S]*plugins\[0\] \(store\)[\s\S]*plugins\[1\] \(disk\)/,
    );
  });

  it('沒有尾斜線的 routePrefix 當場報錯——基座的路由靠字串切割', async () => {
    const plugins = [
      fakePlugin('store', (r) => void r.backend.mount('/memories', fakeBackend('store'))),
    ];
    await expect(loadPlugins(plugins)).rejects.toThrow('"/memories"');
  });

  it('有人掛路由就包成 CompositeBackend，default backend 接住其餘路徑', async () => {
    const store = fakeBackend('store');
    const fallback = fakeBackend('default');
    const params = await fold(
      [fakePlugin('store', (r) => void r.backend.mount('/memories/', store))],
      { defaultBackend: fallback },
    );
    expect(CompositeBackend.isInstance(params.backend)).toBe(true);
    expect((params.backend as CompositeBackend).routePrefixes).toEqual(['/memories/']);
  });

  it('沒人掛路由就原樣交出組裝點給的那個，不多包一層', async () => {
    const fallback = fakeBackend('default');
    const params = await fold([fakePlugin('noop', () => {})], { defaultBackend: fallback });
    expect(params.backend).toBe(fallback);
  });

  it('掛了路由卻沒給 default backend → 報錯', async () => {
    const plugins = [
      fakePlugin('store', (r) => void r.backend.mount('/memories/', fakeBackend('store'))),
    ];
    await expect(fold(plugins)).rejects.toThrow(/plugins\[0\] \(store\)[\s\S]*default backend/);
  });
});

describe('middleware 註冊點', () => {
  it('三個 plugin 各一個 middleware，順序等於清單順序', async () => {
    const params = await fold([
      fakePlugin('a', (r) => void r.middleware.use(fakeMiddleware('a'))),
      fakePlugin('b', (r) => void r.middleware.use(fakeMiddleware('b'))),
      fakePlugin('c', (r) => void r.middleware.use(fakeMiddleware('c'))),
    ]);
    expect(toolNames(params.middleware as unknown as { name: string }[])).toEqual(['a', 'b', 'c']);
  });

  it('prepend: true 插到最前，其餘維持清單順序', async () => {
    const params = await fold([
      fakePlugin('a', (r) => void r.middleware.use(fakeMiddleware('a'))),
      fakePlugin('b', (r) => void r.middleware.use(fakeMiddleware('b'), { prepend: true })),
      fakePlugin('c', (r) => void r.middleware.use(fakeMiddleware('c'))),
    ]);
    expect(toolNames(params.middleware as unknown as { name: string }[])).toEqual(['b', 'a', 'c']);
  });

  it('多個 prepend 之間仍是註冊順序', async () => {
    const params = await fold([
      fakePlugin('a', (r) => void r.middleware.use(fakeMiddleware('a'))),
      fakePlugin('b', (r) => void r.middleware.use(fakeMiddleware('b'), { prepend: true })),
      fakePlugin('c', (r) => void r.middleware.use(fakeMiddleware('c'), { prepend: true })),
    ]);
    expect(toolNames(params.middleware as unknown as { name: string }[])).toEqual(['b', 'c', 'a']);
  });
});

describe('permissions 註冊點', () => {
  it('兩個 plugin 各一條 deny → 取聯集，順序等於註冊順序', async () => {
    const params = await fold([
      fakePlugin('secrets', (r) => void r.permissions.deny(['/.env*'])),
      fakePlugin('keys', (r) => void r.permissions.deny(['/keys/**'])),
    ]);
    expect(params.permissions).toEqual([
      { operations: ['read', 'write'], paths: ['/.env*'], mode: 'deny' },
      { operations: ['read', 'write'], paths: ['/keys/**'], mode: 'deny' },
    ]);
  });

  it('except 寫成排在自己那條 deny 前面的 allow——基座是先命中者決定', async () => {
    const params = await fold([
      fakePlugin(
        'secrets',
        (r) =>
          void r.permissions.deny(['/secrets/**'], {
            except: ['/secrets/public/**'],
          }),
      ),
    ]);
    expect(params.permissions).toEqual([
      { operations: ['read', 'write'], paths: ['/secrets/public/**'], mode: 'allow' },
      { operations: ['read', 'write'], paths: ['/secrets/**'], mode: 'deny' },
    ]);
  });

  it('靠後的 plugin 的 except 挖不開靠前的 plugin 的 deny', async () => {
    const params = await fold([
      fakePlugin('strict', (r) => void r.permissions.deny(['/secrets/**'])),
      fakePlugin(
        'loose',
        (r) =>
          void r.permissions.deny(['/tmp/**'], {
            except: ['/secrets/leak'],
          }),
      ),
    ]);
    const modes = (params.permissions ?? []).map((rule) => [rule.mode, rule.paths[0]]);
    expect(modes).toEqual([
      ['deny', '/secrets/**'],
      ['allow', '/secrets/leak'],
      ['deny', '/tmp/**'],
    ]);
  });

  it('全域 deny 主動併進每個 subagent——基座對 subagent 的 permissions 是整組替換', async () => {
    const params = await fold([
      fakePlugin('secrets', (r) => void r.permissions.deny(['/.env*'])),
      fakePlugin('team', (r) => {
        r.subagents.register(fakeSubAgent('researcher'));
        r.subagents.register(fakeSubAgent('writer'));
      }),
    ]);
    for (const subagent of params.subagents) {
      expect(subagent.permissions).toEqual([
        { operations: ['read', 'write'], paths: ['/.env*'], mode: 'deny' },
      ]);
    }
  });

  it('subagent 自帶的規則接在全域之後——全域先命中，subagent 只能多要求', async () => {
    const own: SubAgent = {
      ...fakeSubAgent('researcher'),
      permissions: [{ operations: ['write'], paths: ['/notes/**'], mode: 'deny' }],
    };
    const params = await fold([
      fakePlugin('secrets', (r) => void r.permissions.deny(['/.env*'])),
      fakePlugin('team', (r) => void r.subagents.register(own)),
    ]);
    expect(params.subagents[0]?.permissions).toEqual([
      { operations: ['read', 'write'], paths: ['/.env*'], mode: 'deny' },
      { operations: ['write'], paths: ['/notes/**'], mode: 'deny' },
    ]);
  });

  it('沒有任何 deny 時不放空陣列——空陣列與缺席在基座那裡不同義', async () => {
    const params = await fold([
      fakePlugin('team', (r) => void r.subagents.register(fakeSubAgent('researcher'))),
    ]);
    expect(params.permissions).toBeUndefined();
    expect(params.subagents[0]?.permissions).toBeUndefined();
  });
});

describe('interrupts 註冊點', () => {
  it('兩個 plugin 對同一 tool 給不同 when → 逐欄位 OR，不報錯', async () => {
    const first = vi.fn(() => false);
    const second = vi.fn(() => true);
    const params = await fold(
      [
        fakePlugin(
          'a',
          (r) =>
            void r.interrupts.require('write_file', {
              reason: '會動到檔案',
              when: first,
            }),
        ),
        fakePlugin(
          'b',
          (r) =>
            void r.interrupts.require('write_file', {
              reason: '外部同步',
              when: second,
            }),
        ),
      ],
      withCheckpointer,
    );
    const config = params.interruptOn?.['write_file'];
    expect(config?.allowedDecisions).toEqual(['approve', 'reject']);
    expect(config?.description).toBe('會動到檔案；外部同步');
    await expect(config?.when?.(anyRequest)).resolves.toBe(true);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it('OR 依序求值且任一為真就短路', async () => {
    const later = vi.fn(() => true);
    const params = await fold(
      [
        fakePlugin(
          'a',
          (r) =>
            void r.interrupts.require('rm', {
              reason: '第一條',
              when: () => true,
            }),
        ),
        fakePlugin('b', (r) => void r.interrupts.require('rm', { reason: '第二條', when: later })),
      ],
      withCheckpointer,
    );
    await expect(params.interruptOn?.['rm']?.when?.(anyRequest)).resolves.toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it('when 可以回 promise', async () => {
    const params = await fold(
      [
        fakePlugin(
          'a',
          (r) =>
            void r.interrupts.require('rm', {
              reason: '慢的',
              when: async () => false,
            }),
        ),
        fakePlugin(
          'b',
          (r) =>
            void r.interrupts.require('rm', {
              reason: '也慢的',
              when: async () => true,
            }),
        ),
      ],
      withCheckpointer,
    );
    await expect(params.interruptOn?.['rm']?.when?.(anyRequest)).resolves.toBe(true);
  });

  it('有一方沒給 when 就是無條件中斷——合出來的設定不帶 when', async () => {
    const narrow = vi.fn(() => false);
    const params = await fold(
      [
        fakePlugin('a', (r) => void r.interrupts.require('rm', { reason: '一律要核准' })),
        fakePlugin(
          'b',
          (r) => void r.interrupts.require('rm', { reason: '只有根目錄', when: narrow }),
        ),
      ],
      withCheckpointer,
    );
    const config = params.interruptOn?.['rm'];
    expect(config).toBeDefined();
    expect('when' in (config ?? {})).toBe(false);
    expect(narrow).not.toHaveBeenCalled();
  });

  it('不同工具各自成一筆', async () => {
    const params = await fold(
      [
        fakePlugin('a', (r) => {
          r.interrupts.require('rm', { reason: '刪檔' });
          r.interrupts.require('deploy', { reason: '上線' });
        }),
      ],
      withCheckpointer,
    );
    expect(Object.keys(params.interruptOn ?? {})).toEqual(['rm', 'deploy']);
  });

  it('宣告了 interrupt 但沒 checkpointer → 報錯，訊息指名是誰宣告的', async () => {
    const plugins = [
      fakePlugin('danger', (r) => void r.interrupts.require('rm', { reason: '刪檔' })),
    ];
    await expect(fold(plugins)).rejects.toThrow(/plugins\[0\] \(danger\)[\s\S]*checkpointer/);
  });

  it('checkpointer: false 與缺席同義', async () => {
    const plugins = [
      fakePlugin('danger', (r) => void r.interrupts.require('rm', { reason: '刪檔' })),
    ];
    await expect(fold(plugins, { checkpointer: false })).rejects.toThrow('checkpointer');
  });

  it('給了 checkpointer 就正常 fold', async () => {
    const params = await fold(
      [fakePlugin('danger', (r) => void r.interrupts.require('rm', { reason: '刪檔' }))],
      withCheckpointer,
    );
    expect(params.interruptOn?.['rm']?.description).toBe('刪檔');
    expect(params.checkpointer).toBe(true);
  });

  it('session 關掉核准卻有人宣告要核准 → 報錯，不是靜默丟掉那些標記', async () => {
    const plugins = [
      fakePlugin('danger', (r) => void r.interrupts.require('rm', { reason: '刪檔' })),
    ];
    await expect(
      fold(plugins, { checkpointer: true, approvals: { enabled: false } }),
    ).rejects.toThrow(/plugins\[0\] \(danger\)/);
  });

  it('沒人宣告要核准時，關掉核准不影響 fold', async () => {
    const params = await fold([fakePlugin('noop', () => {})], { approvals: { enabled: false } });
    expect(params.interruptOn).toBeUndefined();
  });

  it('全域核准標記主動併進每個 subagent，且蓋過 subagent 自帶的同名項', async () => {
    const own: SubAgent = {
      ...fakeSubAgent('researcher'),
      interruptOn: { rm: false, ls: true },
    };
    const params = await fold(
      [
        fakePlugin('danger', (r) => void r.interrupts.require('rm', { reason: '刪檔' })),
        fakePlugin('team', (r) => void r.subagents.register(own)),
      ],
      withCheckpointer,
    );
    // subagent 自己把 rm 設成不中斷，全域要求核准的那筆仍然勝出。
    expect(params.subagents[0]?.interruptOn?.['rm']).toEqual(params.interruptOn?.['rm']);
    expect(params.subagents[0]?.interruptOn?.['ls']).toBe(true);
  });

  it('沒有核准標記時 subagent 不帶空的 interruptOn——{} 會多掛一層 HITL middleware', async () => {
    const params = await fold([
      fakePlugin('team', (r) => void r.subagents.register(fakeSubAgent('researcher'))),
    ]);
    expect(params.subagents[0]?.interruptOn).toBeUndefined();
  });
});

describe('每個 subagent 的有效工具集合', () => {
  it('全域 tool 出現在每個 subagent 的集合裡', async () => {
    const params = await fold([
      fakePlugin('search', (r) => void r.tools.register(fakeTool('search'))),
      fakePlugin('team', (r) => {
        r.subagents.register(fakeSubAgent('researcher'));
        r.subagents.register(fakeSubAgent('writer'));
      }),
    ]);
    for (const subagent of params.subagents) {
      expect(toolNames(subagent.tools ?? [])).toEqual(['search']);
    }
  });

  it('subagent 自己註冊的同名 tool 遮蔽掉全域的那個', async () => {
    const globalSearch = fakeTool('search');
    const scopedSearch = fakeTool('search');
    const params = await fold([
      fakePlugin('base', (r) => void r.tools.register(globalSearch)),
      fakePlugin('team', (r) => {
        r.subagents.register(fakeSubAgent('researcher'));
        r.subagents.register(fakeSubAgent('writer'));
        r.tools.register(scopedSearch, { scope: 'researcher' });
      }),
    ]);
    const researcher = params.subagents.find((s) => s.name === 'researcher');
    const writer = params.subagents.find((s) => s.name === 'writer');
    expect(researcher?.tools).toEqual([scopedSearch]);
    expect(writer?.tools).toEqual([globalSearch]);
    // 全域那一層看到的仍然是自己那個。
    expect(params.tools).toEqual([globalSearch]);
  });

  it('subagent 定義自帶的 tools 不會被抹掉，且遮蔽全域同名', async () => {
    const globalSearch = fakeTool('search');
    const ownSearch = fakeTool('search');
    const own: SubAgent = { ...fakeSubAgent('researcher'), tools: [ownSearch] };
    const params = await fold([
      fakePlugin('base', (r) => void r.tools.register(globalSearch)),
      fakePlugin('team', (r) => void r.subagents.register(own)),
    ]);
    expect(params.subagents[0]?.tools).toEqual([ownSearch]);
  });

  it('往不存在的 subagent 加工具 → 報錯，訊息指名那個名字與是誰加的', async () => {
    const plugins = [
      fakePlugin('team', (r) => void r.subagents.register(fakeSubAgent('researcher'))),
      fakePlugin(
        'typo',
        (r) => void r.tools.register(fakeTool('search'), { scope: 'reasearcher' }),
      ),
    ];
    await expect(fold(plugins)).rejects.toThrow(/"reasearcher"[\s\S]*plugins\[1\] \(typo\)/);
  });
});

describe('工具呈現順序', () => {
  const alphabet = fakePlugin('alphabet', (r) => {
    r.tools.register(fakeTool('write_file'));
    r.tools.register(fakeTool('ls'));
    r.tools.register(fakeTool('search'));
  });

  it('沒給清單就是字典序，不是註冊順序', async () => {
    const params = await fold([alphabet]);
    expect(toolNames(params.tools)).toEqual(['ls', 'search', 'write_file']);
  });

  it('列到的站在被列的位置，未列出者依字典序落在 rest 那一格', async () => {
    const params = await fold([alphabet], { toolOrder: ['write_file', TOOL_ORDER_REST] });
    expect(toolNames(params.tools)).toEqual(['write_file', 'ls', 'search']);
  });

  it('rest 那一格可以在中間', async () => {
    const params = await fold([alphabet], {
      toolOrder: ['write_file', TOOL_ORDER_REST, 'search'],
    });
    expect(toolNames(params.tools)).toEqual(['write_file', 'ls', 'search']);
  });

  it('同一份順序也套用在每個 subagent 的集合上', async () => {
    const params = await fold(
      [
        alphabet,
        fakePlugin('team', (r) => {
          r.subagents.register(fakeSubAgent('researcher'));
          r.tools.register(fakeTool('grep'), { scope: 'researcher' });
        }),
      ],
      { toolOrder: ['write_file', TOOL_ORDER_REST] },
    );
    expect(toolNames(params.subagents[0]?.tools ?? [])).toEqual([
      'write_file',
      'grep',
      'ls',
      'search',
    ]);
  });

  it('rest entry 缺席 → 報錯', async () => {
    await expect(fold([alphabet], { toolOrder: ['write_file', 'ls', 'search'] })).rejects.toThrow(
      TOOL_ORDER_REST,
    );
  });

  it('rest entry 超過一個 → 報錯', async () => {
    await expect(
      fold([alphabet], { toolOrder: [TOOL_ORDER_REST, 'ls', TOOL_ORDER_REST] }),
    ).rejects.toThrow(/超過一次/);
  });

  it('清單裡有重複的工具名 → 報錯', async () => {
    await expect(fold([alphabet], { toolOrder: ['ls', 'ls', TOOL_ORDER_REST] })).rejects.toThrow(
      /"ls"[\s\S]*超過一次/,
    );
  });

  it('列了沒人註冊的工具 → 報錯，訊息列出目前有哪些', async () => {
    await expect(fold([alphabet], { toolOrder: ['nonexistent', TOOL_ORDER_REST] })).rejects.toThrow(
      /"nonexistent"[\s\S]*ls、search、write_file/,
    );
  });

  it('只註冊在某個 subagent 層的工具算「有註冊」，列得進清單', async () => {
    const params = await fold(
      [
        fakePlugin('team', (r) => {
          r.subagents.register(fakeSubAgent('researcher'));
          r.tools.register(fakeTool('grep'), { scope: 'researcher' });
        }),
      ],
      { toolOrder: ['grep', TOOL_ORDER_REST] },
    );
    // 全域那一層沒有它，不會憑空多出來。
    expect(params.tools).toEqual([]);
    expect(toolNames(params.subagents[0]?.tools ?? [])).toEqual(['grep']);
  });

  it('工具名叫 <unlisted-tools> → 報錯，那一格不能有歧義', async () => {
    const plugins = [fakePlugin('sneaky', (r) => void r.tools.register(fakeTool(TOOL_ORDER_REST)))];
    await expect(fold(plugins)).rejects.toThrow(/plugins\[0\] \(sneaky\)/);
  });

  it('保留名藏在 subagent 層也一樣報錯', async () => {
    const plugins = [
      fakePlugin('team', (r) => {
        r.subagents.register(fakeSubAgent('researcher'));
        r.tools.register(fakeTool(TOOL_ORDER_REST), { scope: 'researcher' });
      }),
    ];
    await expect(fold(plugins)).rejects.toThrow(TOOL_ORDER_REST);
  });
});

describe('skills 與 memory 註冊點', () => {
  it('skills 同一來源路徑重複註冊報錯', async () => {
    const plugins = [
      fakePlugin('user-skills', (r) => void r.skills.addSource('/skills/user/')),
      fakePlugin('project-skills', (r) => void r.skills.addSource('/skills/user/')),
    ];
    await expect(loadPlugins(plugins)).rejects.toThrow(
      /"\/skills\/user\/"[\s\S]*plugins\[0\] \(user-skills\)[\s\S]*plugins\[1\] \(project-skills\)/,
    );
  });

  it('skills 依註冊順序交出去——基座是後蓋前', async () => {
    const params = await fold([
      fakePlugin('user', (r) => void r.skills.addSource('/skills/user/')),
      fakePlugin('project', (r) => void r.skills.addSource('/skills/project/')),
    ]);
    expect(params.skills).toEqual(['/skills/user/', '/skills/project/']);
  });

  it('memory 純累加，同一路徑兩次不報錯', async () => {
    const params = await fold([
      fakePlugin('home', (r) => void r.memory.addSource('~/.deepagents/AGENTS.md')),
      fakePlugin('repo', (r) => {
        r.memory.addSource('./AGENTS.md');
        r.memory.addSource('./AGENTS.md');
      }),
    ]);
    expect(params.memory).toEqual(['~/.deepagents/AGENTS.md', './AGENTS.md', './AGENTS.md']);
  });

  it('沒人註冊時兩個欄位都不出現', async () => {
    const params = await fold([fakePlugin('noop', () => {})]);
    expect(params.skills).toBeUndefined();
    expect(params.memory).toBeUndefined();
  });
});

describe('組裝點自有的那五樣', () => {
  it('原樣落在參數上，plugin 碰不到它們', async () => {
    const store = { kind: 'store' } as unknown as FoldOptions['store'];
    const params = await fold([fakePlugin('noop', () => {})], {
      model: 'anthropic:claude-sonnet-4-5',
      checkpointer: true,
      store,
    });
    expect(params.model).toBe('anthropic:claude-sonnet-4-5');
    expect(params.checkpointer).toBe(true);
    expect(params.store).toBe(store);
  });

  it('沒給就不出現，讓基座的預設值生效', async () => {
    const params = await fold([fakePlugin('noop', () => {})]);
    expect('model' in params).toBe(false);
    expect('checkpointer' in params).toBe(false);
    expect('store' in params).toBe(false);
    expect('backend' in params).toBe(false);
  });

  it('折出來的東西就是 createDeepAgent 的參數', async () => {
    const params = await fold([
      fakePlugin('a', (r) => {
        r.tools.register(fakeTool('search'));
        r.subagents.register(fakeSubAgent('researcher'));
        r.middleware.use(fakeMiddleware('m'));
        r.permissions.deny(['/.env*']);
        r.skills.addSource('/skills/');
        r.memory.addSource('./AGENTS.md');
      }),
    ]);
    // 型別斷言本身就是驗收：基座改了形狀，typecheck 當場紅。
    const forBase: CreateDeepAgentParams = params;
    expect(forBase.tools).toBe(params.tools);
  });
});
