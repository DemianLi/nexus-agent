/**
 * **「會話 resume」在我們這裡不是一扇門，是兩扇。** 門 A（會話日誌的回讀）2026-09-11 開了
 * ——CLI 的 `--resume`（[#251](https://github.com/DemianLi/nexus-agent/issues/251)）；門 B（落盤
 * checkpointer）那張卡決定不開。這一份原本把「兩扇都關著」釘成**翻得了面**的絆索：門 A 那一半
 * 已經翻面成它的形狀驗收，門 B 那一半照舊。
 *
 * 圖是 [#190](https://github.com/DemianLi/nexus-agent/issues/190)，這一份是它第 1 格
 * （`agent/session-start`）掉出來的 [#201](https://github.com/DemianLi/nexus-agent/issues/201)
 * 再掉出來的 [#203](https://github.com/DemianLi/nexus-agent/issues/203)。
 * **這一份不建 resume**——門 A 的實作在 `@nexus/core` 與 `cli.ts`，行為驗在
 * `session-resume.test.ts`；這裡只守形狀，與守著門 B。
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
 * 回來的會話會是半個，而**哪一半是真相，是開門之前就要決定的事**。#251 決定了：只開門 A，
 * 回來的是日誌那一半，對話與計劃模式從頭開始，而入口照實這樣講。
 *
 * ## 門 B 的絆索
 *
 * 門 A 原本有兩條：`SessionStore.create` 撞到已存在的就拒絕（`jsonl-session-store.ts` 的
 * `open(path, 'wx')`），與這一份下半那兩張結構表。開門之後前者照樣成立——續接走 `resume`
 * 不走 `create`——後者翻面成了形狀驗收。**門 B 本來一條都沒有**——換掉組裝點那一行不會
 * 撞到任何東西——所以這一份補上它。
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
 * 不換 checkpointer、不碰 `onlyBuiltDependencies`、不動 goal 的 `activation` 語義（保證它的
 * 是折疊規則不只是壽命：`service.ts` 讓重放時每一顆 `goal/change` 都主動打回 `disarmed`，
 * 續接回來的目標因此一律要人重新授權）。
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
  '工具結果暫存；會話日誌帶回 goal 的相位與輪次、todo、`turn/*`、沙箱模式。\n' +
  '**門 A 已經開了**（CLI 的 `--resume`），而 ' +
  '[#251](https://github.com/DemianLi/nexus-agent/issues/251) **決定門 B 不開**：兩份耐久來源' +
  '的寫入順序會分岔（checkpoint 寫了日誌沒寫，或反過來），要先有一條對帳規則。' +
  '動它之前先回去看那個決定。\n' +
  '真的要開的話，這兩處要跟著改：\n' +
  `  1. ${paths[0]} —— 計劃模式為什麼不搬進會話日誌的那一段。` +
  '門 B 一開，計劃模式會從 checkpointer 回來，那一段「只開門 A 會悄悄消失」的說法跟著過期。\n' +
  `  2. ${paths[1]} 的 ${TOOL_RESULT_STASH_PREFIX} —— ` +
  '[#155](https://github.com/DemianLi/nexus-agent/issues/155) 記著「軸 2 一旦要做，' +
  '第一個要處理的是 [#170](https://github.com/DemianLi/nexus-agent/issues/170) ' +
  '工具結果暫存的保留策略」：checkpointer 落盤之後，暫存檔要不要跟著活下來是一個新問題。\n' +
  '全文見 [#203](https://github.com/DemianLi/nexus-agent/issues/203) 與 ' +
  '[#251](https://github.com/DemianLi/nexus-agent/issues/251)。';

/**
 * 失敗訊息裡那三個目的地，**逐一從磁碟讀過**。
 *
 * 讀而不 glob：檔案改名要 `ENOENT`，**不能靜靜地掃不到**（同 #195 的做法）。第三個目的地
 * 用的是 `TOOL_RESULT_STASH_PREFIX` 這個 import——那一格連檔名都不必猜，編譯器會擋。
 */
const DESTINATIONS = [
  'packages/nexus-plugin-plan-mode/src/index.ts',
  'apps/harness/src/agent-factory.ts',
] as const;

/** 每個目的地必須還講著那件事。**錨點選的是改寫時不會動的那一句。** */
const DESTINATION_ANCHORS: readonly (readonly [string, readonly string[]])[] = [
  // 這一句的**理由**是會改的（而且改過兩次了），結論不是——所以錨在結論上。
  // 原本還有 goal 的 `tools.ts` 那一格：dsh 那句 resume 政策文字「有回讀那天它才該回來」。
  // 門 A 開的那天它回來了（#251），那一格不再是門 B 的事。
  [DESTINATIONS[0], ['但計劃模式沒有跟著搬，而理由不是慣性']],
  [DESTINATIONS[1], ['TOOL_RESULT_STASH_PREFIX']],
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
/* 門 A：會話日誌的 seeded 路——開了，這裡是它的形狀驗收                          */
/* -------------------------------------------------------------------------- */

/**
 * `SessionLogOptions` 的每一格逐個列出來。
 *
 * **這張表原本是門 A 的絆索**：當時只有 `onListenerError` 一格，註解寫著「門 A 開的樣子就是
 * 這裡多一格」。[#251](https://github.com/DemianLi/nexus-agent/issues/251) 開門的那天它照設計
 * 紅在 `typecheck`（`TS1360: Property 'seed' is missing`），現在翻面成形狀的驗收：**seeded 路
 * 是一個建構選項，而且只有這一個**。再長一格，仍然紅在這裡。
 */
const SESSION_LOG_OPTIONS = {
  onListenerError: true,
  seed: true,
} satisfies Record<keyof SessionLogOptions, true>;

/**
 * `SessionLog` 的靜態面，同樣逐個列出來。
 *
 * seeded 路落在建構選項上，**沒有**長成 `SessionLog.from(storedEvents)` 這種靜態工廠——
 * 兩條並存的話，seed 的驗證（連續、拷、凍、補 end-seed）會有一條走不到。多一個靜態成員，
 * `typecheck` 就紅在「少一個屬性」（預檢時真的加過一個 `static from()` 量過）。
 */
const SESSION_LOG_STATICS = {
  prototype: true,
} satisfies Record<keyof typeof SessionLog, true>;

/** 上一個行程的樣子：一輪跑完。 */
function earlierLog(): SessionLog {
  const log = new SessionLog('door-a');
  log.append('turn/start', { kind: 'message', text: '一' });
  log.append('turn/end', {});
  return log;
}

describe('門 A：會話日誌的 seeded 路', () => {
  it('seeded 路是一個建構選項，沒有第二條', () => {
    expect(Object.keys(SESSION_LOG_OPTIONS)).toEqual(['onListenerError', 'seed']);
    expect(Object.keys(SESSION_LOG_STATICS)).toEqual(['prototype']);
  });

  /** 沒給 seed 的行為不能跟著動——原本那條絆索的行為半邊，原樣留著。 */
  it('一份新日誌仍然從空的開始，`seq` 從 0 起算', () => {
    const log = new SessionLog('door-a');
    expect(log.length).toBe(0);
    expect(log.events).toEqual([]);
    expect(log.append('turn/start', { kind: 'message', text: '一' }).seq).toBe(0);
    expect(log.append('turn/start', { kind: 'message', text: '二' }).seq).toBe(1);
    expect(log.length).toBe(2);
  });

  it('帶 seed 開的日誌從 seed 的長度續號，結尾補一顆 `session/end-seed`', () => {
    const resumed = new SessionLog('door-a', { seed: earlierLog().events });
    expect(resumed.events.map((event) => [event.seq, event.type])).toEqual([
      [0, 'turn/start'],
      [1, 'turn/end'],
      [2, 'session/end-seed'],
    ]);
    expect(resumed.append('turn/start', { kind: 'message', text: '二' }).seq).toBe(3);
  });

  it('seed 已經以 `session/end-seed` 結尾就不再補——重開一份沒動過的會話不疊標記', () => {
    const once = new SessionLog('door-a', { seed: earlierLog().events });
    const twice = new SessionLog('door-a', { seed: once.events });
    expect(twice.events.map((event) => event.type)).toEqual([
      'turn/start',
      'turn/end',
      'session/end-seed',
    ]);
  });

  it('seed 缺號就拒絕——開出來的日誌 `length` 與 `seq` 會對不上', () => {
    const [, second] = earlierLog().events;
    expect(() => new SessionLog('door-a', { seed: [second!] })).toThrow(
      /seed 不連續：第 0 顆的 seq 是 1/,
    );
  });

  it('seed 凍住了——從磁碟讀回來的純物件也改不動，拿去改的那一份也動不到日誌', () => {
    const plain = JSON.parse(JSON.stringify(earlierLog().events)) as {
      data: { text?: string };
    }[];
    const log = new SessionLog('door-a', { seed: plain as never });
    const [first] = log.events;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first!.data)).toBe(true);
    plain[0]!.data.text = '改掉了';
    expect(first!.data).toEqual({ kind: 'message', text: '一' });
  });
});
