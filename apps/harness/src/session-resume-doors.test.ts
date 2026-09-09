/**
 * **「會話 resume」在我們這裡不是一扇門，是兩扇，而它們今天都關著。** 這一份把「關著」
 * 釘成一條**翻得了面**的絆索。
 *
 * 圖是 [#190](https://github.com/DemianLi/nexus-agent/issues/190)，這一份是它第 1 格
 * （`agent/session-start`）掉出來的 [#201](https://github.com/DemianLi/nexus-agent/issues/201)
 * 再掉出來的 [#203](https://github.com/DemianLi/nexus-agent/issues/203)。
 * **不建 resume，不改任何行為。**
 *
 * ## 兩扇門，各自只帶得回半個會話
 *
 * | 狀態 | 住在哪 | 哪扇門帶得回來 |
 * | --- | --- | --- |
 * | 對話訊息、`planModeActive`、虛擬檔案系統、工具結果暫存 | graph state ／ checkpointer | **門 B** |
 * | goal 的相位與輪次、todo、`turn/*` | 會話日誌 | **門 A** |
 *
 * **這條裂縫是兩個相反決定的交點**：todo 走事件不走 graph state 是寫下來的判準
 * （`plugin-todo/src/index.ts`），plan-mode 走 graph state 是登記過的偏離
 * （`plugin-plan-mode/src/index.ts`）。**今天看不見，因為兩半一起消失**——只開一扇門，
 * 回來的會話會是半個，而**哪一半是真相，是開門之前就要決定的事**。
 *
 * ## 絆索今天不對稱，這一份補上另一半
 *
 * **門 A 有**：`SessionStore.create` 對已存在的 session 必須拒絕，`session-store.ts` 逐字
 * 說那條拒絕「是未來那個 seeded／rehydrate 路徑的絆索」，落在 `jsonl-session-store.ts`
 * 的 `open(path, 'wx')`。**門 B 一條都沒有**——換掉組裝點那一行不會撞到任何東西。
 *
 * ## 這條絆索釘得到什麼、釘不到什麼
 *
 * 下面第一層掃的是**整棵樹上「誰 `new` 了一顆 checkpointer」**，不是「`cli.ts` 那一行還在
 * 不在」。今天的答案是恰好一處，而那一處在 `createCliAgent` 裡——**`serve.ts` 走的是同一個
 * 組裝點**（它呼叫 `createCliAgent`，不自己 `createNexusAgent`），所以釘一處就把 CLI 與 web
 * 兩條產品路徑都蓋住了。
 *
 * **明著在柵欄外的兩處**：`eval/runner.ts` 與 `spike/spike-agent.ts` 也呼叫
 * `createNexusAgent`，但**兩處都不給 checkpointer**（`eval/runner.ts` 那個「沒有 checkpointer」
 * 甚至是核准閘門今天走 `no-channel` 的原因，那一段自己記著）。它們哪天長出一顆，下面那張
 * 表就會多一列而當場紅——**那正是該響的時候**。
 *
 * **釘的是會翻面的那個宣稱本身，不是數量**（承
 * [#195](https://github.com/DemianLi/nexus-agent/issues/195) 與
 * [#199](https://github.com/DemianLi/nexus-agent/issues/199)）：一張 `path: 那一行` 的有序
 * 清單改起來要看內容，`toHaveLength(1)` 不用。
 *
 * ## 這一份不做什麼
 *
 * 不建 resume、不換 checkpointer、不碰 `onlyBuiltDependencies`、不動 goal 的 `activation`
 * 語義（它今天是對的，而且保證它的是折疊規則不只是壽命：`service.ts` 讓重放時每一顆
 * `goal/change` 都主動打回 `disarmed`），也不補 `SessionStore` 的讀介面——那是門 A 的工作量。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionLog } from '@nexus/core';
import type { SessionLogOptions } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { TOOL_RESULT_STASH_PREFIX } from './agent-factory.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/* -------------------------------------------------------------------------- */
/* 門 B：整棵樹上唯一那顆 checkpointer，是不耐久的那一顆                          */
/* -------------------------------------------------------------------------- */

/**
 * 掃哪些原始碼。**只掃 `src/`，測試檔明著排除。**
 *
 * `MemorySaver` 在樹上命中二十幾個檔，**其中絕大多數是測試各自 `new` 一顆自己用的**——
 * 把它們收進來，這條絆索量的就變成「測試怎麼寫」而不是「產品組裝成什麼樣」。
 */
const SOURCE_ROOTS = ['apps/harness/src', 'apps/web/src', 'packages'] as const;

/** 遞迴列出 `.ts`，跳過測試、fixture 與建置產物。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.fixture.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * 全樹**建構**一顆 checkpointer 的每一處，`路徑: 那一行`。
 *
 * **量的是 `new …Saver(`，不是 `checkpointer:` 這個鍵。** 那個鍵在註解裡出現十幾次，
 * 而 `agent-factory.ts` 那一處只是把呼叫端給的東西轉手——兩者都不是「誰決定了耐久性」。
 * 決定它的是誰 `new` 了一顆，而那件事全樹只發生一次。
 *
 * 換成變數（`const saver = new SqliteSaver(); … checkpointer: saver`）也躲不掉：那一行
 * 照樣是 `new …Saver(`，只是文字不同，清單當場對不上。
 */
function saverConstructions(): string[] {
  const found: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(join(REPO_ROOT, root))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const line of lines) {
        if (!/new\s+\w*Saver\s*\(/u.test(line)) continue;
        found.push(`${relative(REPO_ROOT, file)}: ${line.trim()}`);
      }
    }
  }
  return found.sort();
}

/**
 * 今天全樹唯一那一處。**這是 characterization：它記的是現況，不是理想形狀。**
 *
 * `MemorySaver` 是 process 內的，重啟就沒——**門 B 關著**。
 *
 * **2026-09-09 這一行的字面改過一次，門沒有動。** 原本是 `checkpointer: new MemorySaver(),`
 * 寫在 `createNexusAgent` 的參數上；[#231](https://github.com/DemianLi/nexus-agent/issues/231)
 * 把它提成一個區域變數，因為 `ask_user_question` 的 fail-closed 要問「這次組裝有沒有
 * checkpointer」，而寫死 `true` 就會在門真的開的那天靜靜地說謊。**建的仍是同一顆、
 * 仍然只有這一處、仍然是不耐久的那一種**——所以這裡改的是 characterization 的字面，
 * 不是上面那三個目的地的任何一個。
 */
const THE_ONLY_SAVER = ['apps/harness/src/cli.ts: const checkpointer = new MemorySaver();'];

/**
 * 這條絆索響的時候，讀的人該往哪裡去。**三個目的地，不是「值不對」。**
 *
 * 三個路徑常數在下面各自被讀過一次（改名就 ENOENT，不會靜靜地掃不到），所以這段文字裡
 * 的路徑不會指向一個已經不在的檔案。
 */
const DOOR_B_GUIDANCE = (paths: readonly string[]): string =>
  '**門 B（落盤 checkpointer）動了。**\n' +
  '這不是把期望值改一改就好的事——會話 resume 在我們這裡是**兩扇門**，' +
  '而它們載的是不同的一半：checkpointer 帶回對話訊息、`planModeActive`、虛擬檔案系統、' +
  '工具結果暫存；會話日誌帶回 goal 的相位與輪次、todo、`turn/*`。\n' +
  '**只開一扇，回來的會話就是半個。開之前要先決定哪一半是真相。**\n' +
  '真的要開的話，這三處要跟著改：\n' +
  `  1. ${paths[0]} —— 「After session resume or fork, an active goal is disarmed…」` +
  '這一句 dsh 的政策文字**今天刻意不抄**，理由逐字是「有回讀那天它才該回來」。' +
  '同一個條件在 `activation` 那一格的 schema 註解裡**還有第二份**——兩處都是模型讀得到的' +
  '文字，改一處漏一處，模型會不知道自己為什麼被 disarm。' +
  '（goal 的**機制**不會壞：折疊規則讓重放時每一顆 `goal/change` 都主動打回 `disarmed`。）\n' +
  `  2. ${paths[1]} —— 計劃模式為什麼不搬進會話日誌的那一段。` +
  '它的理由已經被改過一次了（耐久了但沒有讀方），**開門那天要再改一次**。\n' +
  `  3. ${paths[2]} 的 ${TOOL_RESULT_STASH_PREFIX} —— ` +
  '[#155](https://github.com/DemianLi/nexus-agent/issues/155) 記著「軸 2 一旦要做，' +
  '第一個要處理的是 [#170](https://github.com/DemianLi/nexus-agent/issues/170) ' +
  '工具結果暫存的保留策略」：checkpointer 落盤之後，暫存檔要不要跟著活下來是一個新問題。\n' +
  '全文見 [#203](https://github.com/DemianLi/nexus-agent/issues/203)。';

/**
 * 失敗訊息裡那三個目的地，**逐一從磁碟讀過**。
 *
 * 讀而不 glob：檔案改名要 `ENOENT`，**不能靜靜地掃不到**（同 #195 的做法）。第三個目的地
 * 用的是 `TOOL_RESULT_STASH_PREFIX` 這個 import——那一格連檔名都不必猜，編譯器會擋。
 */
const DESTINATIONS = [
  'packages/nexus-plugin-goal/src/tools.ts',
  'packages/nexus-plugin-plan-mode/src/index.ts',
  'apps/harness/src/agent-factory.ts',
] as const;

/** 每個目的地必須還講著那件事。**錨點選的是改寫時不會動的那一句。** */
const DESTINATION_ANCHORS: readonly (readonly [string, readonly string[]])[] = [
  // 兩份都要在：政策文字那一份，與 `activation` 那一格的 schema 註解。
  // 只釘前者的話，模型讀得到的另一半沒有人守（`model-facing-surface-is-more-than-prose`）。
  [DESTINATIONS[0], ['有回讀那天它才該回來', '仍然沒有回讀路徑']],
  // 這一句的**理由**是會改的（而且剛改過），結論不是——所以錨在結論上。
  [DESTINATIONS[1], ['但計劃模式沒有跟著搬，而理由不是慣性']],
  [DESTINATIONS[2], ['TOOL_RESULT_STASH_PREFIX']],
];

describe('門 B：落盤 checkpointer', () => {
  it('全樹只有一處建 checkpointer，而且它是不耐久的那一顆', () => {
    expect(saverConstructions(), DOOR_B_GUIDANCE(DESTINATIONS)).toEqual(THE_ONLY_SAVER);
  });

  it.each(DESTINATION_ANCHORS)('失敗訊息指的 %s 還在，而且還講著那件事', (path, anchors) => {
    const source = readFileSync(join(REPO_ROOT, path), 'utf8');
    for (const anchor of anchors) {
      expect(
        source,
        `${path} 找不到「${anchor}」。\n` +
          '這是門 B 那條絆索的失敗訊息要送人去的地方之一。搬走了就把上面那份清單改對，' +
          '**不要只把這一條刪掉**——刪掉之後那條絆索響的時候，讀的人會被送到一個空地址。',
      ).toContain(anchor);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 門 A：會話日誌的 seeded／rehydrate 路                                         */
/* -------------------------------------------------------------------------- */

/**
 * `SessionLogOptions` 的每一格逐個列出來。
 *
 * `satisfies` 那一句是這一層的骨頭：**編譯器去比對欄位集合**，多一個或少一個都在
 * `typecheck` 當場紅。今天只有一格，而**那一格與回讀無關**——`SessionLog` 沒有任何
 * 「拿一份既有事件開場」的縫。
 *
 * **門 A 開的樣子就是這裡多一格**（`events` 之類）。它多的那天，`typecheck` 會先指到這個
 * 檔案，這個檔案的失敗訊息再把人送去上面那三個目的地——順序是兩段的，同
 * `registry-channel-count.test.ts`。
 */
const SESSION_LOG_OPTIONS = {
  onListenerError: true,
} satisfies Record<keyof SessionLogOptions, true>;

/**
 * `SessionLog` 的靜態面，同樣逐個列出來。
 *
 * **seeded 路不一定長成一個建構選項**——`SessionLog.from(storedEvents)` 這種靜態工廠是
 * 同樣自然的寫法，而它碰不到 `SessionLogOptions`，上面那張表看不見它。這一張看得見：
 * 多一個靜態成員，`typecheck` 就紅在「少一個屬性」。
 *
 * **這一張是量過的，不是寫上去就算數的。** 預檢時真的給 `SessionLog` 加了一個
 * `static from()`，`tsc` 當場報 `TS1360: Property 'from' is missing`——**一張掃空的結構
 * 表會永遠綠**，所以它必須自己證明過一次。
 */
const SESSION_LOG_STATICS = {
  prototype: true,
} satisfies Record<keyof typeof SessionLog, true>;

describe('門 A：會話日誌的回讀路徑', () => {
  it('`SessionLogOptions` 沒有任何一格是拿來塞既有事件的', () => {
    expect(Object.keys(SESSION_LOG_OPTIONS)).toEqual(['onListenerError']);
    expect(Object.keys(SESSION_LOG_STATICS)).toEqual(['prototype']);
  });

  /**
   * **`seq` 出自位置，不出自任何被交進來的東西。**
   *
   * 上面兩張表擋的是**形狀**（多一個建構選項、多一個靜態工廠），這一條擋的是**行為**：
   * 形狀一格都不動也做得到 seeded——把 `seq` 改成從一個既有的最大值續號就行。那一格
   * 是 seeded 路徑真正要動的東西，而編譯器看不見它。
   */
  it('一份新日誌從空的開始，`seq` 從 0 起算', () => {
    const log = new SessionLog('door-a');
    expect(log.length).toBe(0);
    expect(log.events).toEqual([]);
    expect(log.append('turn/start', { kind: 'message', text: '一' }).seq).toBe(0);
    expect(log.append('turn/start', { kind: 'message', text: '二' }).seq).toBe(1);
    expect(log.length).toBe(2);
  });
});
