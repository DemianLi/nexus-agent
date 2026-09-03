/**
 * fold 規則：把載入完的 registry 折成 `createDeepAgent(...)` 的參數。
 *
 * 對應 [#29](https://github.com/DemianLi/nexus-agent/issues/29) 的「fold 規則」與
 * 「工具呈現順序」驗收。判準是**能不能只靠 fold 的輸入輸出斷言**——規則真的產生
 * 效果（deny 真的擋住檔案、中斷真的停下來）屬各擴充點落地的 phase。
 */

import { describe, expect, it } from 'vitest';
import type { CreateDeepAgentParams, SubAgent } from 'deepagents';
import { CompositeBackend } from 'deepagents';
import { APPROVAL_GATE_MIDDLEWARE_NAME } from './approval.js';
import { foldRegistry, ROOT_ONLY_NOTICE, rootOnlyRefusal, TOOL_ORDER_REST } from './fold.js';
import { REPEAT_REMINDER_MIDDLEWARE_NAME } from './repeat-reminder.js';
import { SUMMARIZATION_MIDDLEWARE_NAME } from './summarization.js';
import type { FoldOptions } from './fold.js';
import { loadPlugins } from './load.js';
import { fakeBackend, fakeMiddleware, fakePlugin, fakeSubAgent, fakeTool } from './fixtures.js';
import type { NexusPlugin } from './plugin.js';

/**
 * 跑一份清單再折，測試裡唯一的入口——fold 的輸入永遠是載入完的 registry。
 *
 * **預設把摘要器關掉。** fold 現在會替 root 與每個 subagent 打底一份我們配的摘要器
 * （[#142](https://github.com/DemianLi/nexus-agent/issues/142)），而它需要一個
 * default backend。這個檔裡絕大多數測試量的是別的規則、不給 backend，所以在入口統一
 * 宣告「這些測試不關心摘要」比逐條塞一個假 backend 誠實。摘要那一組自己明著打開。
 *
 * **提醒器也一併關掉，理由不同。** 它不需要任何東西就建得起來
 * （[#147](https://github.com/DemianLi/nexus-agent/issues/147)），所以關它不是為了讓
 * 測試跑得起來，而是為了讓**順序斷言只列它真的在量的那幾根**——不然這個檔裡每一條
 * middleware 順序測試都要多背一個跟它無關的名字。提醒那一組自己明著打開。
 */
async function fold(plugins: NexusPlugin[], options: FoldOptions = {}) {
  const { registry } = await loadPlugins(plugins);
  return foldRegistry(registry, { summarization: false, repeatReminder: false, ...options });
}

/** 基座自己帶進來、不經過 registry 的工具名。`toolOrder` 的檢查需要它們。 */
const gatedTools = ['write_file', 'rm', 'deploy'] as const;

/** 有 checkpointer 的組裝點——核准閘門要問得了人就得有它。 */
const withCheckpointer: FoldOptions = { checkpointer: true, baseToolNames: gatedTools };

/** 折出來那份 middleware 的名字，依順序。 */
function middlewareNames(params: { middleware: unknown[] }): string[] {
  return params.middleware.map((mw) => (mw as { name: string }).name);
}

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
      /"\/memories\/"[\s\S]*store#0 \(store\)[\s\S]*disk#0 \(disk\)/,
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
    await expect(fold(plugins)).rejects.toThrow(/store#0 \(store\)[\s\S]*default backend/);
  });
});

describe('middleware 註冊點', () => {
  it('三個 plugin 各一個 middleware，順序等於清單順序', async () => {
    const params = await fold([
      fakePlugin('a', (r) => void r.middleware.use(fakeMiddleware('a'))),
      fakePlugin('b', (r) => void r.middleware.use(fakeMiddleware('b'))),
      fakePlugin('c', (r) => void r.middleware.use(fakeMiddleware('c'))),
    ]);
    expect(middlewareNames(params)).toEqual([APPROVAL_GATE_MIDDLEWARE_NAME, 'a', 'b', 'c']);
  });

  it('prepend: true 插到最前，其餘維持清單順序', async () => {
    const params = await fold([
      fakePlugin('a', (r) => void r.middleware.use(fakeMiddleware('a'))),
      fakePlugin('b', (r) => void r.middleware.use(fakeMiddleware('b'), { prepend: true })),
      fakePlugin('c', (r) => void r.middleware.use(fakeMiddleware('c'))),
    ]);
    expect(middlewareNames(params)).toEqual(['b', APPROVAL_GATE_MIDDLEWARE_NAME, 'a', 'c']);
  });

  it('多個 prepend 之間仍是註冊順序', async () => {
    const params = await fold([
      fakePlugin('a', (r) => void r.middleware.use(fakeMiddleware('a'))),
      fakePlugin('b', (r) => void r.middleware.use(fakeMiddleware('b'), { prepend: true })),
      fakePlugin('c', (r) => void r.middleware.use(fakeMiddleware('c'), { prepend: true })),
    ]);
    expect(middlewareNames(params)).toEqual(['b', 'c', APPROVAL_GATE_MIDDLEWARE_NAME, 'a']);
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

  it('反過來不成立：靠前的 plugin 的 except 贏過靠後的 plugin 的 deny', async () => {
    const params = await fold([
      fakePlugin('loose', (r) => void r.permissions.deny(['/tmp/**'], { except: ['/tmp/ok'] })),
      fakePlugin('strict', (r) => void r.permissions.deny(['/tmp/ok'])),
    ]);
    // 先命中者決定，而排第一的是 loose 那條 allow——`except` 的射程是整份表往後全部。
    // glob 的差集算不出來，這裡釘住的是實際行為，不是我們希望的行為。
    expect((params.permissions ?? []).map((rule) => [rule.mode, rule.paths[0]])).toEqual([
      ['allow', '/tmp/ok'],
      ['deny', '/tmp/**'],
      ['deny', '/tmp/ok'],
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

describe('approvals 註冊點', () => {
  it('沒有人掛 listener 也照樣折出一個閘門——它只是每次都放行', async () => {
    // **這一條擋的是「沒人用就不掛」那個省法**。閘門不在的話，`approvals.gate()` 從
    // 「一定跑得到」變成「有人先註冊過才跑得到」，而 plugin 的載入順序不是誰能保證的。
    const params = await fold([fakePlugin('noop', () => {})]);
    expect(middlewareNames(params)).toContain(APPROVAL_GATE_MIDDLEWARE_NAME);
  });

  it('閘門排在 prepend 之後、其餘之前', async () => {
    const params = await fold([
      fakePlugin('a', (r) => void r.middleware.use(fakeMiddleware('a'))),
      fakePlugin('b', (r) => void r.middleware.use(fakeMiddleware('b'), { prepend: true })),
    ]);
    expect(middlewareNames(params)).toEqual(['b', APPROVAL_GATE_MIDDLEWARE_NAME, 'a']);
  });

  it('每個 subagent 也拿到閘門，而且排在它自帶的 middleware 之前', async () => {
    // subagent 不繼承 root 的 plugin middleware（`SubAgentBase.middleware` 是
    // 「append after default_middleware」），不注就是默默地失去核准。
    const own = fakeMiddleware('subagent-own');
    const params = await fold([
      fakePlugin('team', (r) => {
        r.subagents.register({ ...fakeSubAgent('releaser'), middleware: [own] } as SubAgent);
      }),
    ]);
    const names = (params.subagents[0]?.middleware ?? []).map(
      (mw) => (mw as unknown as { name: string }).name,
    );
    expect(names).toEqual([APPROVAL_GATE_MIDDLEWARE_NAME, 'subagent-own']);
  });

  it('沒自帶 middleware 的 subagent 也拿得到', async () => {
    const params = await fold([
      fakePlugin('team', (r) => void r.subagents.register(fakeSubAgent('researcher'))),
    ]);
    const names = (params.subagents[0]?.middleware ?? []).map(
      (mw) => (mw as unknown as { name: string }).name,
    );
    expect(names).toEqual([APPROVAL_GATE_MIDDLEWARE_NAME]);
  });

  it('**`interruptOn` 不再出現在折出來的參數上**——機制換了，欄位跟著走', async () => {
    // 只留型別層的斷言會漏掉「執行期還是塞了一個進去」。這一條是值的。
    const params = await fold(
      [fakePlugin('ops', (r) => void r.approvals.gate(() => ({ kind: 'ask' })))],
      withCheckpointer,
    );
    expect(params).not.toHaveProperty('interruptOn');
    expect(params.subagents.every((sub) => !('interruptOn' in sub))).toBe(true);
  });

  it('關掉核准也**折得出來**——舊版在這裡是直接拋', async () => {
    // #111 的 (c)：任何 bundle 了 approval-gated 工具的 plugin，過去在批次／CI 模式下
    // 會變成載不起來。這一條就是那個回歸的絆索。
    const params = await fold(
      [fakePlugin('ops', (r) => void r.approvals.gate(() => ({ kind: 'ask' })))],
      { approvals: { enabled: false } },
    );
    expect(middlewareNames(params)).toContain(APPROVAL_GATE_MIDDLEWARE_NAME);
  });

  it('沒有 checkpointer 也折得出來——同樣不再是建構期的錯誤', async () => {
    const params = await fold([
      fakePlugin('ops', (r) => void r.approvals.gate(() => ({ kind: 'ask' }))),
    ]);
    expect(middlewareNames(params)).toContain(APPROVAL_GATE_MIDDLEWARE_NAME);
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
    await expect(fold(plugins)).rejects.toThrow(/"reasearcher"[\s\S]*typo#0 \(typo\)/);
  });
});

describe('root-only 的工具', () => {
  it('subagent 拿到的是同名的拒絕樁，root 拿到的還是原件', async () => {
    const goal = fakeTool('goal');
    const params = await fold([
      fakePlugin('goal', (r) => void r.tools.register(goal, { rootOnly: true })),
      fakePlugin('team', (r) => void r.subagents.register(fakeSubAgent('researcher'))),
    ]);
    const stub = params.subagents[0]?.tools?.[0];

    // 名字不變——變了模型會以為工具不見了，那是另一種失敗。
    expect(stub?.name).toBe('goal');
    expect(stub).not.toBe(goal);
    // 描述帶著那句話：模型看得到的只有描述，不寫在那裡它每一輪都會再叫一次。
    expect(stub?.description).toContain(ROOT_ONLY_NOTICE);
    expect(await stub?.invoke({})).toBe(rootOnlyRefusal('goal', 'researcher'));
    // root 那一份沒有被動到。
    expect(params.tools).toEqual([goal]);
  });

  it('明著往那個 subagent 註冊的同名工具贏過樁', async () => {
    const globalGoal = fakeTool('goal');
    const scopedGoal = fakeTool('goal');
    const params = await fold([
      fakePlugin('goal', (r) => void r.tools.register(globalGoal, { rootOnly: true })),
      fakePlugin('team', (r) => {
        r.subagents.register(fakeSubAgent('researcher'));
        r.tools.register(scopedGoal, { scope: 'researcher' });
      }),
    ]);
    // 「這個 subagent 有它自己的版本」跟「這個工具不給 subagent」不是同一件事。
    expect(params.subagents[0]?.tools).toEqual([scopedGoal]);
  });

  /**
   * **這一條是這組裡唯一會紅的那條。**
   *
   * `load.ts` 照清單順序跑 `apply`，而且沒有 post-apply 的鉤子——宣告 rootOnly 的
   * plugin 排在註冊 subagent 的 plugin 前面時，它 apply 當下**根本看不到**那個
   * subagent。替換之所以還成立，是因為它做在 fold 而不是做在 `apply`。哪天有人把
   * 它挪回註冊期，只有這一條會紅。
   */
  it('宣告 rootOnly 的 plugin 排在註冊 subagent 的 plugin 之前也照樣替換', async () => {
    const goal = fakeTool('goal');
    const params = await fold([
      fakePlugin('goal', (r) => void r.tools.register(goal, { rootOnly: true })),
      fakePlugin('team-a', (r) => void r.subagents.register(fakeSubAgent('researcher'))),
      fakePlugin('team-b', (r) => void r.subagents.register(fakeSubAgent('writer'))),
    ]);
    for (const subagent of params.subagents) {
      expect(subagent.tools?.[0]).not.toBe(goal);
      expect(await subagent.tools?.[0]?.invoke({})).toBe(rootOnlyRefusal('goal', subagent.name));
    }
  });

  it('沒宣告 rootOnly 的工具照舊原件進每一個 subagent', async () => {
    const search = fakeTool('search');
    const params = await fold([
      fakePlugin('search', (r) => void r.tools.register(search)),
      fakePlugin('team', (r) => void r.subagents.register(fakeSubAgent('researcher'))),
    ]);
    expect(params.subagents[0]?.tools).toEqual([search]);
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
    await expect(fold(plugins)).rejects.toThrow(/sneaky#0 \(sneaky\)/);
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

  it('保留名藏在 subagent 定義自帶的 tools 裡也一樣報錯——那條路不經過 registry', async () => {
    const plugins = [
      fakePlugin('team', (r) => {
        r.subagents.register({
          ...fakeSubAgent('researcher'),
          tools: [fakeTool(TOOL_ORDER_REST)],
        });
      }),
    ];
    // 沒給 toolOrder 也要擋：不擋的話它會以保留名活著，等組裝點哪天補上清單才
    // 無聲地從那個 subagent 的集合裡消失。
    await expect(fold(plugins)).rejects.toThrow(/team#0 \(team\)[\s\S]*researcher/);
  });

  it('組裝點宣告的基座工具算「有註冊」，排得進呈現順序', async () => {
    // 沒有 baseToolNames 的話 write_file 會被誤判成「沒人註冊」——基座內建的工具
    // 因此根本排不進清單。
    const params = await fold([fakePlugin('p', (r) => void r.tools.register(fakeTool('search')))], {
      toolOrder: ['write_file', TOOL_ORDER_REST],
      baseToolNames: ['write_file'],
    });
    // 基座的工具不由我們產出，所以它只是「排得進清單」，不會憑空出現在 tools 裡。
    expect(toolNames(params.tools)).toEqual(['search']);
  });

  it('沒宣告 baseToolNames 時列基座工具 → 報錯', async () => {
    await expect(
      fold([fakePlugin('p', (r) => void r.tools.register(fakeTool('search')))], {
        toolOrder: ['write_file', TOOL_ORDER_REST],
      }),
    ).rejects.toThrow('"write_file"');
  });

  it('subagent 定義自帶的工具算「有註冊」，列得進清單', async () => {
    const params = await fold(
      [
        fakePlugin('team', (r) => {
          r.subagents.register({ ...fakeSubAgent('researcher'), tools: [fakeTool('grep')] });
        }),
      ],
      { toolOrder: ['grep', TOOL_ORDER_REST] },
    );
    expect(params.tools).toEqual([]);
    expect(toolNames(params.subagents[0]?.tools ?? [])).toEqual(['grep']);
  });
});

describe('skills 與 memory 註冊點', () => {
  it('skills 同一來源路徑重複註冊報錯', async () => {
    const plugins = [
      fakePlugin('user-skills', (r) => void r.skills.addSource('/skills/user/')),
      // 少一個結尾斜線，還是同一個目錄——key 是正規化過的。
      fakePlugin('project-skills', (r) => void r.skills.addSource('/skills/user')),
    ];
    await expect(loadPlugins(plugins)).rejects.toThrow(
      /"\/skills\/user"[\s\S]*user-skills#0 \(user-skills\)[\s\S]*project-skills#0 \(project-skills\)/,
    );
  });

  it('skills 依註冊順序交出去——基座是後蓋前', async () => {
    const params = await fold([
      fakePlugin('user', (r) => void r.skills.addSource('/skills/user/')),
      fakePlugin('project', (r) => void r.skills.addSource('/skills/project/')),
    ]);
    expect(params.skills).toEqual(['/skills/user/', '/skills/project/']);
  });

  // 這條原本用的是 `~/.deepagents/AGENTS.md` 與 `./AGENTS.md`——照抄基座 JSDoc 的那個
  // 例子。兩種現在都被 `assertLoadableMemoryPath` 當場擋下，理由見它的說明：backend-agnostic
  // 這條路上沒有任何一處展開 `~`，相對路徑同理，寫錯了只會安靜地沒有記憶。
  it('memory 純累加，同一路徑兩次不報錯', async () => {
    const params = await fold([
      fakePlugin('user', (r) => void r.memory.addSource('/設定/AGENTS.md')),
      fakePlugin('repo', (r) => {
        r.memory.addSource('/AGENTS.md');
        r.memory.addSource('/AGENTS.md');
      }),
    ]);
    expect(params.memory).toEqual(['/設定/AGENTS.md', '/AGENTS.md', '/AGENTS.md']);
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
        r.memory.addSource('/AGENTS.md');
      }),
    ]);
    // 型別斷言本身就是驗收：基座改了形狀，typecheck 當場紅。
    const forBase: CreateDeepAgentParams = params;
    expect(forBase.tools).toBe(params.tools);
  });
});

/**
 * **摘要器打底**——[#142](https://github.com/DemianLi/nexus-agent/issues/142) 的決定 1 與
 * 決定 2 在 core 這一側的驗收。行為（門檻真的觸發、歷史真的落在我們指定的前綴）由
 * `apps/harness/src/summarization.test.ts` 量，這裡量的是折出來的形狀。
 *
 * 這個檔的入口 helper 預設 `summarization: false`（其餘測試都不關心摘要，而打底需要一個
 * default backend），所以**這一組要自己明著打開**——不然 fold 產出的摘要器在 core 這側
 * 一條測試都沒有。
 */
describe('摘要器打底', () => {
  it('排在閘門之後、其餘 registry middleware 之前', async () => {
    const params = await fold(
      [
        fakePlugin('a', (r) => void r.middleware.use(fakeMiddleware('a'))),
        fakePlugin('b', (r) => void r.middleware.use(fakeMiddleware('b'), { prepend: true })),
      ],
      { summarization: {}, defaultBackend: fakeBackend('default') },
    );
    // 位置只決定同名誰贏（`mergeMiddleware$1` 是以 name 為鍵的 Map，後設的覆蓋前設的）：
    // 排在所有 registry middleware 之前 ＝ 任何 plugin 掛一個同名的都蓋得過我們這份。
    expect(middlewareNames(params)).toEqual([
      'b',
      APPROVAL_GATE_MIDDLEWARE_NAME,
      SUMMARIZATION_MIDDLEWARE_NAME,
      'a',
    ]);
  });

  it('每個 subagent 也拿到，而且排在它自帶的 middleware 之前', async () => {
    const own = fakeMiddleware('subagent-own');
    const params = await fold(
      [
        fakePlugin('team', (r) => {
          r.subagents.register({ ...fakeSubAgent('releaser'), middleware: [own] } as SubAgent);
        }),
      ],
      { summarization: {}, defaultBackend: fakeBackend('default') },
    );
    const names = (params.subagents[0]?.middleware ?? []).map(
      (mw) => (mw as unknown as { name: string }).name,
    );
    // **自帶的排在後面 ＝ 自帶的贏。** 這是「打底」不是「強制」，跟同一個函式裡 `tools`
    // 那條軸線一致；摘要門檻是效能與正確性的預設值，不是安全邊界。閘門那一格沒動。
    expect(names).toEqual([
      APPROVAL_GATE_MIDDLEWARE_NAME,
      SUMMARIZATION_MIDDLEWARE_NAME,
      'subagent-own',
    ]);
  });

  it('root 與每個 subagent 各拿一份實例，不共用', async () => {
    const params = await fold(
      [
        fakePlugin('team', (r) => {
          r.subagents.register(fakeSubAgent('one'));
          r.subagents.register(fakeSubAgent('two'));
        }),
      ],
      { summarization: {}, defaultBackend: fakeBackend('default') },
    );
    const pick = (list: readonly unknown[]): unknown =>
      list.find((mw) => (mw as { name: string }).name === SUMMARIZATION_MIDDLEWARE_NAME);
    const instances = [
      pick(params.middleware),
      pick(params.subagents[0]?.middleware ?? []),
      pick(params.subagents[1]?.middleware ?? []),
    ];
    expect(instances.every((instance) => instance !== undefined)).toBe(true);
    // **共用會讓歷史寫進同一個檔**：`sessionId` 在 middleware 的 closure 裡，
    // 檔名是 `${historyPathPrefix}/${sessionId}.md`。實測過共用時 root 與 subagent 的
    // 對話 append 進同一份摘要——所以這條要求的是三個不同的物件。
    expect(new Set(instances).size).toBe(3);
  });

  it('沒關掉又沒給 default backend，訊息指得出逃生口', async () => {
    await expect(fold([fakePlugin('noop', () => {})], { summarization: {} })).rejects.toThrow(
      /summarization: false/,
    );
  });

  it.each([
    ['trigger[0]', { trigger: [{ type: 'fraction', value: 0.85 }] }],
    ['keep', { keep: { type: 'fraction', value: 0.1 } }],
    [
      'truncateArgs.trigger',
      {
        truncateArgs: {
          trigger: { type: 'fraction', value: 0.8 },
          keep: { type: 'messages', value: 20 },
        },
      },
    ],
  ])('%s 用 fraction 當場拋，而且訊息指名是哪一格', async (where, override) => {
    // **逐格斷言而不是只看 /fraction/**：三格共用一個檢查函式，只驗共同字串的話，
    // 一個只檢查 `settings.trigger` 的 bug 會讓三條同時通過。
    await expect(
      fold([fakePlugin('noop', () => {})], {
        summarization: override as never,
        defaultBackend: fakeBackend('default'),
      }),
    ).rejects.toThrow(`summarization.${where}`);
  });
});

/**
 * 提醒器打底——**跟摘要器同一條軸線，但有兩格刻意相反**。
 *
 * 一、**共用同一份實例**。摘要器的 `sessionId` 在 closure 裡，共用會讓兩個 agent 的歷史
 * 混進同一個檔，所以那邊逐個建；提醒器的鏈是從 `state.messages` 現算的，closure 裡只有
 * 設定，而 `state` 本來就逐 thread、逐 agent 各一份。
 *
 * 二、**`false` 的意思相反**。摘要那格的 `false` 是退回基座無條件建的那個；這格的
 * `false` 是**真的沒有**——基座沒有這種 middleware。
 */
describe('提醒器打底', () => {
  it('排在摘要器之後、其餘 registry middleware 之前', async () => {
    const params = await fold(
      [
        fakePlugin('a', (r) => void r.middleware.use(fakeMiddleware('a'))),
        fakePlugin('b', (r) => void r.middleware.use(fakeMiddleware('b'), { prepend: true })),
      ],
      { summarization: {}, repeatReminder: {}, defaultBackend: fakeBackend('default') },
    );
    // **排在摘要器之後是有意義的**：兩個都會動訊息串，而它們在圖裡是照這個順序串起來的
    // 節點。摘要器先剪、提醒器後附 ＝ 提醒一定活到模型那一格。
    expect(middlewareNames(params)).toEqual([
      'b',
      APPROVAL_GATE_MIDDLEWARE_NAME,
      SUMMARIZATION_MIDDLEWARE_NAME,
      REPEAT_REMINDER_MIDDLEWARE_NAME,
      'a',
    ]);
  });

  it('每個 subagent 也拿到，而且排在它自帶的 middleware 之前', async () => {
    const own = fakeMiddleware('subagent-own');
    const params = await fold(
      [
        fakePlugin('team', (r) => {
          r.subagents.register({ ...fakeSubAgent('releaser'), middleware: [own] } as SubAgent);
        }),
      ],
      { repeatReminder: {} },
    );
    const names = (params.subagents[0]?.middleware ?? []).map(
      (mw) => (mw as unknown as { name: string }).name,
    );
    // 自帶的排在後面 ＝ 自帶的贏，同 `tools` 那條軸線。root 的 `registry.middleware`
    // 到不了 subagent，所以不打底的話那個 subagent 就完全沒有這道提醒。
    expect(names).toEqual([
      APPROVAL_GATE_MIDDLEWARE_NAME,
      REPEAT_REMINDER_MIDDLEWARE_NAME,
      'subagent-own',
    ]);
  });

  it('root 與每個 subagent 拿到的是同一份實例 —— 它無狀態，跟摘要器相反', async () => {
    const params = await fold(
      [
        fakePlugin('team', (r) => {
          r.subagents.register(fakeSubAgent('one'));
          r.subagents.register(fakeSubAgent('two'));
        }),
      ],
      { repeatReminder: {} },
    );
    const pick = (list: readonly unknown[]): unknown =>
      list.find((mw) => (mw as { name: string }).name === REPEAT_REMINDER_MIDDLEWARE_NAME);
    const instances = [
      pick(params.middleware),
      pick(params.subagents[0]?.middleware ?? []),
      pick(params.subagents[1]?.middleware ?? []),
    ];
    expect(instances.every((instance) => instance !== undefined)).toBe(true);
    // **三個位置一個物件。** 這不是「共用也還好」：鏈每次從那個 agent 自己的
    // `state.messages` 現算，隔離是結構上的，不是靠各建一份。
    expect(new Set(instances).size).toBe(1);
  });

  it('明著關掉就一份都不建，root 與 subagent 都沒有', async () => {
    const params = await fold(
      [fakePlugin('team', (r) => void r.subagents.register(fakeSubAgent('one')))],
      { repeatReminder: false },
    );
    expect(middlewareNames(params)).not.toContain(REPEAT_REMINDER_MIDDLEWARE_NAME);
    const names = (params.subagents[0]?.middleware ?? []).map(
      (mw) => (mw as unknown as { name: string }).name,
    );
    expect(names).not.toContain(REPEAT_REMINDER_MIDDLEWARE_NAME);
  });

  it('壞掉的門檻在 fold 當場拋，不是等到跑起來', async () => {
    await expect(
      fold([fakePlugin('noop', () => {})], { repeatReminder: { thresholds: [1] } }),
    ).rejects.toThrow(/repeatReminder\.thresholds/);
  });

  it('不需要 default backend —— 它不寫任何東西', async () => {
    const params = await fold([fakePlugin('noop', () => {})], { repeatReminder: {} });
    expect(middlewareNames(params)).toContain(REPEAT_REMINDER_MIDDLEWARE_NAME);
  });
});
