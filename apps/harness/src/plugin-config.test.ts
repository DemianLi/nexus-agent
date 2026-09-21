/**
 * 從 YAML 組裝 plugin 清單。
 *
 * ## 那條等價斷言已經退休了，而接手的是什麼要講清楚
 *
 * 搬家的那幾刀裡，這個檔案釘的是「`cordis.yml` 組出來的 == `DEFAULT_PLUGINS` 組出來的」，
 * 十五條通道逐條比。**那是一條遷移絆索，它的工作在接線落地那天就做完了。**
 *
 * 繼續留著它的代價是 `DEFAULT_PLUGINS` 得跟著留著，而它已經不在任何產品路徑上——那就變成
 * 第二份要維護的清單，而它守的是「副本相等」不是「設定是對的」。
 * [#490](https://github.com/DemianLi/nexus-agent/issues/490) 拒絕過這個形狀。
 *
 * **接手的不是另一條等價測試，是出貨檔自己變成了交付物**：`apps/harness/cordis.yml` 現在
 * 由 **17 個測試檔**經 `shippedPlugins()` 真的載進去組裝（`invariant-paths`、
 * `approval-gate-order`、`agent-instructions`、`session-telemetry-paths`、`sandbox-*`、
 * `goal-driver-cli`……），加上 `invariant-companions.test.ts` 與 `package-invariants.test.ts`
 * 的配套入口對帳（[#489](https://github.com/DemianLi/nexus-agent/issues/489)）。少掉一列、
 * 改錯一個 id 或一個 config 值，紅的是那些測試——它們量的是行為，不是清單長得像不像。
 *
 * 這個檔案留下的是**機制**：解析、疊加、權限、模組解析，以及出貨那一份真的組得起來。
 *
 * @see [#454](https://github.com/DemianLi/nexus-agent/issues/454)
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_REPEAT_REMINDER, DEFAULT_TOOL_RESULT_PRUNE } from '@nexus/core';

import {
  applyEntryPatches,
  composeEntries,
  loadOptionalPatches,
  loadOverlayPatches,
  loadPluginConfig,
  parseEntryList,
  renderConfigDump,
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

describe('出貨的 cordis.yml', () => {
  it('每一列都載得起來，而且每一顆都是真的 plugin', async () => {
    const fromYaml = await loadPluginConfig();
    // 30 = 7 個功能 ＋ 3 個 core middleware 設定（#456）＋ 20 個配套入口。**數目寫在這裡
    // 是為了擋「靜靜少一列」**：底下那些測試各自只看得到自己關心的那幾列，少掉一個空
    // installer 不會有人紅。確切該有哪些配套入口由 `invariant-companions.test.ts` 對帳（#489）。
    expect(fromYaml).toHaveLength(30);
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

  /**
   * **這一條是量出來的，不是想出來的。**
   *
   * 等價斷言退休之後跑了一輪突變，問「`cordis.yml` 被改壞時還有沒有人紅」。結構那幾格答案
   * 是有：少一列 present → 3 個檔紅、少一列 plan-mode → 6 個檔、少一個空 installer 的配套
   * 入口 → 3 個檔、改一個 id → `approval-gate-order` 紅、把 goal 關掉 → 4 個檔。
   *
   * **但那幾個 `config` 值改掉是全綠的。** 它們只在執行期被讀，不在任何註冊點上留下痕跡，所以
   * 十七個載出貨清單的測試檔一個都不會動。那是等價探針原本蓋著、而它退休之後露出來的洞。
   *
   * **這不是「副本相等」那個反模式**：它釘的不是整份清單，是**幾個被決定過的數字**，而且
   * 每一個都寫得出它的出處。清單長什麼樣仍然由上面那些行為測試守著。
   *
   * `repeat-reminder` 是 [#456](https://github.com/DemianLi/nexus-agent/issues/456) 加進來的
   * 第三列，而它的四格**同時也是 plugin schema 的預設值**——兩份會悄悄漂，所以下面那一條
   * 直接拿常數對它，不是再抄一次數字。
   */
  it('只在執行期被讀的 config 值，改掉不會有別人紅——所以釘在這裡', () => {
    const byId = new Map(composeEntries().map((entry) => [entry.id, entry.config]));

    // 這棵樹的 subagent 是真的併發跑的（`tool-session-log.test.ts` 那條同一個 subagent
    // 併發兩次的驗收），而 dsh 對這種部署開的就是 true。這個開關沒有預設值。
    expect(byId.get('todo')).toEqual({ allowParallelInProgress: true });

    // 一則評分備註最多幾個 UTF-8 位元組。照 dsh web 那一包的設定
    // （`packages/bundle/web-app/cordis.patch.yml:56`，`c291e79`）；plugin 自己不給預設值，
    // 所以出貨檔那一行是整棵樹上唯一講這個數字的地方。
    expect(byId.get('feedback')).toEqual({ maxNoteBytes: 8192 });

    // **出貨檔寫出來的那四格，值必須就是 plugin schema 的預設**（#456）。寫出來是刻意的
    // ——patch 是整份替換 `config`，照著改的人手上要有完整的一份可以抄，而
    // `--dump-config` 印的是疊完的原始列、看不到 schema 裡的預設值。代價是同一組數字有
    // 兩份，所以這一行拿常數對它：漂了就紅，而不是等到某天有人發現產品跟預設不一樣。
    expect(byId.get('repeat-reminder')).toEqual({ ...DEFAULT_REPEAT_REMINDER });

    // 剪刀那三格同理（#456）。
    expect(byId.get('tool-result-pruner')).toEqual({ ...DEFAULT_TOOL_RESULT_PRUNE });

    // **其餘每一列都不帶 config**，這半句同樣承重：二十個配套入口一個 `Config` schema 都
    // 沒有，給它們設定會在載入時拋（`parseEntryConfig`）。
    //
    // **`observation-policy` 不在這張名單上，而那是承重的不對稱**（#456）：那一顆沒有設定、
    // 也沒有 Config schema，所以替它加一行 `config:` 會在載入期拋。它進到這棵樹裡的唯一
    // 意義是「關得掉」，關掉的行為由 `observation-policy-entry` 那組測試守著。
    const withConfig = [...byId].filter(([, config]) => config !== undefined).map(([id]) => id);
    expect(withConfig).toEqual(['todo', 'feedback', 'repeat-reminder', 'tool-result-pruner']);
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

describe('--dump-config', () => {
  /**
   * **不做黃金檔比對。** dsh 自己的開發備註寫著這份輸出不承諾跨包版本的位元組穩定性
   * （`packages/boot/app-boot/README.zh.md` 的「待定：配置 dump 稳定性」）。照抄一個它自己
   * 說不穩定的東西當判準，是把別人的免責聲明變成我們的絆索。所以驗的是結構性質。
   */
  it('印出來的東西讀得回來，而且就是啟動真的會掛的那一份', () => {
    const dumped = renderConfigDump();
    // (a) 它是一份合法的 YAML 文件——`# ==` 註解不會讓它讀不回來。
    const reparsed = parseEntryList(dumped, 'dump');
    // (b) 讀回來的條目清單與 `composeEntries` 完全相同。**這是 dump 與啟動同源的驗收句。**
    expect(reparsed).toEqual(composeEntries());
  });

  it('每一段連續的列前面都有它的來源註解', () => {
    const root = privateDirectory();
    const shipped = writePrivate(
      root,
      'cordis.yml',
      "- id: echo\n  name: '@nexus/plugin-echo'\n- id: todo\n  name: '@nexus/plugin-todo'\n",
    );
    const overlay = writePrivate(
      root,
      'o.yml',
      '- id: todo\n  config: { allowParallelInProgress: true }\n',
    );

    const dumped = renderConfigDump({ shipped, overlays: [overlay], warn: () => {} });
    // 第一段只有出貨檔改過；第二段被 overlay 修過，所以標籤不一樣，分成兩段。
    expect(dumped).toContain(`# == ${shipped}\n`);
    expect(dumped).toContain(`# == ${shipped}, patched by ${overlay}\n`);
    expect(parseEntryList(dumped, 'dump')).toHaveLength(2);
  });

  it('insert 進來的列，來源記成插它的那一層', () => {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', "- id: echo\n  name: '@nexus/plugin-echo'\n");
    const overlay = writePrivate(
      root,
      'o.yml',
      "- insert:\n    - id: todo\n      name: '@nexus/plugin-todo'\n",
    );

    const dumped = renderConfigDump({ shipped, overlays: [overlay], warn: () => {} });
    expect(dumped).toContain(`# == ${overlay}\n`);
    expect(parseEntryList(dumped, 'dump')).toHaveLength(2);
  });

  it('沒命中任何列的 patch 帶著層標籤報出去', () => {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', "- id: echo\n  name: '@nexus/plugin-echo'\n");
    const overlay = writePrivate(root, 'o.yml', '- id: 不在\n  config: {}\n');
    const said: string[] = [];

    renderConfigDump({ shipped, overlays: [overlay], warn: (message) => said.push(message) });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`[${overlay}]`);
    expect(said[0]).toContain('"不在"');
  });

  it('兩層各自的警告歸各自那一層，不會全部掛在最後一層上', () => {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', "- id: echo\n  name: '@nexus/plugin-echo'\n");
    const first = writePrivate(root, 'a.yml', '- id: 甲不在\n  config: {}\n');
    const second = writePrivate(root, 'b.yml', '- id: 乙不在\n  config: {}\n');
    const said: string[] = [];

    renderConfigDump({ shipped, overlays: [first, second], warn: (m) => said.push(m) });
    expect(said).toHaveLength(2);
    expect(said[0]).toContain(`[${first}]`);
    expect(said[0]).toContain('甲不在');
    expect(said[1]).toContain(`[${second}]`);
    expect(said[1]).toContain('乙不在');
  });

  it('設定壞掉時 dump 也失敗，不印一棵啟動不起來的樹', () => {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', "- id: echo\n  name: '@nexus/plugin-echo'\n");
    const overlay = writePrivate(root, 'o.yml', '- id: echo\n  inject: [x]\n');
    expect(() => renderConfigDump({ shipped, overlays: [overlay], warn: () => {} })).toThrow(
      PluginConfigError,
    );
  });
});

describe('insert 的模組路徑錨在 patch 檔旁邊', () => {
  /**
   * **這一組守的是一個會安靜載錯模組的缺陷。** 裸的相對 specifier 錨在做 `import()` 的那個
   * 模組上（`plugin-config.ts`），不是使用者手上那個 patch 檔。沒有錨定的話 `./probe.ts`
   * 會被解析到 `apps/harness/src/probe.ts`——今天那裡沒有這個檔所以是「載不起來」，哪天有了
   * 就變成「載到別的東西，而且不吭聲」。
   */
  function probeModule(root: string, name: string, pluginName: string): string {
    const path = join(root, name);
    writeFileSync(path, `export default { name: '${pluginName}', apply() {} };\n`);
    chmodSync(path, 0o600);
    return path;
  }

  it('相對 patch 檔的 ./ 指得到它旁邊那個模組', async () => {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', '[]\n');
    probeModule(root, 'probe.ts', 'probe');
    const patch = writePrivate(
      root,
      'p.yml',
      "- insert:\n    - id: probe\n      name: './probe.ts'\n",
    );

    const loaded = await loadPluginConfig({ shipped, overlays: [patch], warn: () => {} });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.plugin.name).toBe('probe');
  });

  it('../ 也指得到，錨點是 patch 檔不是 cwd 也不是 loader', async () => {
    const root = privateDirectory();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const shipped = writePrivate(root, 'cordis.yml', '[]\n');
    probeModule(root, 'up.ts', 'up');
    const patch = writePrivate(
      nested,
      'p.yml',
      "- insert:\n    - id: up\n      name: '../up.ts'\n",
    );

    const loaded = await loadPluginConfig({ shipped, overlays: [patch], warn: () => {} });
    expect(loaded[0]?.plugin.name).toBe('up');
  });

  it('絕對路徑也轉成 file URL', async () => {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', '[]\n');
    const module = probeModule(root, 'abs.ts', 'abs');
    const patch = writePrivate(
      root,
      'p.yml',
      `- insert:\n    - id: abs\n      name: '${module}'\n`,
    );

    const loaded = await loadPluginConfig({ shipped, overlays: [patch], warn: () => {} });
    expect(loaded[0]?.plugin.name).toBe('abs');
  });

  it('裸的套件名原樣留給 Node 解析——轉成 URL 會變成一個不存在的路徑', async () => {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', '[]\n');
    const patch = writePrivate(
      root,
      'p.yml',
      "- insert:\n    - id: echo\n      name: '@nexus/plugin-echo'\n",
    );

    const loaded = await loadPluginConfig({ shipped, overlays: [patch], warn: () => {} });
    expect(loaded[0]?.plugin.name).toBe('echo');
  });

  it('對既有條目的 name 斷言不動——轉了它就永遠比不中', () => {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', "- id: echo\n  name: '@nexus/plugin-echo'\n");
    // `name` 在這裡是斷言：它必須跟清單上那個字串比得中，patch 才會套上去。
    const patch = writePrivate(
      root,
      'p.yml',
      "- id: echo\n  name: '@nexus/plugin-echo'\n  disabled: true\n",
    );
    const said: string[] = [];

    const entries = composeEntries({ shipped, overlays: [patch], warn: (m) => said.push(m) });
    expect(said).toEqual([]);
    expect(entries[0]).toMatchObject({ disabled: true });
  });
});
