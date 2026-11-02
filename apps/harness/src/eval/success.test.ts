/**
 * 「這題成功」判準（[#1001](https://github.com/DemianLi/nexus-agent/issues/1001)）：每一項
 * 都是獨立承重的 —— 拿掉哪一項，對應的那一條就紅。
 *
 * 這裡全是對 {@link scoreCase} 的純函式測試：拿每一題的期望**現做**一份完美的觀測，再逐項
 * 弄壞一個地方。端到端那一半（真的跑 agent）在 `eval.test.ts`（標準解必過）與
 * `floor.test.ts`（平凡地板必不過）。
 */

import { describe, expect, it } from 'vitest';
import { BENCHMARK, type BenchmarkCase } from './dataset.js';
import type { BenchmarkRun, ObservedToolCall } from './runner.js';
import { isCaseSuccess, scoreCase } from './scorers.js';

/** 一份對這一題完美的觀測：期望的呼叫原樣、期望的字串全講到。 */
function perfect(entry: BenchmarkCase): BenchmarkRun {
  return {
    caseId: entry.id,
    toolCalls: entry.expected.toolCalls.map((call) => ({ name: call.name, args: call.args })),
    finalText: (entry.expected.mentions ?? []).join('、'),
  };
}

const EXTRA: ObservedToolCall = { name: 'ls', args: {} };

describe('完美的觀測每一題都成功', () => {
  for (const entry of BENCHMARK) {
    it(entry.id, () => {
      expect(scoreCase(entry, perfect(entry)).success).toBe(true);
    });
  }
});

describe('少了任何一項都不成功', () => {
  for (const entry of BENCHMARK) {
    const base = perfect(entry);

    if (entry.expected.toolCalls.length > 0) {
      it(`${entry.id}：少叫最後一個工具`, () => {
        const score = scoreCase(entry, { ...base, toolCalls: base.toolCalls.slice(0, -1) });
        expect(score.toolCallSuccess).toBeLessThan(1);
        expect(score.success).toBe(false);
      });

      it(`${entry.id}：工具順序反過來`, () => {
        // 只有多於一個呼叫時順序才有意義。
        if (base.toolCalls.length < 2) return;
        const names = new Set(base.toolCalls.map((call) => call.name));
        // 全是同一個工具名時，反過來的名字序列一樣；那一題由參數那條擋。
        if (names.size < 2) return;
        const score = scoreCase(entry, { ...base, toolCalls: [...base.toolCalls].reverse() });
        expect(score.success).toBe(false);
      });
    }

    const keyed = entry.expected.toolCalls.findIndex((call) => Object.keys(call.args).length > 0);
    if (keyed >= 0) {
      it(`${entry.id}：第 ${keyed + 1} 個呼叫的一個參數不對`, () => {
        const calls = base.toolCalls.map((call, index) => {
          if (index !== keyed) return call;
          const [key] = Object.keys(call.args);
          return { name: call.name, args: { ...call.args, [key as string]: '錯的值' } };
        });
        const score = scoreCase(entry, { ...base, toolCalls: calls });
        // **工具名字全對，所以工具成功率那一欄還是 1** —— 擋住它的只有參數那一項。
        expect(score.toolCallSuccess).toBe(1);
        expect(score.argumentCorrectness).toBeLessThan(1);
        expect(score.success).toBe(false);
      });
    }

    if ((entry.expected.mentions?.length ?? 0) > 0) {
      it(`${entry.id}：回覆沒把該提的講出來`, () => {
        const score = scoreCase(entry, { ...base, finalText: '我做完了。' });
        // 工具與參數全對，只有回覆不對 —— 擋住它的只有回覆提到那一項。
        expect(score.argumentCorrectness === undefined || score.argumentCorrectness === 1).toBe(
          true,
        );
        expect(score.mentions).toBe(0);
        expect(score.success).toBe(false);
      });
    }

    const tolerance = entry.expected.maxExtraToolCalls ?? 0;
    it(`${entry.id}：多叫的次數剛好到容許值（${tolerance}）還算成功，多一次就不成功`, () => {
      // 多叫放在尾端：子序列比對不看尾巴，所以前面三欄都還是滿分，擋住它的只有多叫那一項。
      const at = (extras: number): BenchmarkRun => ({
        ...base,
        toolCalls: [...base.toolCalls, ...Array.from({ length: extras }, () => EXTRA)],
      });
      expect(scoreCase(entry, at(tolerance)).success).toBe(true);
      const over = scoreCase(entry, at(tolerance + 1));
      expect(over.toolCallSuccess === undefined || over.toolCallSuccess === 1).toBe(true);
      expect(over.extraToolCalls).toBe(tolerance + 1);
      expect(over.success).toBe(false);
    });
  }
});

describe('工具成功率那一項獨立承重', () => {
  // 資料集裡每個期望呼叫都列了參數，少叫一個會同時被參數那一項抓到，所以拿掉工具那一項
  // 在現有題目上看不出來（突變驗過：沒有任何一條會紅）。這一題的期望呼叫沒列參數，
  // 只有工具那一項判得動 —— 它存在就是為了讓那一項拿掉時有一條會紅。
  const NO_ARGS: BenchmarkCase = {
    id: 'no-args',
    prompt: 'x',
    expected: { toolCalls: [{ name: 'ls', args: {} }] },
  };

  it('叫了就成功，沒叫就不成功', () => {
    expect(
      scoreCase(NO_ARGS, { caseId: 'no-args', toolCalls: [EXTRA], finalText: '' }).success,
    ).toBe(true);
    const missed = scoreCase(NO_ARGS, { caseId: 'no-args', toolCalls: [], finalText: '' });
    expect(missed.argumentCorrectness).toBeUndefined();
    expect(missed.toolCallSuccess).toBe(0);
    expect(missed.success).toBe(false);
  });
});

describe('容許值', () => {
  const SIMPLE: BenchmarkCase = {
    id: 'simple',
    prompt: 'x',
    expected: { toolCalls: [{ name: 'echo', args: { message: 'a' } }] },
  };
  const ONE: BenchmarkCase = {
    ...SIMPLE,
    expected: { ...SIMPLE.expected, maxExtraToolCalls: 1 },
  };
  const WITH_EXTRA = (n: number): BenchmarkRun => ({
    caseId: 'simple',
    toolCalls: [
      { name: 'echo', args: { message: 'a' } },
      ...Array.from({ length: n }, () => EXTRA),
    ],
    finalText: '',
  });

  it('沒宣告就當 0', () => {
    expect(scoreCase(SIMPLE, WITH_EXTRA(0)).success).toBe(true);
    expect(scoreCase(SIMPLE, WITH_EXTRA(1)).success).toBe(false);
  });

  it('宣告了就照宣告的', () => {
    expect(scoreCase(ONE, WITH_EXTRA(1)).success).toBe(true);
    expect(scoreCase(ONE, WITH_EXTRA(2)).success).toBe(false);
  });

  it('容許值只動「這題成功」，不動多叫那一欄', () => {
    expect(scoreCase(ONE, WITH_EXTRA(1)).extraToolCalls).toBe(1);
  });

  it('資料集宣告大於 0 的題目只有明著寫理由的那幾題', () => {
    // 容許值越大亂叫的越過得去；每多一題要有人看過。要加就改這份清單。
    const declared = BENCHMARK.filter((entry) => (entry.expected.maxExtraToolCalls ?? 0) > 0).map(
      (entry) => entry.id,
    );
    expect(declared).toEqual(['edit-after-read']);
  });
});

describe('一欄都沒判到的題目不成功', () => {
  it('期望零筆呼叫又沒有 mentions：空的真不算成功', () => {
    const bare: BenchmarkCase = { id: 'bare', prompt: 'x', expected: { toolCalls: [] } };
    const score = scoreCase(bare, { caseId: 'bare', toolCalls: [], finalText: '' });
    expect(score.success).toBe(false);
  });

  it('isCaseSuccess：所有欄位缺席也是不成功', () => {
    const bare: BenchmarkCase = { id: 'bare', prompt: 'x', expected: { toolCalls: [] } };
    expect(isCaseSuccess(bare, { extraToolCalls: 0 })).toBe(false);
  });

  it('克制題：沒叫工具、答對才成功；多叫一次就不成功', () => {
    const restraint = BENCHMARK.find((entry) => entry.id === 'no-tool-needed') as BenchmarkCase;
    const ok = { caseId: restraint.id, toolCalls: [], finalText: '等於 7' };
    expect(scoreCase(restraint, ok).success).toBe(true);
    expect(scoreCase(restraint, { ...ok, toolCalls: [EXTRA] }).success).toBe(false);
    expect(scoreCase(restraint, { ...ok, finalText: '' }).success).toBe(false);
  });
});
