/**
 * 工具 schema 目錄（[#442](https://github.com/DemianLi/nexus-agent/issues/442)）的驗收：**提交進 repo 的
 * `docs/tool-catalog.md` 不能落後於模型實際收到的工具**，而且套件清單要完整。
 *
 * 新鮮度是在這個測試裡驗的，不是 CI 另開一個 step：它跟 `package-invariants.test.ts` 同一個形狀，跑在 `test-harness` 裡。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryRoot } from './package-invariants.js';
import {
  ASSEMBLY_SOURCE,
  assertManifestComplete,
  BASE_SOURCE,
  CATALOG_REGEN_COMMAND,
  collectToolCatalog,
  PACKAGE_MANIFEST,
  pluginPackageDirs,
  renderToolCatalog,
} from './tool-catalog.js';
import type { PackageExpectation, PackageFacts } from './tool-catalog.js';

const root = repositoryRoot();
const CATALOG_PATH = join(root, 'docs', 'tool-catalog.md');
const TIMEOUT = 60_000;

describe('docs/tool-catalog.md', () => {
  it(
    '沒有過期：重新產生的內容與提交進 repo 的那份逐字相同',
    async () => {
      const fresh = renderToolCatalog(await collectToolCatalog(root));
      const committed = readFileSync(CATALOG_PATH, 'utf8');
      // 不用 `toBe`：兩份各幾百行，差異淹在訊息裡。紅的時候要的是「怎麼修」那一句。
      if (fresh !== committed) {
        throw new Error(
          `docs/tool-catalog.md 與模型實際收到的工具不一致。重新產生並一起提交：\n  ${CATALOG_REGEN_COMMAND}`,
        );
      }
    },
    TIMEOUT,
  );

  it(
    '每個工具都有描述與物件形狀的參數 schema，名字在整份目錄裡不重複',
    async () => {
      const sections = await collectToolCatalog(root);
      const names = sections.flatMap((section) => section.tools.map((tool) => tool.name));
      expect(new Set(names).size).toBe(names.length);
      for (const tool of sections.flatMap((section) => section.tools)) {
        expect(tool.description, `${tool.name} 的描述`).not.toBe('');
        expect(tool.parameters, `${tool.name} 的參數`).toMatchObject({ type: 'object' });
      }
      // 前提：基座與組裝點與 plugin 三種來源都真的在裡面，空目錄也「沒有重複」。
      const sources = sections.map((section) => section.source);
      expect(sources).toEqual(expect.arrayContaining([BASE_SOURCE, ASSEMBLY_SOURCE, 'goal']));
    },
    TIMEOUT,
  );

  it('套件清單與磁碟一一對應：packages/nexus-plugin-* 每個都有一列，沒有多的', () => {
    expect([...pluginPackageDirs(join(root, 'packages'))]).toEqual(
      Object.keys(PACKAGE_MANIFEST).sort(),
    );
  });
});

describe('完整性檢查本身', () => {
  const facts = (dir: string, pluginName?: string): PackageFacts => ({ dir, pluginName });
  const shipped: PackageExpectation = { kind: 'shipped', reason: 'x' };
  const none: PackageExpectation = { kind: 'none', reason: 'x' };
  const contributed = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

  it('齊全時不拋', () => {
    expect(() =>
      assertManifestComplete(
        [facts('a', 'a'), facts('b', 'b')],
        { a: shipped, b: none },
        contributed({ a: ['t'] }),
      ),
    ).not.toThrow();
  });

  it('漏列一個套件：拋，指名它', () => {
    expect(() =>
      assertManifestComplete(
        [facts('a', 'a'), facts('b', 'b')],
        { a: shipped },
        contributed({ a: ['t'] }),
      ),
    ).toThrow(/b 不在 PACKAGE_MANIFEST/u);
  });

  it('清單說有工具、載入後零個：拋', () => {
    expect(() =>
      assertManifestComplete([facts('a', 'a')], { a: shipped }, contributed({})),
    ).toThrow(/a 清單說有工具.*一個工具都沒有/u);
    expect(() =>
      assertManifestComplete(
        [facts('a', 'a')],
        { a: { kind: 'standalone', reason: 'x', config: {} } },
        contributed({}),
      ),
    ).toThrow(/a 清單說有工具/u);
  });

  it('清單說沒有工具、卻冒出工具：拋', () => {
    expect(() =>
      assertManifestComplete([facts('a', 'a')], { a: none }, contributed({ a: ['t'] })),
    ).toThrow(/a 清單說沒有工具.*t/u);
  });

  it('清單列了磁碟上沒有的套件：拋', () => {
    expect(() =>
      assertManifestComplete([facts('a', 'a')], { a: none, gone: none }, contributed({})),
    ).toThrow(/列了 gone/u);
  });

  it('assembly：組裝出來沒有它宣稱的工具就拋', () => {
    const expectation: PackageExpectation = { kind: 'assembly', reason: 'x', tools: ['esc'] };
    expect(() =>
      assertManifestComplete(
        [facts('a', 'a')],
        { a: expectation },
        contributed({}),
        new Set(['esc']),
      ),
    ).not.toThrow();
    expect(() =>
      assertManifestComplete([facts('a', 'a')], { a: expectation }, contributed({}), new Set()),
    ).toThrow(/組裝點會掛 esc/u);
  });
});
