/**
 * 解析器自己的測試。
 *
 * **失敗的路徑才是這裡的重點。** 成功路徑由 `serve.test.ts` 與 `cli.test.ts` 用真的文件跑過；
 * 這一份守的是「抓不到會當場炸」——一個靜靜回 `undefined` 或回預設值的解析器，會把它要守的
 * 東西整個吃掉：文件改壞了測試照樣綠，而那正是 [#490](https://github.com/DemianLi/nexus-agent/issues/490)
 * 要修的病。
 */

import { describe, expect, it } from 'vitest';

import {
  documentedFixture,
  DocumentedFixtureError,
  OPERATIONS_DOC,
  parseDocumentedFixture,
} from './documented-fixture.js';

describe('從文件讀 fixture 參數', () => {
  it('恰好一處時回傳那個值', () => {
    expect(
      parseDocumentedFixture(
        '```bash\npnpm --filter @nexus/harness run serve --patch src/approval.patch.yml\n```',
      ),
    ).toBe('src/approval.patch.yml');
  });

  it('真的那份文件讀得到，而且指向一個真的存在的 patch 檔', () => {
    const fixture = documentedFixture();
    expect(fixture).toBe('src/approval.patch.yml');
  });

  it('一處都沒有時拋，訊息指名是哪份文件', () => {
    expect(() => parseDocumentedFixture('# 沒有指令的文件\n\n什麼都沒有。')).toThrow(
      DocumentedFixtureError,
    );
    expect(() => parseDocumentedFixture('# 沒有指令的文件')).toThrow(OPERATIONS_DOC);
  });

  it('多於一處時拋，而且把找到的都列出來', () => {
    const two =
      'pnpm --filter @nexus/harness run serve --patch src/a.yml\n\npnpm --filter @nexus/harness run serve --patch src/b.yml';
    expect(() => parseDocumentedFixture(two)).toThrow(DocumentedFixtureError);
    // 列出來是為了讓人一眼看到是哪兩道指令打架，不必自己回去翻文件。
    expect(() => parseDocumentedFixture(two)).toThrow('src/a.yml、src/b.yml');
  });

  it('不會把後面的字一起吃進來', () => {
    // `\S+` 而不是「到行尾」：CLI 那條指令的 patch 後面還跟著別的參數。
    expect(
      parseDocumentedFixture(
        'pnpm --filter @nexus/harness run serve --patch src/approval.patch.yml --port 0',
      ),
    ).toBe('src/approval.patch.yml');
  });

  it('散文裡提到 `--patch`（沒有 `run serve` 前綴）不會被誤抓', () => {
    // 新正則錨在 `run serve --patch` 指令，散文裡的 `--patch` 提及（例如「任意個 `--patch <檔>`」
    // 或「`--patch` 不能配 `--plugins`」）都沒有 `run serve` 前綴，所以不該被命中。
    // 這也正是改錨的理由：舊版釘的是「任何一處旗標」，新版釘的是「那道指令」。
    expect(() =>
      parseDocumentedFixture(
        '任意個 `--patch <檔>` 疊在出貨清單上\n\n' +
          '`--patch` 不能配 `--plugins`\n\n' +
          'pnpm --filter @nexus/harness run serve --patch src/test.yml',
      ),
    ).not.toThrow();
    expect(
      parseDocumentedFixture(
        '任意個 `--patch <檔>` 疊在出貨清單上\n\n' +
          '`--patch` 不能配 `--plugins`\n\n' +
          'pnpm --filter @nexus/harness run serve --patch src/test.yml',
      ),
    ).toBe('src/test.yml');
  });
});
