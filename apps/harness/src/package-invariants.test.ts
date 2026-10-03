/**
 * 結構規則的測試。
 *
 * 分成兩半，而**上半才是這張的理由**：
 *
 * 1. **對著真的 repo 跑。** 掃得到的 owner 正好是那八個、而且現在零違規。glob 寫壞、腳本
 *    搬家、repo 根算錯——這幾種缺陷會讓 gate 掃到空清單然後回報零違規，也就是**永遠綠**。
 *    一個永遠綠的結構 gate 比沒有 gate 更糟，所以這一條是逐條 AST 規則之上的那一條。
 * 2. **對著臨時目錄裡的壞樣本跑。** 每一條規則配一個真的會紅的樣本；規則沒接上去的話，
 *    樣本會綠。
 *
 * #974 把兩條規則翻了面，**翻面要有絆索**：沒有配套入口的 package 不再是違規（它根本不是
 * owner），而空 installer 本身是違規——連「帶了說明標記」的舊式合格寫法也一樣會紅。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectPackageInvariantViolations,
  packageInvariantOwners,
  repositoryRoot,
} from './package-invariants.js';

/** 這個 repo 現在該有的八個 owner：每一個都有真的檢查（`fail(` 至少一處）。**寫死字串**：拿 glob 的結果自己比自己驗不出東西。 */
const EXPECTED_OWNERS = [
  '@nexus/core',
  '@nexus/plugin-commands',
  '@nexus/plugin-goal',
  '@nexus/plugin-plan-mode',
  '@nexus/plugin-present',
  '@nexus/plugin-sandbox-policy',
  '@nexus/plugin-todo',
  '@nexus/plugin-workspace-changes',
];

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一份合格的配套入口。底下每個壞樣本都是從這裡改一處出來的。 */
function companionSource(
  overrides: {
    readonly header?: string;
    readonly installer?: string;
    readonly registration?: string;
    readonly defaultExport?: string;
    readonly extra?: string;
  } = {},
): string {
  const {
    header = '/**\n * 樣本。\n *\n * @module\n */',
    installer = 'const install: InvariantInstaller = (subject, fail) => {\n' +
      "  subject.observe(() => fail('壞了'));\n};",
    registration = 'registry.invariants.register(SAMPLE_PACKAGE, install);',
    defaultExport = 'export default samplePlugin;',
    extra = '',
  } = overrides;
  return `${header}

import type { InvariantInstaller, NexusPlugin, PluginEntry } from '@nexus/core';

export const SAMPLE_PACKAGE = '@nexus/sample';

${installer}
${extra}
export const samplePlugin: NexusPlugin = {
  name: 'sample-invariant',
  apply(registry) {
    ${registration}
  },
};

${defaultExport}

export function createSampleInvariantPlugin(): PluginEntry {
  return { plugin: samplePlugin };
}
`;
}

/**
 * 造一個只有一個 package 的臨時 repo。
 *
 * @param source - 配套入口的內容；`null` 代表這個 package 沒有 `src/invariant.ts`。
 * @param exportsInvariant - manifest 的 `exports["./invariant"]`，`null` 代表沒有這一格。
 */
function sampleRoot(
  source: string | null,
  exportsInvariant: string | null = './src/invariant.ts',
): string {
  const root = mkdtempSync(join(tmpdir(), 'package-invariants-'));
  temporaryRoots.push(root);
  const dir = join(root, 'packages', 'sample');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: '@nexus/sample',
      exports: exportsInvariant === null ? {} : { './invariant': exportsInvariant },
    }),
  );
  if (source !== null) writeFileSync(join(dir, 'src', 'invariant.ts'), source);
  return root;
}

/** 造臨時 repo、跑規則，回傳訊息。參數同 {@link sampleRoot}。 */
function violationsFor(
  source: string | null,
  exportsInvariant: string | null = './src/invariant.ts',
): string[] {
  return collectPackageInvariantViolations(sampleRoot(source, exportsInvariant)).map(
    (violation) => violation.message,
  );
}

describe('對著真的 repo', () => {
  it('repo 根找得到，而且是含 pnpm-workspace.yaml 的那一個', () => {
    // 根算錯的話底下兩條都會掃到空清單然後「通過」，所以先釘根。
    expect(repositoryRoot()).toMatch(/nexus/);
    expect(packageInvariantOwners().map((owner) => owner.dir)).toContain('packages/nexus-core');
  });

  it('**掃出來的 owner 正好是那八個**——glob 壞掉時這一條紅，零違規那一條不會', () => {
    expect(
      packageInvariantOwners()
        .map((owner) => owner.packageName)
        .sort(),
    ).toEqual([...EXPECTED_OWNERS].sort());
  });

  it('八個現在全部合格——包括「沒有任何空殼」', () => {
    expect(collectPackageInvariantViolations()).toEqual([]);
  });
});

describe('發現 owner', () => {
  it('什麼都沒發布的 package 不是 owner，也不是違規——沒有可檢的關係就不要發布', () => {
    // 翻面前這一格是「缺配套入口」違規；它變成合法，才是 #974 拿掉十二個空殼的前提。
    const root = sampleRoot(null, null);
    expect(packageInvariantOwners(root)).toEqual([]);
    expect(collectPackageInvariantViolations(root)).toEqual([]);
  });

  it('只宣告了 exports 卻沒有檔案，是 owner 而且違規——不是被跳過', () => {
    expect(violationsFor(null)).toEqual([expect.stringContaining('缺配套入口')]);
  });

  it('只有檔案沒有 exports，同樣是 owner 而且違規——兩半要同時在場', () => {
    const root = sampleRoot(companionSource(), null);
    expect(packageInvariantOwners(root).map((owner) => owner.packageName)).toEqual([
      '@nexus/sample',
    ]);
    expect(violationsFor(companionSource(), null)).toEqual([
      expect.stringContaining('exports["./invariant"]'),
    ]);
  });

  it('合格的樣本零違規——底下每個壞樣本都是從它改一處出來的', () => {
    expect(violationsFor(companionSource())).toEqual([]);
  });
});

describe('manifest', () => {
  it('沒有 exports["./invariant"] 就是違規', () => {
    expect(violationsFor(companionSource(), null)).toEqual([
      expect.stringContaining('exports["./invariant"]'),
    ]);
  });

  it('指到別的地方也是違規', () => {
    expect(violationsFor(companionSource(), './src/index.ts')).toEqual([
      expect.stringContaining('exports["./invariant"]'),
    ]);
  });
});

describe('原始碼', () => {
  it('帶 @generated 標記是違規', () => {
    const source = companionSource({
      header: '/**\n * 樣本。\n *\n * @generated\n */',
    });
    expect(violationsFor(source)).toEqual([expect.stringContaining('@generated')]);
  });

  it('註冊別人的 package 名是違規，訊息講得出看到的是什麼', () => {
    const source = companionSource({
      registration: "registry.invariants.register('@nexus/someone-else', install);",
    });
    expect(violationsFor(source)).toEqual([
      expect.stringContaining('必須正好註冊自己的 package 名'),
    ]);
  });

  it('一次都不註冊是違規', () => {
    expect(violationsFor(companionSource({ registration: '// 忘了註冊' }))).toEqual([
      expect.stringContaining('必須正好註冊自己的 package 名'),
    ]);
  });

  it('註冊兩次是違規——包名歸屬要正好一個主人', () => {
    const source = companionSource({
      registration:
        'registry.invariants.register(SAMPLE_PACKAGE, install);\n' +
        "      registry.invariants.register('@nexus/other', install);",
    });
    expect(violationsFor(source)).toEqual([
      expect.stringContaining('必須正好註冊自己的 package 名'),
    ]);
  });

  it('package 名解析不到本檔的常數是違規', () => {
    const source = companionSource({
      registration: 'registry.invariants.register(`${SAMPLE_PACKAGE}`, install);',
    });
    expect(violationsFor(source)).toEqual(
      expect.arrayContaining([expect.stringContaining('解析得到本檔的頂層字串常數')]),
    );
  });

  it('第二個引數就地寫函式是違規——沒有名字就沒有東西可以檢', () => {
    const source = companionSource({
      registration: 'registry.invariants.register(SAMPLE_PACKAGE, () => {});',
    });
    expect(violationsFor(source)).toEqual([
      expect.stringContaining('必須是本檔宣告的 InvariantInstaller 常數'),
    ]);
  });

  it('沒有 create*InvariantPlugin 工廠是違規', () => {
    const source = companionSource().replace(
      'export function createSampleInvariantPlugin()',
      'function createSampleInvariantPlugin()',
    );
    expect(violationsFor(source)).toEqual([expect.stringContaining('create*InvariantPlugin')]);
  });

  it('沒有 default export 是違規——設定檔叫不出這個條目的名字', () => {
    const source = companionSource({ defaultExport: '' });
    expect(violationsFor(source)).toEqual([expect.stringContaining('default export 缺一個')]);
  });

  it('default export 就地寫一顆物件是違規——它要留得住具名匯出', () => {
    // 這一條是舊規則（「不得 default export」）翻面之後留下來的那一半：舊規則守的是
    // 「specifier 要留得住具名匯出」，而那件事現在由「必須是本檔具名 export 的常數」守著。
    const source = companionSource({
      defaultExport: "export default { name: 'sample-invariant', apply() {} };",
    });
    expect(violationsFor(source)).toEqual([
      expect.stringContaining('必須是本檔具名 export 的常數'),
    ]);
  });

  it('default export 指到沒有 export 的區域常數也是違規', () => {
    const source = companionSource({
      extra: "const hidden: NexusPlugin = { name: 'hidden', apply() {} };",
      defaultExport: 'export default hidden;',
    });
    expect(violationsFor(source)).toEqual([
      expect.stringContaining('必須是本檔具名 export 的常數'),
    ]);
  });
});

describe('installer', () => {
  it('空 installer 本身是違規——沒有可檢的關係就不要發布配套入口', () => {
    // #974 翻面的那一條。翻面前這個樣本是違規只因為沒有說明；現在連說明都不看。
    const source = companionSource({ installer: 'const install: InvariantInstaller = () => {};' });
    expect(violationsFor(source)).toEqual([expect.stringContaining('空 installer 沒有任何檢查')]);
  });

  it('帶著舊式說明標記的空 installer 照樣違規——標記不再是通行證', () => {
    // 這一條擋的是「翻面只刪了要求說明那條、卻留著說明就放行的分支」：留著它，
    // 十二個空殼原封不動也會綠。
    const source = companionSource({
      header: '/**\n * No runtime invariant: 這個樣本沒有可檢的關係。\n *\n * @module\n */',
      installer: 'const install: InvariantInstaller = () => {};',
    });
    expect(violationsFor(source)).toEqual([expect.stringContaining('空 installer 沒有任何檢查')]);
  });

  it('非空 installer 沒有第二個參數是違規', () => {
    const source = companionSource({
      installer:
        'const install: InvariantInstaller = (subject) => {\n  subject.observe(() => {});\n};',
    });
    expect(violationsFor(source)).toEqual([
      expect.stringContaining('第二個參數必須是綁定的違規回報器'),
    ]);
  });

  it('非空 installer 收了回報器卻不用是違規——觀察了不回報等於沒檢查', () => {
    const source = companionSource({
      installer:
        'const install: InvariantInstaller = (subject, fail) => {\n  subject.observe(() => {});\n};',
    });
    expect(violationsFor(source)).toEqual([expect.stringContaining('必須真的用到它的回報器')]);
  });

  it('用了就通過', () => {
    const source = companionSource({
      installer:
        'const install: InvariantInstaller = (subject, fail) => {\n' +
        "  subject.observe(() => fail('壞了'));\n};",
    });
    expect(violationsFor(source)).toEqual([]);
  });

  it('installer 名字不必叫 install——`@nexus/core` 的叫 sessionInvariant', () => {
    const source = companionSource({
      installer:
        'const sessionish: InvariantInstaller = (subject, fail) => {\n' +
        "  subject.observe(() => fail('壞了'));\n};",
      registration: 'registry.invariants.register(SAMPLE_PACKAGE, sessionish);',
    });
    expect(violationsFor(source)).toEqual([]);
  });
});
