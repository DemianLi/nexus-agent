/**
 * 平凡地板（[#1001](https://github.com/DemianLi/nexus-agent/issues/1001)）：三個不需要模型的
 * agent，跑七題，每一題都必須判成「不成功」。零憑證、不連外。
 *
 * **每一條都要先確認那次執行是 `scored`，再看它成不成功。** 失敗的執行（被拒、逾時、腳本用
 * 完）同樣「不成功」，但那是沒有資料，不是評分器擋住了它 —— 只斷言「不成功」的話，地板
 * 壞掉（例如腳本假模型被改壞、每題都拋）時這個檔案照樣全綠。
 */

import { describe, expect, it } from 'vitest';
import { ScriptedChatModel } from '../scripted-model.js';
import { benchmarkPlugins } from './assembly.js';
import { summarize, type TierOutcome } from './compare.js';
import { BENCHMARK, type BenchmarkCase } from './dataset.js';
import {
  DO_NOTHING,
  FIXED_SPRAY,
  FLOOR_AGENTS,
  FLOOR_STRINGS,
  floorHolds,
  formatFloor,
  RANDOM_LEGAL,
  SPRAY_CALLS,
  randomLegalCalls,
  runFloor,
  summarizeFloor,
} from './floor.js';
import { runBenchmarkCase } from './runner.js';

type Scored = Extract<TierOutcome, { kind: 'scored' }>;

/**
 * 整份資料集的地板結果，**整個檔案只跑一次**。三個 agent × 七題是 21 次完整的 agent 執行，
 * 每條測試各跑一遍的話本機快、CI 慢的差距會把它推到逾時（#1005 的 CI 就栽在這個形狀上）。
 * 結果是確定的，共用沒有風險。
 */
let cachedFloor: ReturnType<typeof runFloor> | undefined;
function fullFloor(): ReturnType<typeof runFloor> {
  cachedFloor ??= runFloor();
  return cachedFloor;
}

function scoredOnly(outcomes: readonly TierOutcome[]): readonly Scored[] {
  const scored = outcomes.filter((outcome): outcome is Scored => outcome.kind === 'scored');
  expect(scored.length, '有執行失敗：地板沒跑完，成功題數不代表任何事').toBe(outcomes.length);
  return scored;
}

describe('平凡地板：每個 agent、每一題都判不成功', () => {
  it('三個 agent × 整份資料集，全部評到分、全部不成功', async () => {
    const reports = await fullFloor();
    expect(reports.map((report) => report.tier.label)).toEqual(
      FLOOR_AGENTS.map((agent) => agent.label),
    );
    for (const report of reports) {
      const scored = scoredOnly(report.outcomes);
      expect(scored.map((outcome) => outcome.score.caseId)).toEqual(
        BENCHMARK.map((entry) => entry.id),
      );
      for (const outcome of scored) {
        expect(
          outcome.score.success,
          `${report.tier.label} 在 ${outcome.score.caseId} 上被判成功`,
        ).toBe(false);
      }
      const summary = summarize(report);
      expect(summary.scored).toBe(BENCHMARK.length);
      expect(summary.successes).toBe(0);
    }
  });
});

describe('固定亂吐要有牙齒', () => {
  // **這一節是地板測試的地板。** 上面那條對「什麼都不做」永遠成立（它在任何判準下都不成功），
  // 所以光看它，評分器放寬到什麼程度都看不出來。亂吐這個 agent 之所以存在，是因為它在
  // 寬鬆的兩欄（工具成功率、回覆提到）拿滿分 —— 它若失了牙，上一條就失去擋人的資格。
  async function sprayOutcomes(): Promise<readonly Scored[]> {
    const reports = await fullFloor();
    const report = reports.find((entry) => entry.tier.modelId === FIXED_SPRAY.modelId);
    expect(report).toBeDefined();
    return scoredOnly(report?.outcomes ?? []);
  }

  it('工具成功率那欄：每個有呼叫的題目都是 1.00', async () => {
    for (const outcome of await sprayOutcomes()) {
      const entry = BENCHMARK.find((candidate) => candidate.id === outcome.score.caseId);
      if (entry === undefined || entry.expected.toolCalls.length === 0) continue;
      expect(outcome.score.toolCallSuccess, outcome.score.caseId).toBe(1);
    }
  });

  it('回覆提到那欄：每個有要求的題目都是 1.00', async () => {
    let judged = 0;
    for (const outcome of await sprayOutcomes()) {
      const entry = BENCHMARK.find((candidate) => candidate.id === outcome.score.caseId);
      if (entry?.expected.mentions === undefined) continue;
      judged += 1;
      expect(outcome.score.mentions, outcome.score.caseId).toBe(1);
    }
    expect(judged).toBeGreaterThan(0);
  });

  it('擋住它的是參數與多叫次數：參數沒有一題是對的，多叫都超過容許值', async () => {
    for (const outcome of await sprayOutcomes()) {
      const entry = BENCHMARK.find((candidate) => candidate.id === outcome.score.caseId);
      if (entry === undefined) continue;
      if (entry.expected.toolCalls.length > 0) {
        expect(outcome.score.argumentCorrectness, outcome.score.caseId).toBeLessThan(1);
      }
      expect(outcome.score.extraToolCalls, outcome.score.caseId).toBeGreaterThan(
        entry.expected.maxExtraToolCalls ?? 0,
      );
    }
  });

  it('寬鬆判準會讓它成功 —— 放寬到「只看名字與關鍵字」，七題全過', async () => {
    // 這是在說明「拿掉參數與多叫次數這兩項，地板就紅」是真的：用同一批分數照寬鬆的
    // 判準重判一次，亂吐必須整份通過。這裡的 `loose` 只活在測試裡，不是產品程式碼。
    const loose = (outcome: Scored): boolean => {
      const columns = [outcome.score.toolCallSuccess, outcome.score.mentions].filter(
        (value): value is number => value !== undefined,
      );
      return columns.length > 0 && columns.every((value) => value === 1);
    };
    const outcomes = await sprayOutcomes();
    expect(outcomes.filter(loose).map((outcome) => outcome.score.caseId)).toEqual(
      BENCHMARK.map((entry) => entry.id),
    );
  });

  it('呼叫序列涵蓋每一題的期望名字序列（牙齒的來源）', () => {
    const names = SPRAY_CALLS.map((call) => call.name);
    for (const entry of BENCHMARK) {
      let cursor = 0;
      for (const want of entry.expected.toolCalls) {
        const at = names.findIndex((name, index) => index >= cursor && name === want.name);
        expect(at, `${entry.id} 的 ${want.name} 在亂吐序列裡找不到`).toBeGreaterThanOrEqual(0);
        cursor = at + 1;
      }
    }
  });
});

describe('隨機合法動作', () => {
  it('同一題永遠同一串，不同題不全相同', () => {
    for (const entry of BENCHMARK) {
      expect(randomLegalCalls(entry.id)).toEqual(randomLegalCalls(entry.id));
    }
    const distinct = new Set(BENCHMARK.map((entry) => JSON.stringify(randomLegalCalls(entry.id))));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('用到的工具名字都真的綁在基準任務的 agent 上', async () => {
    const model = new ScriptedChatModel({
      turns: [{ content: '', toolCalls: randomLegalCalls('probe') }, { content: '好了' }],
    });
    await runBenchmarkCase(BENCHMARK[0] as BenchmarkCase, {
      model,
      plugins: benchmarkPlugins(),
    });
    for (const entry of BENCHMARK) {
      for (const call of randomLegalCalls(entry.id)) {
        expect(model.boundToolNames, `${call.name} 不是真的工具`).toContain(call.name);
      }
    }
    for (const call of SPRAY_CALLS) expect(model.boundToolNames).toContain(call.name);
  });
});

describe('地板的字串不能撞上資料集', () => {
  // 撞上的話，隨機動作或亂吐有機會「碰巧」答對 —— 地板變成運氣，而且是資料集加題目那天
  // 才悄悄出現的運氣。逐題逐字串掃。
  it('任何地板字串都不含任何一題要的參數值或關鍵字', () => {
    const wanted = BENCHMARK.flatMap((entry) => [
      ...(entry.expected.mentions ?? []),
      ...entry.expected.toolCalls.flatMap((call) =>
        Object.values(call.args).filter((value): value is string => typeof value === 'string'),
      ),
    ]);
    expect(wanted.length).toBeGreaterThan(0);
    for (const text of FLOOR_STRINGS) {
      for (const needle of wanted) {
        expect(text.includes(needle), `地板字串「${text}」含有資料集的「${needle}」`).toBe(false);
      }
    }
  });

  it('三個 agent 都有互不相同的名字與 id', () => {
    expect(new Set(FLOOR_AGENTS.map((agent) => agent.label)).size).toBe(FLOOR_AGENTS.length);
    expect(new Set(FLOOR_AGENTS.map((agent) => agent.modelId)).size).toBe(FLOOR_AGENTS.length);
    expect(FLOOR_AGENTS).toEqual([DO_NOTHING, FIXED_SPRAY, RANDOM_LEGAL]);
  });
});

describe('報表那一行', () => {
  it('印得出三個 agent 的成功題數，不需要憑證', async () => {
    const summaries = (await fullFloor()).map((report) => summarize(report));
    expect(formatFloor(summaries)).toBe(
      FLOOR_AGENTS.map((agent) => `${agent.label} 0/${BENCHMARK.length}`).join('、'),
    );
    expect(floorHolds(summaries, BENCHMARK.length)).toBe(true);
  });

  it('只跑幾題時分母跟著變，跟模型跑同一批題目才對得上', async () => {
    const some = BENCHMARK.slice(0, 2);
    const summaries = await summarizeFloor(some);
    expect(formatFloor(summaries)).toContain('0/2');
    expect(floorHolds(summaries, 2)).toBe(true);
  });

  it('地板被破（有人成功）或沒跑完時 floorHolds 回 false', async () => {
    const summaries = (await fullFloor()).map((report) => summarize(report));
    expect(
      floorHolds(
        summaries.map((entry) => ({ ...entry, successes: 1 })),
        BENCHMARK.length,
      ),
    ).toBe(false);
    expect(
      floorHolds(
        summaries.map((entry) => ({ ...entry, scored: 0 })),
        BENCHMARK.length,
      ),
    ).toBe(false);
  });
});
