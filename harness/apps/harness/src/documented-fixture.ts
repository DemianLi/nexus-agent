/**
 * 把 [`docs/operations.md`](../../../docs/operations.md) 裡那道核准指令的 `--patch` 值讀出來。
 *
 * **這個檔案的目的是讓一種漂移在機制上不可能發生**：文件教人跑的那道指令，與測試真的跑的那條
 * 參數，今天是兩份手抄的字串。改了文件、測試不會紅；改了測試、文件不會紅。`serve.test.ts` 與
 * `cli.test.ts` 的散文都寫著「跟那份文件同一份 fixture」，而那句話沒有任何東西在守。
 *
 * **修法不是加一條「比對兩份字串」的測試。** 那會變成第三份要維護的副本，而且它守的是「副本
 * 相等」，不是「文件是對的」。這裡讓文件成為唯一來源：測試從文件讀，抄錯就只剩一個地方可抄。
 *
 * 舊版正則釘的是「任何一處 `--plugins` 旗標」，文件散文裡也提到 `--patch` 好幾次，所以會誤抓。
 * 新版正則錨在「那道 `run serve --patch` 指令」，這樣文件散文裡的 `--patch` 提及（沒有 `run serve`
 * 前綴）就不會被誤抓——承重的只有那一道指令的參數。
 *
 * **抓不到一律拋，不回預設值。** 一個「找不到就退回寫死的值」的解析器會把自己要守的東西吃掉：
 * 文件改壞了它照樣餵出舊值，測試照樣綠。這一條有反向突變在守（見 `documented-fixture.test.ts`）。
 *
 * 同型的做法在 web 那側已經有兩處：`apps/web/src/lib/question-view.test.ts` 讀
 * `packages/nexus-core/src/turn-cancel.ts` 的原始碼比字串，`apps/web/src/hooks/use-mobile.test.tsx`
 * 讀 `sidebar.tsx`。都是釘「兩個沒有相依關係的東西要保持一致」。
 *
 * @see [#490](https://github.com/DemianLi/nexus-agent/issues/490)
 * @module
 */

import { readFileSync } from 'node:fs';

/** 被讀的那份文件，寫進錯誤訊息用。`apps/harness/src/` 往上三層就是 repo 根。 */
export const OPERATIONS_DOC = 'docs/operations.md';

/** 解析不出來時拋這個。訊息要指名是哪份文件的哪一段該修。 */
export class DocumentedFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentedFixtureError';
  }
}

/**
 * 從文件內容裡抓 `run serve --patch` 指令的 patch 值。
 *
 * 恰好命中一次才回傳。零次代表文件把那道指令刪了或改了寫法，兩次以上代表文件多了一道指令而
 * 這裡不知道該用哪一個——兩種都是人要去看的，不是機器該猜的。
 *
 * @param source - `docs/operations.md` 的全文。
 * @returns `run serve --patch` 後面那個值。
 */
export function parseDocumentedFixture(source: string): string {
  const matches = [...source.matchAll(/run serve --patch\s+(\S+)/gu)];

  if (matches.length === 0) {
    throw new DocumentedFixtureError(
      `${OPERATIONS_DOC} 裡找不到任何 \`run serve --patch <值>\`。「核准」那一節該有一道 ` +
        '`pnpm --filter @nexus/harness run serve --patch <patch 檔>` 的指令；' +
        '指令改了寫法的話，這裡的解析與那一段要一起改。',
    );
  }

  if (matches.length > 1) {
    const found = matches.map((match) => match[1]!).join('、');
    throw new DocumentedFixtureError(
      `${OPERATIONS_DOC} 裡有 ${String(matches.length)} 處 \`run serve --patch\`（${found}），` +
        '這裡不知道該拿哪一個餵進測試。文件多一道指令是好事，但要回來指定是哪一道。',
    );
  }

  return matches[0]![1]!;
}

/**
 * 讀檔再解析。測試直接叫這個。
 *
 * @returns 文件裡那道核准指令用的 fixture 路徑。
 */
export function documentedFixture(): string {
  const source = readFileSync(new URL(`../../../${OPERATIONS_DOC}`, import.meta.url), 'utf8');
  return parseDocumentedFixture(source);
}
