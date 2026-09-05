/**
 * eval 這條路上沒有會話註冊表，**而那是一個決定**——這個檔是那個決定的絆索。
 *
 * 三個入口對「會話日誌要不要落盤」給了三個不同的答案（[#174](https://github.com/DemianLi/nexus-agent/issues/174)）：
 * CLI 選擇性落盤、`serve` 選擇性落盤、eval **連日誌都沒有**。前兩個看得見（旗標、
 * 披露行、`session-log-durability.test.ts` 與 `serve-session-log.test.ts`），
 * 第三個看不見——**沒接線的檔案跟忘了接線的檔案長得一模一樣**。
 *
 * 所以斷言掛在 import 行上：有人替 `runner.ts` 接上註冊表的那一刻，這條會紅，
 * 而紅的內容是一個問題（「那落盤呢」）不是一句禁令。
 *
 * **為什麼只看 import 行**：`runner.ts` 的檔頭要講得出它不接的是什麼，掃全檔的話
 * 那段說明自己就會踩到自己。
 *
 * **為什麼不是掃空也會綠**：先斷言檔案讀得到、而且真的有 import 行
 * （路徑打錯或檔案搬走時，掃描型的 gate 會永遠綠——這兩句就是擋那個的）。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 出現在 import 行上就代表 eval 接了註冊表。 */
const FORBIDDEN = ['SessionRegistry', 'attachSession', 'attachSessionPersistence'] as const;

const RUNNER = fileURLToPath(new URL('./runner.ts', import.meta.url));

async function importLines(path: string): Promise<readonly string[]> {
  const source = await readFile(path, 'utf8');
  return source.split('\n').filter((line) => line.startsWith('import '));
}

describe('eval 沒有會話註冊表', () => {
  it('runner.ts 的 import 行讀得到，而且不是空的', async () => {
    const lines = await importLines(RUNNER);
    // 這一條在擋「gate 掃到空的所以永遠綠」：下面那條的價值全靠這裡成立。
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join('\n')).toContain('createNexusAgent');
  });

  it.each(FORBIDDEN)('runner.ts 沒有 import %s', async (symbol) => {
    const lines = await importLines(RUNNER);
    const offending = lines.filter((line) => line.includes(symbol));
    expect(
      offending,
      `eval 現在有會話註冊表了（\`${symbol}\`）。那不是壞事，但它帶著一個沒答的問題：` +
        `這條路的日誌要不要落盤？三個入口今天各有各的答案（#174），所以要嘛接上 ` +
        `\`attachSessionPersistence\`、要嘛在 runner.ts 的檔頭把「為什麼還是不接」寫清楚——` +
        `然後改掉這條測試。`,
    ).toEqual([]);
  });
});
