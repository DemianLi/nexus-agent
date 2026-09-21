/**
 * 從 YAML 組裝 plugin 清單。
 *
 * **第一個 describe 才是這一份的理由**：出貨的 `cordis.yml` 組出來的東西，與 develop 上
 * 那份 `DEFAULT_PLUGINS` 組出來的東西，在 `PluginRegistry` 的**十五條通道上逐條相等**。
 *
 * 比兩份清單的 plugin 名稱是量相似品：兩邊叫得出同一串名字，而註冊內容可以完全不同。
 * 所以比的是**組裝的結果**——每一條通道各自的列舉讀法，逐條投影出內容。通道的清單不是
 * 手抄的，是 [`registry-channel-count.test.ts`](./registry-channel-count.test.ts) 那份
 * `satisfies Record<keyof PluginRegistry, true>` 的窮舉表；少一條或多一條都在 `typecheck`
 * 當場紅，所以第十六條通道落地那天，這個探針會跟著要求回答「它等不等價」。
 *
 * **`origin.id` 刻意不進投影，而這是一個要明著講的差異。** `PluginOrigin` 是
 * `{ id, name }`；`DEFAULT_PLUGINS` 的條目沒寫 `id`，由 `resolveEntries` 補
 * `<name>#<序號>`，而 `cordis.yml` 寫的是看得懂的 id——id 存在的理由就是讓外部 patch 指得
 * 著它，所以兩條路的 id 本來就不該相同。那一格由底下「id 就是 YAML 宣告的那些」單獨釘。
 *
 * @see [#454](https://github.com/DemianLi/nexus-agent/issues/454)
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { InternalPluginRegistry, PluginEntry } from '@nexus/core';
import { loadPlugins, resolveEntries } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PLUGINS } from './cli.js';
import {
  applyEntryPatches,
  composeEntries,
  loadOptionalPatches,
  loadOverlayPatches,
  loadPluginConfig,
  parseEntryList,
  parsePatchList,
  PluginConfigError,
  resolveEntryModule,
  shippedConfigPath,
  validateEntries,
  assertPrivateFile,
} from './plugin-config.js';

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一個只有自己動得了的臨時目錄。**不碰真的 `~/.nexus-agent`。** */
function privateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-plugin-config-'));
  temporary.push(root);
  chmodSync(root, 0o700);
  return root;
}

function writePrivate(root: string, name: string, content: string): string {
  const path = join(root, name);
  writeFileSync(path, content);
  chmodSync(path, 0o600);
  return path;
}

/** 十五條通道逐條的內容投影。鍵是通道名，值是那條通道上註冊了什麼。 */
function projectRegistry(registry: InternalPluginRegistry): Record<string, unknown> {
  return {
    tools: [...registry.tools.effective().entries()].map(([name, entry]) => ({
      name,
      origin: entry.origin.name,
      description: entry.value.description,
      rootOnly: registry.tools.isRootOnly(name),
      hasOutputSchema: registry.tools.outputSchemaOf(entry.value) !== undefined,
    })),
    toolScopes: registry.tools.scopes(),
    subagents: [...registry.subagents.entries()].map(([name, entry]) => ({
      name,
      origin: entry.origin.name,
    })),
    capabilities: registry.capabilities.names().map((name) => ({
      name,
      providers: registry.capabilities.providers(name).map((o) => o.name),
    })),
    services: registry.services
      .names()
      .map((name) => ({ name, provider: registry.services.provider(name)?.name })),
    backend: registry.backend.mounts().map(([prefix, entry]) => ({
      prefix,
      origin: entry.origin.name,
    })),
    // 順序是承重的：middleware 的先後決定誰包住誰。
    middleware: registry.middleware.list().map((entry) => ({
      origin: entry.origin.name,
      prepend: entry.value.prepend,
      kind: entry.value.build === undefined ? 'instance' : 'build',
      name: entry.value.middleware?.name,
    })),
    permissions: registry.permissions.rules().map((entry) => ({
      origin: entry.origin.name,
      paths: entry.value.paths,
      except: entry.value.except,
    })),
    // 核准閘門的順序同樣承重（`approval-gate-order.test.ts`）。
    approvals: registry.approvals.listeners().map((entry) => entry.origin.name),
    skills: registry.skills.sources(),
    memory: registry.memory.sources(),
    lifecycle: registry.lifecycle.disposers().map((entry) => entry.origin.name),
    telemetry: registry.telemetry.rules().map((entry) => entry.origin.name),
    invariants: registry.invariants.companions().map((companion) => companion.packageName),
    commands: registry.commands.list().map((descriptor) => ({ ...descriptor })),
    sessions: registry.sessions.installers().map((entry) => entry.origin.name),
  };
}

/**
 * 註冊內容 ＋ **每一次掛載驗過的 `config`**。
 *
 * 通道投影看不到全部的設定：一個只在執行期被讀的值（`@nexus/plugin-feedback` 的
 * `maxNoteBytes` 就是）不會在任何註冊點上留下痕跡，改掉它十五條通道一條都不會動。實測過
 * ——把 `cordis.yml` 的 8192 改成 4096，只比通道的那一版是綠的。所以 `resolveEntries` 驗完
 * 的 `config` 也要比：那是**真的交給 `apply` 的那一份**，不是 YAML 的原文。
 */
async function project(plugins: readonly PluginEntry[]): Promise<Record<string, unknown>> {
  const loaded = await loadPlugins(plugins);
  try {
    return {
      ...projectRegistry(loaded.registry),
      entries: resolveEntries(plugins).map(({ origin, disabled, config }) => ({
        name: origin.name,
        disabled,
        config,
      })),
    };
  } finally {
    await loaded.dispose();
  }
}

describe('出貨的 cordis.yml', () => {
  it('組出來的東西與 DEFAULT_PLUGINS 在十五條通道上逐條相等', async () => {
    const fromYaml = await loadPluginConfig();
    expect(await project(fromYaml)).toEqual(await project(DEFAULT_PLUGINS));
  });

  it('條目數與 DEFAULT_PLUGINS 一樣，而且每一列都載得起來', async () => {
    const fromYaml = await loadPluginConfig();
    expect(fromYaml).toHaveLength(DEFAULT_PLUGINS.length);
    for (const entry of fromYaml) expect(typeof entry.plugin.apply).toBe('function');
  });

  it('id 就是 YAML 宣告的那些——外部 patch 指得著的就是這一組', async () => {
    const ids = composeEntries().map((entry) => entry.id);
    expect(ids).not.toContain(undefined);
    expect(ids).toContain('echo');
    expect(ids).toContain('core-invariant');
    // 二十個配套入口一個不漏，對帳的另一半在 `invariant-companions.test.ts`。
    expect(ids.filter((id) => id?.endsWith('-invariant'))).toHaveLength(20);
  });

  it('出貨檔的路徑指到真的存在的那一份', () => {
    expect(shippedConfigPath()).toMatch(/apps\/harness\/cordis\.yml$/u);
    expect(() => composeEntries()).not.toThrow();
  });
});

describe('解析', () => {
  it('頂層不是陣列就拋——空檔與只有註解的檔都算', () => {
    expect(() => parseEntryList('', 'x.yml')).toThrow(PluginConfigError);
    expect(() => parseEntryList('# 只有註解\n', 'x.yml')).toThrow('頂層必須是一個陣列');
    expect(() => parseEntryList('id: echo\n', 'x.yml')).toThrow('頂層必須是一個陣列');
  });

  it('`[]` 是合法的——那是「這一層什麼都不做」的寫法', () => {
    expect(parseEntryList('[]\n', 'x.yml')).toEqual([]);
    expect(parsePatchList('[]\n', 'x.yml')).toEqual([]);
  });

  it('某一列不是一張表就拋，訊息指得出是第幾列', () => {
    expect(() => parseEntryList('- echo\n- name: x\n', 'x.yml')).toThrow('第 1 列');
  });

  it('YAML 壞掉就拋，而且說是哪個檔', () => {
    expect(() => parseEntryList('- [unclosed\n', 'broken.yml')).toThrow('broken.yml');
  });

  it('多寫一個欄位是打錯字，不是擴充點', () => {
    expect(() => validateEntries([{ name: '@nexus/plugin-echo', inject: ['x'] }], 'x.yml')).toThrow(
      PluginConfigError,
    );
  });

  it('`config:` 沒給值會被擋下來，訊息指得出是哪一列', () => {
    expect(() => validateEntries([{ name: '@nexus/plugin-echo', config: null }], 'x.yml')).toThrow(
      '第 1 列',
    );
  });

  it('兩列同一個 id 就拋', () => {
    expect(() =>
      validateEntries(
        [
          { id: 'a', name: '@nexus/plugin-echo' },
          { id: 'a', name: '@nexus/plugin-todo' },
        ],
        'x.yml',
      ),
    ).toThrow('都寫了 id "a"');
  });
});

describe('疊加', () => {
  const base = [
    { id: 'echo', name: '@nexus/plugin-echo' },
    { id: 'todo', name: '@nexus/plugin-todo', config: { allowParallelInProgress: true } },
  ];

  it('config 是整份替換，不是深層合併', () => {
    const out = applyEntryPatches(base, [{ id: 'todo', config: { maxItems: 3 } }], () => {});
    expect(out[1]).toEqual({ id: 'todo', name: '@nexus/plugin-todo', config: { maxItems: 3 } });
  });

  it('輸入不會被改，所以同一份清單可以重放', () => {
    const before = structuredClone(base);
    applyEntryPatches(base, [{ id: 'todo', config: { maxItems: 3 } }], () => {});
    expect(base).toEqual(before);
  });

  it('disabled 疊得上去', () => {
    const out = applyEntryPatches(base, [{ id: 'echo', disabled: true }], () => {});
    expect(out[0]).toMatchObject({ id: 'echo', disabled: true });
  });

  it('insert 接在尾巴，而且同一串裡後面的 patch 指得到它', () => {
    const out = applyEntryPatches(
      base,
      [
        { insert: [{ id: 'present', name: '@nexus/plugin-present' }] },
        { id: 'present', config: { maxFiles: 3 } },
      ],
      () => {},
    );
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      id: 'present',
      name: '@nexus/plugin-present',
      config: { maxFiles: 3 },
    });
  });

  it('不是 insert 又沒有 id 的 patch 會被跳過並講一聲', () => {
    const said: string[] = [];
    const out = applyEntryPatches(base, [{ config: { x: 1 } }], (message) => said.push(message));
    expect(out).toEqual(base);
    expect(said[0]).toContain('一定要有 id');
  });

  it('id 找不到是警告不是失敗——一份 overlay 可以給多棵樹共用', () => {
    const said: string[] = [];
    const out = applyEntryPatches(base, [{ id: '不在', config: {} }], (m) => said.push(m));
    expect(out).toEqual(base);
    expect(said[0]).toContain('"不在"');
  });

  it('name 是斷言不是選擇器：對不上就跳過，原列一個字都不動', () => {
    const said: string[] = [];
    const out = applyEntryPatches(
      base,
      [{ id: 'todo', name: '@nexus/plugin-echo', config: { maxItems: 3 } }],
      (m) => said.push(m),
    );
    expect(out).toEqual(base);
    expect(said[0]).toContain('name 對不上');
  });

  it('形狀在疊完之後才驗——patch 塞不認得的欄位擋得住', () => {
    const rows = applyEntryPatches(base, [{ id: 'echo', inject: ['x'] } as never], () => {});
    expect(() => validateEntries(rows, 'x.yml')).toThrow(PluginConfigError);
  });

  it('整條路上也是疊完才驗——先驗再疊的話 patch 就能把壞欄位塞進驗過的列', () => {
    // 這一條與上面那條不一樣：上面驗的是兩個函式各自的行為，這裡驗的是 `composeEntries`
    // **把它們接起來的順序**。把驗證搬到疊加之前，上面那條照樣綠，這一條會綠掉。
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', "- id: echo\n  name: '@nexus/plugin-echo'\n");
    const overlay = writePrivate(root, 'o.yml', '- id: echo\n  inject: [x]\n');
    expect(() => composeEntries({ shipped, overlays: [overlay], warn: () => {} })).toThrow(
      PluginConfigError,
    );
  });
});

describe('層與檔案', () => {
  it('home 那一層檔案不在就是沒有這一層', () => {
    const root = privateDirectory();
    expect(loadOptionalPatches(join(root, 'cordis.patch.yml'))).toBeUndefined();
  });

  it('--patch 指到不存在的檔就拋——是呼叫方指名它的', () => {
    const root = privateDirectory();
    expect(() => loadOverlayPatches(join(root, '沒這個檔.yml'))).toThrow(PluginConfigError);
  });

  it('兩個 overlay 時後面那個蓋前面那個', () => {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', "- id: todo\n  name: '@nexus/plugin-todo'\n");
    const first = writePrivate(
      root,
      'a.yml',
      '- id: todo\n  config: { allowParallelInProgress: true }\n',
    );
    const second = writePrivate(
      root,
      'b.yml',
      '- id: todo\n  config: { allowParallelInProgress: false }\n',
    );

    expect(composeEntries({ shipped, overlays: [first, second], warn: () => {} })[0]).toMatchObject(
      {
        config: { allowParallelInProgress: false },
      },
    );
    // **對調而不是刪掉**：刪掉一層只證明那一層不能省，證不出順序。
    expect(composeEntries({ shipped, overlays: [second, first], warn: () => {} })[0]).toMatchObject(
      {
        config: { allowParallelInProgress: true },
      },
    );
  });

  it('home 那一層排在 --patch 之前', () => {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', "- id: todo\n  name: '@nexus/plugin-todo'\n");
    const home = writePrivate(root, 'cordis.patch.yml', '- id: todo\n  config: { a: 1 }\n');
    const overlay = writePrivate(root, 'o.yml', '- id: todo\n  config: { a: 2 }\n');

    expect(
      composeEntries({ shipped, userPatch: home, overlays: [overlay], warn: () => {} })[0],
    ).toMatchObject({ config: { a: 2 } });
  });

  it('出貨檔讀不到就拋', () => {
    const root = privateDirectory();
    expect(() => composeEntries({ shipped: join(root, '沒這個檔.yml') })).toThrow('讀不到出貨的');
  });
});

describe('權限', () => {
  it('自己的、0600、放在只有自己進得去的目錄裡——放行', () => {
    const root = privateDirectory();
    expect(() => assertPrivateFile(writePrivate(root, 'ok.yml', '[]\n'))).not.toThrow();
  });

  it('群組可寫就拒絕，訊息指名是哪個檔', () => {
    const root = privateDirectory();
    const path = writePrivate(root, 'g.yml', '[]\n');
    chmodSync(path, 0o620);
    expect(() => assertPrivateFile(path)).toThrow('群組或其他人可寫');
  });

  it('其他人可寫就拒絕', () => {
    const root = privateDirectory();
    const path = writePrivate(root, 'o.yml', '[]\n');
    chmodSync(path, 0o602);
    expect(() => assertPrivateFile(path)).toThrow('群組或其他人可寫');
  });

  it('上層目錄別人可寫就拒絕——別人換得掉底下的檔案', () => {
    const root = privateDirectory();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const path = writePrivate(nested, 'p.yml', '[]\n');
    chmodSync(nested, 0o777);
    expect(() => assertPrivateFile(path)).toThrow('的上層目錄');
  });

  it('讀 patch 的路徑上真的有在檢查', () => {
    const root = privateDirectory();
    const path = writePrivate(root, 'cordis.patch.yml', '[]\n');
    chmodSync(path, 0o666);
    expect(() => loadOptionalPatches(path)).toThrow(PluginConfigError);
    expect(() => loadOverlayPatches(path)).toThrow(PluginConfigError);
  });
});

describe('模組解析', () => {
  it('default export 那一顆就是掛上去的那一顆', async () => {
    const entry = await resolveEntryModule({ id: 'echo', name: '@nexus/plugin-echo' });
    expect(entry.plugin.name).toBe('echo');
    expect(entry.id).toBe('echo');
  });

  it('config 與 disabled 原封不動帶過去', async () => {
    const entry = await resolveEntryModule({
      id: 'todo',
      name: '@nexus/plugin-todo',
      config: { allowParallelInProgress: true },
      disabled: true,
    });
    expect(entry).toMatchObject({ disabled: true, config: { allowParallelInProgress: true } });
  });

  it('沒寫 config 就不帶——沒有 Config 的 plugin 收到設定會拋', async () => {
    const entry = await resolveEntryModule({ name: '@nexus/core/invariant' });
    expect('config' in entry).toBe(false);
  });

  it('模組載不起來時訊息指得出是哪一列', async () => {
    await expect(resolveEntryModule({ id: '壞的', name: '@nexus/根本沒這個套件' })).rejects.toThrow(
      '"壞的"',
    );
  });

  it('模組載得起來但不是一顆 plugin 也拋', async () => {
    await expect(resolveEntryModule({ name: 'node:path' })).rejects.toThrow('沒有匯出一顆 plugin');
  });
});
