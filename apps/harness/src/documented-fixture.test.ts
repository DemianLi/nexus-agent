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
        '```bash\npnpm --filter @nexus/harness run serve --plugins src/approval.fixture.ts\n```',
      ),
    ).toBe('src/approval.fixture.ts');
  });

  it('真的那份文件讀得到，而且指向一個真的存在的 fixture', () => {
    const fixture = documentedFixture();
    expect(fixture).toBe('src/approval.fixture.ts');
  });

  it('一處都沒有時拋，訊息指名是哪份文件', () => {
    expect(() => parseDocumentedFixture('# 沒有指令的文件\n\n什麼都沒有。')).toThrow(
      DocumentedFixtureError,
    );
    expect(() => parseDocumentedFixture('# 沒有指令的文件')).toThrow(OPERATIONS_DOC);
  });

  it('多於一處時拋，而且把找到的都列出來', () => {
    const two = '--plugins src/a.ts\n\n--plugins src/b.ts';
    expect(() => parseDocumentedFixture(two)).toThrow(DocumentedFixtureError);
    // 列出來是為了讓人一眼看到是哪兩道指令打架，不必自己回去翻文件。
    expect(() => parseDocumentedFixture(two)).toThrow('src/a.ts、src/b.ts');
  });

  it('不會把後面的字一起吃進來', () => {
    // `\S+` 而不是「到行尾」：CLI 那條指令的 fixture 後面還跟著別的參數。
    expect(parseDocumentedFixture('--plugins src/approval.fixture.ts 動手')).toBe(
      'src/approval.fixture.ts',
    );
  });
});
