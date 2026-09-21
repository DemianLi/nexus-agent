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

  it('散文裡提到旗標不會被誤抓，連「run serve --patch」這幾個字都寫在散文裡也不會', () => {
    // 新正則錨在那道指令上，而不是旗標上。兩種散文都要放過：
    //
    // 1. 有旗標、沒有 `run serve` 前綴（文件第 119 行的「任意個 `--patch <檔>`」）。
    // 2. **連 `run serve --patch` 這幾個字都在散文裡**（文件第 200 行講「多出第二道
    //    `run serve --patch`」的那一句）。它躲過正則靠的是後面緊接一個反引號而不是空白——
    //    那是個薄邊界，所以釘在這裡：有人把那句寫成「第二道 `run serve --patch <檔>`」的
    //    當天，這條會紅，而那正是該紅的時候（文件會變成有兩道指令）。
    const prose =
      '任意個 `--patch <檔>` 疊在出貨清單上\n\n' +
      '整段指令改寫法、或這份文件多出第二道 `run serve --patch`，解析會當場拋\n\n';
    const withCommand = `${prose}pnpm --filter @nexus/harness run serve --patch src/test.yml`;
    expect(parseDocumentedFixture(withCommand)).toBe('src/test.yml');
    // 反面：只有散文、沒有那道指令的話是零命中，不是「抓到散文裡那一個」。
    expect(() => parseDocumentedFixture(prose)).toThrow(DocumentedFixtureError);
  });

  it('真的那份文件裡，散文提到的旗標一次都沒被算進去', () => {
    // 上面那條用的是手寫的散文；這一條對著**真的檔案**問同一件事——文件改寫之後，
    // 手寫樣本不會跟著變，真檔案會。
    expect(documentedFixture()).toBe('src/approval.patch.yml');
  });
});
