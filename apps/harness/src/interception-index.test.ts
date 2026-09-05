/**
 * 攔截時刻的索引：**dsh 的九個時刻裡，我們佔住的那五格分別是誰佔的、又比標準少了什麼。**
 *
 * 圖是 [#190](https://github.com/DemianLi/nexus-agent/issues/190)，這一份是它的候選 3
 * （[#193](https://github.com/DemianLi/nexus-agent/issues/193)）。九格逐格的核對過程在
 * 那張圖上，**這裡不重複論證，只保留索引與那條防漂移的斷言**。
 *
 * ## 為什麼是這裡，而不是 `registry.ts` 的檔頭
 *
 * 最直覺的家是 `PluginRegistry` 的十四個欄位。**那是錯的軸**：第 2、6、7 格全擠在
 * `middleware` 一個欄位，第 3 格落在 `apps/harness` 根本沒有欄位，而第 6／7 格的**位置**
 * 是 `fold.ts` 決定的、不由註冊順序決定——欄位這一軸連「排在第幾個」都表達不出來。
 * #190 記著同型的坑：grep `lifecycle` 找生命週期鉤子會落到關機 disposer 上。
 *
 * ## 判準：拿時刻名 grep 得不得到佔住它的人
 *
 * 開卡時量過，**五格佔住的只有一格半 grep 得到**，而 `tools/post-execute` 會把人帶到
 * `repeat-reminder.ts`——那個檔案提到這個名字，是為了說「投遞掛在 `beforeModel`，
 * **不是** post-execute」。所以這一份的第一產物是**佔用者身上那幾行 JSDoc**，索引是閱讀面，
 * 下面那條斷言是絆索。
 *
 * ## 每一列兩件事，不是一個判決
 *
 * #190 開圖時寫「每格收成 (a)/(b)/(c) 三選一」，兩張子卡答完發現**最有資訊量的兩格都是
 * (a) 與 (b) 同時成立**（第 2 格機制在、紀錄不在；第 7 格佔住了、位置點不到）。所以每列把
 * 缺口拆成 {@link InterceptionRow.permissionDelta}（權限差）與
 * {@link InterceptionRow.recordDelta}（紀錄差）兩欄——**只有一欄判決的索引寫不下那兩格**。
 *
 * ## 缺口帳：三筆，其中兩筆是同一個缺件
 *
 * 這三筆已經散在三個檔頭裡，沒有被漏掉，只是沒有被索引。**這一份只負責認帳，不決定要不要
 * 補**——「圖裡發生的事有沒有一條進日誌的路」是 #190 的候選 5，射程在那裡。
 *
 * 1. **第 7 格位置點不到**——`MiddlewareRegistrationPoint` 只有 `prepend` 一根槓桿，給的是
 *    最外；記在 `output-schema.ts` 檔頭與計劃 Phase 4。
 * 2. **第 2 格終止原因記不下來**——`turn/*` 由入口點在**圖外**附加（`thread-pump.ts` 的
 *    `#runOnce`、`cli.ts` 的 `runTurn`），所以 `jumpTo: 'end'` 跳掉的輪次在日誌上與正常
 *    跑完的長得一模一樣，dsh 的「blocked 輪次」表達不出來。
 * 3. **第 9 格工具事件缺席**——`SessionEventType` 十種（`session-log.ts`）沒有一顆工具事件，
 *    而這個缺席已經婉拒過 #180 第五節那條停損，理由逐字寫在 `goal-driver.ts` 檔頭。
 *
 * **第 2 與第 3 筆是同一個缺件。**
 *
 * ## 沒有進索引的四格
 *
 * 第 1（`agent/session-start`）、5（`ctx.tools.guard()`）、8（`ToolDefinition.finalizeContent`）、
 * 9（`tools/result`）格今天沒有佔用者，所以索引裡沒有它們的列——**這一份索引的軸是「誰佔住」，
 * 空格沒有東西可指**。第 5 與第 8 格是 #190 的候選 4，第 9 格見上面的缺口帳。
 *
 * ## dsh 那側的字串
 *
 * 九個時刻名逐字對過 `references/deepseek-harness`，SHA
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`（2026-09-04）。**那份 clone 不進版控**，所以
 * 下面的斷言只驗我們這側；dsh 那側要重對時自己 `git -C references/deepseek-harness fetch`
 * 再對 SHA，clone 會凍在 clone 當下。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 這個 repo 的根。從 `apps/harness/src/` 往上三層。 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface InterceptionRow {
  /** #190 那張表的格號。 */
  readonly cell: number;
  /** dsh 的時刻名，**逐字**。這是 grep 的入口，也是下面斷言要在佔用者身上找的字串。 */
  readonly moment: string;
  /** dsh 給這個時刻的權限。 */
  readonly permission: string;
  /**
   * 佔住它的檔案，repo 相對路徑。
   *
   * **每一個都必須提到 {@link moment}。** 那不是形式——那就是這一份的判準本身。
   */
  readonly occupants: readonly string[];
  /** 權限那一軸比 dsh 少了什麼。`undefined` ＝ 三欄逐欄對得上。 */
  readonly permissionDelta: string | undefined;
  /** 紀錄那一軸比 dsh 少了什麼。`undefined` ＝ 沒有紀錄面的缺口。 */
  readonly recordDelta: string | undefined;
}

/**
 * 五條。**#190 九格核完，(a) 就是這五格**；沒有佔用者的四格不在這裡，理由見檔頭。
 */
const INDEX: readonly InterceptionRow[] = [
  {
    cell: 2,
    moment: 'agent/pre-step',
    permission: 'waterfall，可 reject（關掉一個 blocked、無步驟的輪次）',
    occupants: ['packages/nexus-plugin-plan-mode/src/index.ts'],
    permissionDelta:
      "注入與攔截兩半都在，但**攔截那半在產品程式碼零使用**：`jumpTo: 'end'` 真的做得到" +
      '（#192 實測，裸基座與我們的組裝一致，模型呼叫次數 0、無模型可見訊息），' +
      "而鉤子要寫成 `{ hook, canJumpTo: ['end'] }` 才裝得上 router——光函式形執行期拋。" +
      '**這半格沒有佔用者可指，只存在於這一列。**' +
      '注入那半只引一個佔用者，是量過的：`beforeAgent:` 在我們樹上**只有這一個實作**。' +
      '#190 那格另外點名的 memory 與 skills **不是我們的佔用者**——它們只註冊來源' +
      '（`registry.memory.addSource` / `registry.skills.addSource`），middleware 由基座建' +
      '（兩個 plugin 的檔頭都寫著「基座連 middleware 都不會建」）。`wrapModelCall` 另有四處' +
      '（`model-usage.ts`、`summarization.ts` ×2、`observation.ts`），但它們做的是計量、' +
      '摘要與觀測，**不是 pre-step 注入**，掛這個名字會是過度宣稱；plan-mode 自己登記的也是' +
      '「`beforeAgent` 是 `agent/pre-step` 邊界提交的對應物」。',
    recordDelta:
      '終止原因記不下來。`turn/*` 由入口點在圖外附加，跳掉的輪次與正常跑完的在日誌上' +
      '長得一模一樣，沒宣告拋出去則記成 `turn/failed`——沒有一個是 dsh 的 blocked。',
  },
  {
    cell: 3,
    moment: 'agent/turn-stopping',
    permission: 'awaited 通知，聽者可以要求再跑一步（`agent.steer()`）',
    occupants: ['apps/harness/src/goal-driver.ts'],
    permissionDelta:
      '**只佔了一半**：`agent.steer()` 沒有等價物，輪迴圈歸入口點所有。' +
      '載體偏離已登記在該檔檔頭；今天只有 goal 一個消費者，一個消費者不撐起一條通道。',
    recordDelta: undefined,
  },
  {
    cell: 4,
    moment: 'tools/pre-execute',
    permission: 'waterfall，allow／deny／ask',
    occupants: ['packages/nexus-core/src/approval.ts'],
    permissionDelta: undefined,
    recordDelta: undefined,
  },
  {
    cell: 6,
    moment: 'tools/execute',
    permission: '環繞 waterfall（超時／重試／指標）',
    occupants: [
      'packages/nexus-core/src/containment.ts',
      'packages/nexus-core/src/fold.ts',
      'packages/nexus-plugin-plan-mode/src/index.ts',
      'packages/nexus-plugin-validation/src/output-schema.ts',
    ],
    permissionDelta:
      '**這一格與第 4、7 格在我們這側是同一種機制的三個陣列位置**，dsh 那三格是三種權限' +
      '不同的東西。位置由 `fold.ts` 決定，不由註冊順序決定。',
    recordDelta: undefined,
  },
  {
    cell: 7,
    moment: 'tools/post-execute',
    permission: '檢查／變換 waterfall，可 `additionalContexts`',
    occupants: ['packages/nexus-plugin-validation/src/output-schema.ts'],
    permissionDelta:
      '**位置點不到**（見檔頭缺口帳第 1 筆）。另外 `additionalContexts` 的射程只到' +
      '「單一生產者、一則脈絡、成功路徑」——交錯順序、失敗路徑收集、被外層阻止時丟棄' +
      '三條契約今天零生產者也就零驗證，**第二個生產者出現就要重判這一格**。',
    recordDelta: undefined,
  },
];

/** 索引的列數。**釘死是刻意的**：只 grep 不數，刪掉一列這份測試照樣綠。 */
const EXPECTED_ROWS = 5;

/** 佔用位址的總數（列可能共用檔案，第 6 與第 7 格就共用 `output-schema.ts`）。 */
const EXPECTED_SITES = 8;

describe('攔截時刻索引', () => {
  it(`剛好 ${EXPECTED_ROWS} 列，${EXPECTED_SITES} 個佔用位址`, () => {
    // 兩個數字都釘死，因為這條測試的失敗模式是**沒東西可掃**：只驗「每一列都對」的話，
    // 把列刪光它會永遠綠。
    expect(INDEX).toHaveLength(EXPECTED_ROWS);
    expect(INDEX.flatMap((row) => row.occupants)).toHaveLength(EXPECTED_SITES);
    expect(new Set(INDEX.map((row) => row.moment)).size).toBe(EXPECTED_ROWS);
  });

  it.each(INDEX.map((row) => [row.cell, row.moment, row] as const))(
    '第 %s 格 %s 的每個佔用者都提到這個時刻名',
    (_cell, moment, row) => {
      expect(row.occupants.length).toBeGreaterThan(0);
      for (const path of row.occupants) {
        // **刻意直接讀、不 glob**：檔案被改名時要當場炸，而不是靜靜地掃到零個檔案。
        const source = readFileSync(join(REPO_ROOT, path), 'utf8');
        expect(source.length).toBeGreaterThan(0);
        expect(source, `${path} 沒有提到 ${moment}`).toContain(moment);
      }
    },
  );
});
