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

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_REPEAT_REMINDER,
  DEFAULT_SUMMARIZATION,
  DEFAULT_TOOL_RESULT_PRUNE,
} from '@nexus/core';

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
  PluginModuleAccessError,
  resolveEntryModule,
  shippedConfigPath,
  validateEntries,
  assertPrivateFile,
  PROTECTED_ENTRY_NAMES,
  PROTECTED_ENTRY_REASONS,
} from './plugin-config.js';
import { DEFAULT_PERSISTENCE_WINDOW_MS } from '@nexus/core';

import { DEFAULT_BROWSER_SESSION_MAX_AGE_DAYS } from './settings/browser-session.js';
import {
  DEFAULT_DELIVERABLE_MAX_FILE_BYTES,
  DEFAULT_DELIVERABLE_MAX_LINES,
  DEFAULT_DELIVERABLE_MAX_PAGE_BYTES,
} from './settings/deliverable-files.js';
import { DEFAULT_RECURSION_LIMIT } from './settings/recursion-limit.js';
import { PROJECTION_FLUSH_MS } from './projection-coalescer.js';
import { projectionFlushConfigSchema } from './settings/projection-flush.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';
import { DEFAULT_TOOL_RESULT_STASH_RETENTION_DAYS } from './settings/tool-result-stash.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from './settings/agent-loop.js';
import { toolFsSearchConfigSchema } from './settings/tool-fs-search.js';
import { threadSearchConfigSchema } from './settings/thread-search.js';
import { threadTitleLlmConfigSchema } from './settings/thread-title-llm.js';
import {
  DEFAULT_THREAD_TITLE_MAX_BYTES,
  DEFAULT_THREAD_TITLE_MAX_TITLE_BYTES,
  DEFAULT_THREAD_TITLE_MAX_WORDS,
} from './settings/thread-title.js';

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
    const { plugins: fromYaml, dropped, ignoredConfig } = await loadPluginConfig();
    expect(dropped).toEqual([]);
    expect(ignoredConfig).toEqual([]);
    // 48 = 15 個功能（#440 加了 `skills`，#669 加了 `ask-user`、`submit-record` 與 `sandbox-policy`，#1027 加了 `trajectory`，#1028 加了 `token-meter`，#437 加了 `permission-presets`）＋ 8 個 core 的條目（#456：5 顆 middleware 設定 ＋ 關不掉的核准閘門，
    // 外加 #529 的 `session-persistence`——它是 core 那一段裡唯一消費點在起動期的——與 #599 的
    // `session-checkpoint-policy`）
    // ＋ **16 個 harness 自己的設定條目**（#529、#538、#545、#650、#631、#734、#719、#841、#875、#711、#670、#735、#1071；#670 之後 `agent-default-model` 旁多一列出貨的腳本提供者 `cli-script`，所以是 17 個）＋ 8 個配套入口（#974 之前是 20 個，其中 12 個是空 installer，拿掉後 53 → 41）。**數目寫在這裡是為了擋
    // 「靜靜少一列」**：底下那些測試各自只看得到自己關心的那幾列，少掉一個配套入口
    // 不會有人紅。確切該有哪些配套入口由 `invariant-companions.test.ts` 對帳（#489）。
    //
    // **這一條同時是 `#settings/…` 這個載體唯一的整條路驗收**（#529）：它走的是真的
    // `loadPluginConfig`，所以那八列要真的經由 `apps/harness/package.json` 的 `imports`
    // 解析、import、而且長得像一顆 plugin，才數得到 48。拿掉那個 `imports` 區塊，這裡當場紅。
    expect(fromYaml).toHaveLength(48);
    for (const entry of fromYaml) expect(typeof entry.plugin.apply).toBe('function');
  });

  it('id 就是 YAML 宣告的那些——外部 patch 指得著的就是這一組', async () => {
    const ids = composeEntries().map((entry) => entry.id);
    expect(ids).not.toContain(undefined);
    expect(ids).toContain('echo');
    expect(ids).toContain('core-invariant');
    // 八個配套入口一個不漏，對帳的另一半在 `invariant-companions.test.ts`。
    expect(ids.filter((id) => id?.endsWith('-invariant'))).toHaveLength(8);
  });

  /**
   * **這一條是量出來的，不是想出來的。**
   *
   * 等價斷言退休之後跑了一輪突變，問「`cordis.yml` 被改壞時還有沒有人紅」。結構那幾格答案
   * 是有：少一列 present → 3 個檔紅、少一列 plan-mode → 6 個檔、少一個空 installer 的配套
   * 入口 → 3 個檔（當時有；#974 之後沒有空 installer，這一格不能再量）、改一個 id → `approval-gate-order` 紅、把 goal 關掉 → 4 個檔。
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

    // 摘要那四格同理（#456）。`tokens: 100000` 的來歷在 `DEFAULT_SUMMARIZATION` 的檔頭上，
    // 這一行只管出貨檔跟它沒有漂開。
    expect(byId.get('summarization')).toEqual({ ...DEFAULT_SUMMARIZATION });

    // **其餘每一列都不帶 config**，這半句同樣承重：八個配套入口一個 `Config` schema 都
    // 沒有，給它們設定沒有作用——照 dsh 原樣交下去、不驗，啟動時印警告（#751）。
    //
    // **`observation-policy` 不在這張名單上，而那是承重的不對稱**（#456）：那一顆沒有設定、
    // 也沒有 Config schema，替它加一行 `config:` 沒有作用、啟動時印警告。它進到這棵樹裡的唯一
    // 意義是「關得掉」，關掉的行為由 `observation-policy-entry` 那組測試守著。
    // harness 自己那八列（#529）：跟上面那幾列同一個用途（只講設定），擁有者住在 `apps/harness`。
    // 前七列的消費者跑在任何 agent 出生之前，所以 `apply` 是空的、值由 `startupSetting` 在起動期
    // 讀；`recursion-limit` 的消費者在組裝期，所以它跟上面那幾列一樣走服務。
    expect(byId.get('thread-title')).toEqual({
      maxWords: DEFAULT_THREAD_TITLE_MAX_WORDS,
      maxBytes: DEFAULT_THREAD_TITLE_MAX_BYTES,
      maxTitleBytes: DEFAULT_THREAD_TITLE_MAX_TITLE_BYTES,
    });
    // **LLM 標題那五格**（#650）。出貨那一列五格全寫出來，值必須就是 schema 的預設，同上面幾列。
    expect(byId.get('thread-title-llm')).toEqual(threadTitleLlmConfigSchema.parse({}));
    // **內容搜尋出廠不開**（#631），這一列是**唯一不等於 schema 預設的**：預設是 `startup`（同 dsh），出廠寫 `never`（同
    // dsh `base` 與 `web-app` 兩個 bundle，dsh 也用測試釘這一列）。改成開著是部署的選擇，不該是有人順手改了出貨檔。
    expect(byId.get('thread-search')).toEqual({ openAt: 'never' });
    expect(threadSearchConfigSchema.parse({})).toEqual({ openAt: 'startup' });
    expect(byId.get('browser-session')).toEqual({
      maxAgeDays: DEFAULT_BROWSER_SESSION_MAX_AGE_DAYS,
    });
    expect(byId.get('deliverable-files')).toEqual({
      maxBytes: DEFAULT_DELIVERABLE_MAX_PAGE_BYTES,
      maxFileBytes: DEFAULT_DELIVERABLE_MAX_FILE_BYTES,
      maxLines: DEFAULT_DELIVERABLE_MAX_LINES,
    });
    // **每則工具結果文字的上限**（#538）。出貨那一行的值必須就是 schema 的預設，同上面幾列。
    expect(byId.get('tool-text')).toEqual({ maxBytes: DEFAULT_TOOL_TEXT_MAX_BYTES });
    // **插件投影 frame 的合併視窗**（#1071）。出貨那一行的值必須就是 schema 的預設（合併器的 100），同上面幾列。
    expect(byId.get('projection-flush')).toEqual({ flushMs: PROJECTION_FLUSH_MS });
    expect(projectionFlushConfigSchema.parse({})).toEqual({ flushMs: PROJECTION_FLUSH_MS });
    // **過大工具結果的暫存**（#734）。`root` 不寫（缺席才是 harness home 底下的預設位置），保留天數寫出來，值必須就是預設。
    expect(byId.get('tool-result-stash')).toEqual({
      cleanupPeriodDays: DEFAULT_TOOL_RESULT_STASH_RETENTION_DAYS,
    });
    // **工具結果外溢層**（#719）。出貨值是 dsh base 的 12500；這一格**沒有 schema 預設**（省略就是停用，照 dsh），
    // 所以出貨那一行必須把它寫出來——刪掉它，外溢層就靜靜停用，回到基座 80,000 字元那條線。
    expect(byId.get('spill-policy')).toEqual({ maxInlineTokens: 12_500 });
    // **搜尋結果的筆數上限**（#735）。出貨那一行的值必須就是 schema 的預設（dsh 的 250／100），同上面幾列。
    expect(byId.get('tool-fs-search')).toEqual(toolFsSearchConfigSchema.parse({}));
    // **背景續行**（#841）。出貨值是 dsh base 打開的 `continuable`，**不是 schema 的預設**（schema 預設 `one-shot`，照 dsh）：
    // 刪掉出貨那一行的 `backgroundMode`，預設就靜靜翻回一次性，模型看不到 `subagent`。
    expect(byId.get('background-subagents')).toEqual({
      backgroundMode: 'continuable',
      maxActiveSubagents: 8,
    });
    // **子代理選模型**（#875）。出廠關著、清單空，同 dsh：打開得是使用者自己寫的決定，不是出貨值替他選。
    expect(byId.get('subagent-model-selection')).toEqual({ enabled: false, allowedModels: [] });
    // **真實供應商那五格**（#545）。出貨那一列五格全寫出來，值就是 schema 的預設——**除了型錄多一筆**：出貨清單的第二顆是
    // 看圖模型（#731 判定，每會話選擇 #723 才有東西可選），schema 的預設型錄仍只有預設那一顆。
    const shippedLive = liveModelConfigSchema.parse({});
    expect(byId.get('live-model')).toEqual({
      ...shippedLive,
      models: [
        ...shippedLive.models,
        {
          id: 'meta/llama-3.2-11b-vision-instruct',
          contextWindow: 131072,
          maxTokens: 4096,
          input: ['text', 'image'],
        },
      ],
    });
    // **沒帶 `--live` 時的模型提供者**（#670）。出貨值指到清單上 id 為 `cli-script` 的那一列腳本提供者（下面 `cli-script`）。
    expect(byId.get('agent-default-model')).toEqual({ provider: 'cli-script' });

    // `recursion-limit` 是這八列裡唯一走服務的（消費點在組裝期，註冊表在手上）——
    // 它的 `apply` 不是空的，三態的解析由 `agent-factory.test.ts` 那組釘著。
    expect(byId.get('recursion-limit')).toEqual({ limit: DEFAULT_RECURSION_LIMIT });
    // **每步平行工具呼叫上限**（#711）同形：走服務、出貨值就是 dsh 的 10。
    expect(byId.get('agent-loop')).toEqual({
      maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
    });

    // **落盤窗口住在 `@nexus/core`，不是 `#settings/…`**（#529）：值的家在那個套件裡，而
    // `@nexus/core/*` 本來就解得到，所以這一列沒有載體偏離。它排在 core 那一段是因為擁有者
    // 是 core；它的消費點卻在起動期，那條不對稱寫在 `session-persistence.ts` 的檔頭上。
    expect(byId.get('session-persistence')).toEqual({ windowMs: DEFAULT_PERSISTENCE_WINDOW_MS });

    const withConfig = [...byId].filter(([, config]) => config !== undefined).map(([id]) => id);
    expect(withConfig).toEqual([
      'todo',
      'feedback',
      'system-prompt',
      'repeat-reminder',
      'tool-result-pruner',
      'summarization',
      'session-persistence',
      'thread-title',
      'thread-title-llm',
      'thread-search',
      'browser-session',
      'deliverable-files',
      'tool-text',
      'projection-flush',
      'tool-result-stash',
      'spill-policy',
      'tool-fs-search',
      'background-subagents',
      'subagent-model-selection',
      'live-model',
      'agent-default-model',
      'cli-script',
      'recursion-limit',
      'agent-loop',
    ]);
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

  it('patch 檔被拒時，訊息說的是 patch 檔，不是模組', () => {
    const root = privateDirectory();
    const path = writePrivate(root, 'cordis.patch.yml', '[]\n');
    chmodSync(path, 0o666);
    expect(() => loadOverlayPatches(path)).toThrow(/^patch 檔 .*改得動 plugin 清單/);
  });
});

describe('insert 進來的模組宣告的 @nexus/core 範圍不滿足：import 之前那一列掉了（#1137）', () => {
  /** 私有目錄裡一個帶 manifest 的插件；模組頂層會寫一個見證檔。回傳 { 目錄, 見證檔 }。 */
  function peerPlugin(root: string, peer: string) {
    const witness = join(root, 'ran');
    writePrivate(
      root,
      'package.json',
      JSON.stringify({
        name: 'team-plugin',
        version: '2.0.0',
        peerDependencies: { '@nexus/core': peer },
      }),
    );
    const module = writePrivate(
      root,
      'team.mjs',
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(witness)}, 'x');\n` +
        "export default { name: 'team', apply() {} };\n",
    );
    return { module, witness };
  }

  function loadWith(root: string, name: string) {
    const shipped = writePrivate(root, 'cordis.yml', '[]\n');
    const patch = writePrivate(root, 'p.yml', `- insert:\n    - id: team\n      name: '${name}'\n`);
    return loadPluginConfig({ shipped, overlays: [patch], warn: () => {} });
  }

  it('不滿足：那一列掉了、其餘照樣載，訊息指名 套件@版本、範圍與執行中的版本，模組主體一行都沒跑', async () => {
    const root = privateDirectory();
    const { witness } = peerPlugin(root, '>=999.0.0');
    const { plugins, dropped } = await loadWith(root, './team.mjs');
    expect(plugins).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ id: 'team', stage: 'module' });
    expect(dropped[0]?.message).toMatch(
      /^條目 "team"（file:[^）]+） 不相容：team-plugin@2\.0\.0 需要 @nexus\/core >=999\.0\.0，執行中的是 \d+\.\d+\.\d+/u,
    );
    expect(existsSync(witness)).toBe(false);
  });

  it('滿足：照常載入，模組主體有跑（對照：見證檔量得到「跑了」）', async () => {
    const root = privateDirectory();
    const { witness } = peerPlugin(root, '>=0.0.0');
    const { plugins, dropped } = await loadWith(root, './team.mjs');
    expect(dropped).toEqual([]);
    expect(plugins[0]?.plugin.name).toBe('team');
    expect(existsSync(witness)).toBe(true);
  });
});

describe('insert 進來的模組檔也要只有自己動得了（#542）', () => {
  /** 一顆會匯出 plugin 的模組，模式位照給的設。 */
  function moduleFile(dir: string, name: string, mode = 0o600): string {
    const path = join(dir, name);
    writeFileSync(path, `export default { name: 'm-${name}', apply() {} };\n`);
    chmodSync(path, mode);
    return path;
  }

  /** 私有目錄裡一份只插這一列的 patch，載下去。 */
  function loadWith(root: string, name: string) {
    const shipped = writePrivate(root, 'cordis.yml', '[]\n');
    const patch = writePrivate(root, 'p.yml', `- insert:\n    - id: team\n      name: '${name}'\n`);
    return loadPluginConfig({ shipped, overlays: [patch], warn: () => {} });
  }

  it('(a) 模組放在群組可寫的共用目錄：拒絕，指名模組、它的上層目錄與那一列', async () => {
    const root = privateDirectory();
    const shared = join(root, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o775);
    const module = moduleFile(shared, 'team.ts');
    const rejected = loadWith(root, module);
    await expect(rejected).rejects.toThrow(PluginConfigError);
    await expect(rejected).rejects.toThrow(/^條目 "team"（file:[^）]+）：plugin 模組 /);
    await expect(rejected).rejects.toThrow(
      `plugin 模組 ${realpathSync(module)} 的上層目錄 ${realpathSync(shared)} 群組或其他人可寫`,
    );
    await expect(rejected).rejects.toThrow('以你的身分在 harness 行程裡執行');
  });

  it('(b) 模組檔自己群組可寫（umask 002 的機器上就是這樣）：拒絕', async () => {
    const root = privateDirectory();
    moduleFile(root, 'team.ts', 0o664);
    await expect(loadWith(root, './team.ts')).rejects.toThrow(/plugin 模組 .*群組或其他人可寫/);
  });

  it('patch 裡直接寫 file:// 的也檢查', async () => {
    const root = privateDirectory();
    const module = moduleFile(root, 'team.ts', 0o664);
    await expect(loadWith(root, pathToFileURL(module).href)).rejects.toThrow(
      /plugin 模組 .*群組或其他人可寫/,
    );
  });

  it('符號連結檢查的是它指到的那個檔', async () => {
    const root = privateDirectory();
    const target = moduleFile(root, 'real.ts', 0o664);
    symlinkSync(target, join(root, 'link.ts'));
    await expect(loadWith(root, './link.ts')).rejects.toThrow(
      `plugin 模組 ${realpathSync(target)} 群組或其他人可寫`,
    );
  });

  it('私有的模組照常載得起來', async () => {
    const root = privateDirectory();
    moduleFile(root, 'team.ts');
    const { plugins: loaded } = await loadWith(root, './team.ts');
    expect(loaded[0]?.plugin.name).toBe('m-team.ts');
  });

  it('檢查不了的一律拒絕：上層目錄進不去，不能當成檢查過了', async () => {
    const root = privateDirectory();
    const locked = join(root, 'locked');
    mkdirSync(locked);
    moduleFile(locked, 'team.ts');
    chmodSync(locked, 0o000);
    try {
      await expect(loadWith(root, './locked/team.ts')).rejects.toThrow(
        /^條目 "team"（file:[^）]+）：檢查不了 plugin 模組 .*EACCES/,
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('模組檔不存在：那一列掉了（#751），原因照舊說那一列載不起來，不是一個裸的 ENOENT', async () => {
    const root = privateDirectory();
    const { plugins, dropped } = await loadWith(root, './沒這個檔.ts');
    expect(plugins).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ id: 'team', stage: 'module' });
    expect(dropped[0]?.message).toMatch(/^條目 "team"（file:[^）]+） 載不起來：Cannot find module/);
  });

  /**
   * 卡上的驗收（#751）：**權限太寬照舊整個起不來，而且模組沒被載入**——見證是模組頂層寫一個檔，那個檔不存在。
   * 對照：同一個模組放進私有目錄，但模組本身 import 時拋錯——那一列掉了、其餘照樣起來。兩條用同一種模組，量得到
   * 分岔在權限那一格，不是在「載不載得起來」那一格。
   */
  it('權限太寬：照舊整個拋（子類別分得出來），模組一行都沒跑；對照：私有但 import 時拋錯只讓那一列掉', async () => {
    const root = privateDirectory();
    const witness = join(root, 'ran');
    const body = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(witness)}, 'x');\nthrow new Error('模組自己拋的');\n`;
    const shared = join(root, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o775);
    writeFileSync(join(shared, 'team.mjs'), body);
    const rejected = loadWith(root, join(shared, 'team.mjs'));
    await expect(rejected).rejects.toThrow(PluginModuleAccessError);
    expect(existsSync(witness)).toBe(false);

    const own = join(root, 'own.mjs');
    writeFileSync(own, body);
    chmodSync(own, 0o600);
    const { dropped } = await loadWith(root, own);
    expect(existsSync(witness)).toBe(true);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.message).toMatch(/載不起來：模組自己拋的/);
  });
});

/**
 * 讀清單那一次的逐列掉（#751），照 dsh 的失敗表（`packages/boot/app-boot/README.zh.md:96-106`，`477b4f4`）：一列自己的
 * 失敗只讓那一列掉，整份的錯照舊整個拋。哪幾列掉了要整個起不來不在這一層判，見 `startup-audit.test.ts`。
 */
describe('讀清單時一列自己的失敗只讓那一列掉（#751）', () => {
  /** 私有目錄裡一份出貨清單＋一份 patch，載下去。 */
  function loadRows(shippedRows: string, patchRows = '[]\n') {
    const root = privateDirectory();
    const shipped = writePrivate(root, 'cordis.yml', shippedRows);
    const patch = writePrivate(root, 'p.yml', patchRows);
    return loadPluginConfig({ shipped, overlays: [patch], warn: () => {} });
  }

  it('設定驗不過：那一列留在清單上、改成停用，原因指名它；前後的列照樣在', async () => {
    const { plugins, dropped } = await loadRows(
      "- id: echo\n  name: '@nexus/plugin-echo'\n" +
        "- id: todo\n  name: '@nexus/plugin-todo'\n  config:\n    allowParallelInProgress: '不是布林'\n" +
        "- id: plan\n  name: '@nexus/plugin-plan-mode'\n",
    );
    expect(plugins.map((entry) => [entry.id, entry.disabled === true])).toEqual([
      ['echo', false],
      ['todo', true],
      ['plan', false],
    ]);
    expect(dropped).toEqual([
      {
        id: 'todo',
        module: '@nexus/plugin-todo',
        stage: 'config',
        message: expect.stringMatching(
          /^todo \(todo\) 的 config 不合法 — allowParallelInProgress/u,
        ) as unknown,
        entry: plugins[1],
      },
    ]);
  });

  it('模組載得起來但不是一顆 plugin：那一列掉了', async () => {
    const { plugins, dropped } = await loadRows("- id: path\n  name: 'node:path'\n");
    expect(plugins).toEqual([]);
    expect(dropped).toMatchObject([{ id: 'path', module: 'node:path', stage: 'module' }]);
    expect(dropped[0]?.message).toContain('沒有匯出一顆 plugin');
  });

  it('停用的列模組載不起來、設定寫壞都不算掉：dsh 對停用的列不載入、不驗', async () => {
    const { plugins, dropped } = await loadRows(
      "- id: gone\n  name: '@nexus/根本沒這個套件'\n  disabled: true\n" +
        "- id: todo\n  name: '@nexus/plugin-todo'\n  disabled: true\n  config:\n    allowParallelInProgress: 1\n",
    );
    expect(dropped).toEqual([]);
    expect(plugins.map((entry) => entry.id)).toEqual(['todo']);
  });

  it('沒有設定格式卻寫了 config：不算掉，照樣掛、原樣帶著，記一筆', async () => {
    const { plugins, dropped, ignoredConfig } = await loadRows(
      "- id: observation-policy\n  name: '@nexus/core/observation-policy'\n  config:\n    anything: 1\n",
    );
    expect(dropped).toEqual([]);
    expect(plugins[0]?.disabled).not.toBe(true);
    expect(plugins[0]?.config).toEqual({ anything: 1 });
    expect(ignoredConfig).toEqual([
      { id: 'observation-policy', module: '@nexus/core/observation-policy' },
    ]);
  });

  it('整份的錯照舊整個拋：重複 id', async () => {
    await expect(
      loadRows(
        "- id: echo\n  name: '@nexus/plugin-echo'\n",
        "- insert:\n    - id: echo\n      name: '@nexus/plugin-echo'\n",
      ),
    ).rejects.toThrow(/echo/u);
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

  it('沒寫 config 就不帶——不替沒有 Config 的 plugin 編一份設定出來', async () => {
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

/**
 * **核准閘門關不掉**（[#456](https://github.com/DemianLi/nexus-agent/issues/456) 第四刀）。
 *
 * 這一組釘的是兩件事，兩件都是量過之後才寫的：
 *
 * 1. **`disabled: true` 是失敗，不是一行警告。** 這一列不存在的時候，`- id: approval-gate`
 *    走的是 `applyEntryPatches` 的「找不到 id」那條——量過（2026-09-22）：`exit 0`、
 *    stderr 剛好一行、dump 跟沒帶那份 patch 逐字相同。核准照樣開著，但讀起來像關掉了。
 * 2. **`--dump-config` 跟真啟動一起擋，而那是這一整個機制放在 `validateEntries` 裡的理由。**
 *    `renderConfigDump` 在印之前自己跑一次它。檢查若搬到 import／`apply` 那一層，dump 會
 *    高高興興印出 `disabled: true` 替錯的信念背書——而 `cordis.yml` 的檔頭正是叫人用
 *    `--dump-config` 看這台機器上實際長什麼樣。下面那條 dump 的測試就是這件事的絆索：
 *    搬走它就紅。
 */
describe('保護名單', () => {
  /** 一份最小的出貨清單，帶那一列受保護的。 */
  function shippedWithGate(root: string): string {
    return writePrivate(
      root,
      'cordis.yml',
      "- id: echo\n  name: '@nexus/plugin-echo'\n" +
        "- id: approval-gate\n  name: '@nexus/core/approval-gate'\n",
    );
  }

  it('出貨的清單上真的有那一列——不然下面每一條都是空談', () => {
    const entries = composeEntries();
    const gate = entries.find((entry) => entry.name === '@nexus/core/approval-gate');
    expect(gate).toBeDefined();
    // patch 指得著的是 `id`，所以它必須有一個。
    expect(gate?.id).toBe('approval-gate');
    expect(PROTECTED_ENTRY_NAMES.has('@nexus/core/approval-gate')).toBe(true);
  });

  it('真啟動那條：`disabled: true` 當場拋，訊息講得出為什麼關不掉', () => {
    const root = privateDirectory();
    const shipped = shippedWithGate(root);
    const overlay = writePrivate(root, 'o.yml', '- id: approval-gate\n  disabled: true\n');
    expect(() => composeEntries({ shipped, overlays: [overlay], warn: () => {} })).toThrow(
      /關不掉/,
    );
    expect(() => composeEntries({ shipped, overlays: [overlay], warn: () => {} })).toThrow(
      PluginConfigError,
    );
  });

  /**
   * **訊息逐列不同，而且不會串台。**
   *
   * 從前這裡是一個 `Set` ＋ 一段共用的訊息，而那段訊息逐字在講核准閘門。名單在 #529 長到四列
   * 之後，關掉 `#settings/thread-title` 的人會拿到一整段關於核准與多人共用主機的說明——對他那
   * 一列完全是錯的。**現有的測試抓不到它**：它們斷言的是 `/關不掉/`，而那四個字每一列都有。
   *
   * 所以這一條釘的是訊息的**內容**：指名自己那一列的理由，而且**不提別列的**。
   */
  it('訊息逐列不同——關掉設定條目不會收到一段講核准閘門的話', () => {
    const root = privateDirectory();
    const shipped = writePrivate(
      root,
      'cordis.yml',
      "- id: echo\n  name: '@nexus/plugin-echo'\n" +
        "- id: thread-title\n  name: '#settings/thread-title'\n",
    );
    const overlay = writePrivate(root, 'o.yml', '- id: thread-title\n  disabled: true\n');
    const compose = (): unknown => composeEntries({ shipped, overlays: [overlay], warn: () => {} });

    expect(compose).toThrow(/關不掉/u);
    expect(compose).toThrow(/標題/u);
    // **這一條才是這個缺陷的絆索**：共用那段文字的話它必紅。
    expect(compose).not.toThrow(/核准/u);
  });

  /**
   * **哪幾列必須在名單上——這份清單刻意寫死，不從 `PROTECTED_ENTRY_NAMES` 導出。**
   *
   * 底下那條表驅動的測試遍歷名單自己，所以「某一列被移出名單」對它是隱形的（實測：把
   * `#settings/deliverable-files` 刪掉，那一條照樣綠）。**斷言端與生產端讀同一個來源時，
   * 改掉那個來源兩邊會一起動。** 這一條因此自己列出名字：少掉任何一列都是行為變了，要在這裡紅。
   */
  it('這幾列必須在保護名單上', () => {
    const expected = [
      '@nexus/core/approval-gate',
      '#settings/thread-title',
      '#settings/browser-session',
      '#settings/deliverable-files',
      '#settings/tool-text',
      '#settings/projection-flush',
      '#settings/tool-result-stash',
      '#settings/live-model',
      '#settings/default-model',
      '#settings/recursion-limit',
      '#settings/agent-loop',
    ];
    for (const name of expected) {
      expect(PROTECTED_ENTRY_NAMES.has(name), name).toBe(true);
    }
    // **兩個方向都要釘。** 上面那個迴圈只擋「某一列被移出名單」；少了這一行，往名單裡偷偷
    // 加一列不會有任何東西紅——而多保護一列跟少保護一列一樣是行為變了，那一列的 `disabled`
    // 會從「真的關掉」變成「當場拋」。
    expect(PROTECTED_ENTRY_NAMES.size).toBe(expected.length);
  });

  /**
   * **落盤那一列關得掉**（[#612](https://github.com/DemianLi/nexus-agent/issues/612)）。它曾經在
   * 名單上（只講批次窗口時，關掉只會回到預設）；#444 讓落盤預設開著之後，它代表落盤本身，照 dsh
   * 的 `session-persistence-jsonl`：`disabled: true` 就是不落盤。上面那條寫死的清單已經不含它，
   * 這一條是翻面後的正面斷言——哪天有人把它加回名單，這裡紅。
   */
  it('`@nexus/core/session-persistence` 寫 `disabled: true` 放行', () => {
    expect(PROTECTED_ENTRY_NAMES.has('@nexus/core/session-persistence')).toBe(false);
    expect(() =>
      validateEntries(
        [{ id: 'session-persistence', name: '@nexus/core/session-persistence', disabled: true }],
        '測試',
      ),
    ).not.toThrow();
  });

  /**
   * **整份名單掃一遍，不是只挑一列驗。**
   *
   * 從前這組只驗 `approval-gate` 那一列真的關不掉。名單後來長到四列
   * （[#529](https://github.com/DemianLi/nexus-agent/issues/529) 的三刀各加一列），而**新加的
   * 三列一條都沒有**——「它在名單上」與「它真的擋得住」之間沒有任何測試。逐列補會再漏下一次，
   * 所以這裡走表：**加一列就自動涵蓋**。
   *
   * **但它只證得了「名單上的擋得住」，證不了「某一列在名單上」**——遍歷的是名單自己，一列被移出去
   * 迴圈就不檢查它。實測過：把 `#settings/deliverable-files` 從表上刪掉，這一條照樣綠。所以那一半
   * 由上面那條**寫死清單**的測試守，兩條缺一不可。
   */
  it('名單上每一列都真的關不掉，而 `disabled: false` 與沒寫都放行', () => {
    // 前提：名單非空，否則下面整段是空轉。精確的成員由上面那條守。
    expect(PROTECTED_ENTRY_NAMES.size).toBeGreaterThan(0);
    for (const name of PROTECTED_ENTRY_NAMES) {
      const disabled = (): unknown => validateEntries([{ id: 'x', name, disabled: true }], '測試');
      expect(disabled, name).toThrow(PluginConfigError);
      expect(disabled, name).toThrow(/關不掉/u);
      // **擋的是「關掉」，不是「提到這一列」**——同 `approval-gate` 那條的理由。
      expect(
        () => validateEntries([{ id: 'x', name, disabled: false }], '測試'),
        name,
      ).not.toThrow();
      expect(() => validateEntries([{ id: 'x', name }], '測試'), name).not.toThrow();
    }
  });

  /**
   * **每一列的理由都是自己的。**
   *
   * `PROTECTED_ENTRY_REASONS` 的型別逼人寫一段文字，但逼不了那段文字是對的——複製隔壁那一列的
   * 理由照樣編得過，而那正是這份名單從前的實際狀態（四列共用一段講核准閘門的話）。
   *
   * **比的是理由本身，不是完整訊息。** 第一版比完整訊息，而那是假綠：訊息裡嵌著
   * `"<列名>"`，所以就算理由整段抄隔壁，兩則訊息照樣不同。實測過——把
   * `#settings/deliverable-files` 的理由換成 `#settings/thread-title` 的，比訊息的那一版全綠。
   */
  it('每一列的理由都不一樣——沒有人借用另一列的', () => {
    const reasons = [...PROTECTED_ENTRY_REASONS.values()];
    expect(reasons).toHaveLength(PROTECTED_ENTRY_NAMES.size);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('**`--dump-config` 那條也拋**——檢查搬離 `validateEntries` 就會紅', () => {
    const root = privateDirectory();
    const shipped = shippedWithGate(root);
    const overlay = writePrivate(root, 'o.yml', '- id: approval-gate\n  disabled: true\n');
    expect(() => renderConfigDump({ shipped, overlays: [overlay], warn: () => {} })).toThrow(
      /關不掉/,
    );
  });

  it('`disabled: false` 與沒寫都放行——擋的是「關掉」，不是「提到這一列」', () => {
    const root = privateDirectory();
    const shipped = shippedWithGate(root);
    const overlay = writePrivate(root, 'o.yml', '- id: approval-gate\n  disabled: false\n');
    expect(() => composeEntries({ shipped, overlays: [overlay], warn: () => {} })).not.toThrow();
    expect(() => composeEntries({ shipped, warn: () => {} })).not.toThrow();
  });

  it('鍵是 `name` 不是 `id`：換個 id `insert` 一列同名的，照樣擋得下', () => {
    // `id` 與 `name` 兩個 patch 都改不動（`applyEntryPatches` 把它們解構在 `overrides` 外），
    // 但 `insert` 進來的列一樣會走到 `validateEntries`——以 `id` 為鍵的話這一條會漏掉。
    const root = privateDirectory();
    const shipped = shippedWithGate(root);
    const overlay = writePrivate(
      root,
      'o.yml',
      "- insert:\n    - id: 別的名字\n      name: '@nexus/core/approval-gate'\n      disabled: true\n",
    );
    expect(() => composeEntries({ shipped, overlays: [overlay], warn: () => {} })).toThrow(
      /關不掉/,
    );
  });

  it('名單外的條目照樣關得掉——這條擋的是名單長胖', () => {
    const root = privateDirectory();
    const shipped = shippedWithGate(root);
    const overlay = writePrivate(root, 'o.yml', '- id: echo\n  disabled: true\n');
    const entries = composeEntries({ shipped, overlays: [overlay], warn: () => {} });
    expect(entries.find((entry) => entry.id === 'echo')?.disabled).toBe(true);
  });

  it('同一份檔案又關核准又撞 id 時，先講核准那一句', () => {
    // 兩條錯都在的時候，維運者要先看到的是關於核准的那一句。
    const root = privateDirectory();
    const shipped = writePrivate(
      root,
      'cordis.yml',
      "- id: approval-gate\n  name: '@nexus/core/approval-gate'\n  disabled: true\n" +
        "- id: echo\n  name: '@nexus/plugin-echo'\n" +
        "- id: echo\n  name: '@nexus/plugin-echo'\n",
    );
    expect(() => composeEntries({ shipped, warn: () => {} })).toThrow(/關不掉/);
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

    const { plugins: loaded } = await loadPluginConfig({
      shipped,
      overlays: [patch],
      warn: () => {},
    });
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

    const { plugins: loaded } = await loadPluginConfig({
      shipped,
      overlays: [patch],
      warn: () => {},
    });
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

    const { plugins: loaded } = await loadPluginConfig({
      shipped,
      overlays: [patch],
      warn: () => {},
    });
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

    const { plugins: loaded } = await loadPluginConfig({
      shipped,
      overlays: [patch],
      warn: () => {},
    });
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
