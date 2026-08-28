/**
 * 階梯與判準對照的資料本身。
 *
 * 這裡不連外 —— 端點上叫不叫得動是**盤點**的事（見 `tiers.ts` 檔頭記的那兩次），
 * 綁進 CI 就變成一條需要憑證、而且會因為對方改權限而紅掉的測試。
 * 這個檔案守的是另一件事：**這些階梯還是不是階梯。**
 */

import { describe, expect, it } from 'vitest';
import { ALL_MODELS_UNDER_TEST, MODEL_LADDERS, SCORER_CONTROL, type ModelTier } from './tiers.js';

/** id 後綴裡的活化參數量，例如 `-30b-a3b` 的 `3`。沒有後綴時是 `undefined`。 */
function activeFromId(modelId: string): number | undefined {
  const match = /-\d+b-a(\d+(?:\.\d+)?)b$/.exec(modelId);
  return match === null ? undefined : Number(match[1]);
}

describe('MODEL_LADDERS', () => {
  it('每道階梯至少兩階 —— 只有一階的話沒有同家族對照，那不是階梯', () => {
    // 少了對照，量到的衰減分不出是尺寸還是這一家的訓練配方。真的只有一個 id 可跑時
    // 該走 SCORER_CONTROL 那條路，而不是宣告成一道階梯。
    for (const ladder of MODEL_LADDERS) {
      expect(ladder.tiers.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('同一道階梯上是同一個家族 —— 換掉其中一階就不再是「只有尺寸在變」', () => {
    // 這條紅了代表有人往某道階梯裡塞了別家的模型，那時該階梯上的差異不再只是尺寸造成的。
    for (const ladder of MODEL_LADDERS) {
      for (const tier of ladder.tiers) {
        expect(tier.modelId.startsWith(ladder.idPrefix)).toBe(true);
      }
    }
  });

  it('總量在每道階梯內嚴格遞增', () => {
    for (const ladder of MODEL_LADDERS) {
      const totals = ladder.tiers.map((tier) => tier.totalBillions);
      expect(totals).toEqual([...totals].sort((a, b) => a - b));
      expect(new Set(totals).size).toBe(totals.length);
    }
  });

  it('活化全部有值時也嚴格遞增 —— 兩種讀法下都要是階梯', () => {
    // 稀疏模型的計算量更接近活化參數量。只有總量單調的話，「隨尺寸衰減」這句話
    // 在按計算量讀的時候可能是反過來的。
    for (const ladder of MODEL_LADDERS) {
      const actives = ladder.tiers.map((tier) => tier.activeBillions);
      if (actives.some((active) => active === undefined)) continue;
      const known = actives as number[];
      expect(known).toEqual([...known].sort((a, b) => a - b));
      expect(new Set(known).size).toBe(known.length);
    }
  });

  it('階梯的 name 與 idPrefix 兩兩不同', () => {
    const names = MODEL_LADDERS.map((ladder) => ladder.name);
    const prefixes = MODEL_LADDERS.map((ladder) => ladder.idPrefix);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('至少有一階在 30B 以下 —— 底板太高正是 #83 定不了案的原因', () => {
    // 這條是這張 PR 的存在理由。把 30B 以下那一階刪掉，報表照樣全綠、數字照樣漂亮，
    // 而結論會安靜地退回「三個指標都滿分，不知道為什麼」。判的是總量那一欄：
    // 活化那一欄在新的階梯上沒有值（見 tiers.ts 檔頭）。
    const lowest = Math.min(
      ...MODEL_LADDERS.flatMap((ladder) => ladder.tiers).map((tier) => tier.totalBillions),
    );
    expect(lowest).toBeLessThan(30);
  });
});

describe('活化那一欄與 id 綁死', () => {
  const everyModel: readonly ModelTier[] = ALL_MODELS_UNDER_TEST;

  it('id 有 `-aNb` 後綴就必須填且相符，沒有就必須是 undefined', () => {
    // 後綴是這一欄唯一的資料來源。抄錯的話報表的 x 軸就是錯的，而那不會有任何其他東西紅；
    // 反過來，憑記憶補一個端點給不出來的數字，等於把一個沒人守得住的座標寫進報表。
    for (const tier of everyModel) {
      expect(tier.activeBillions).toBe(activeFromId(tier.modelId));
    }
  });

  it('總量也抄自 id', () => {
    for (const tier of everyModel) {
      expect(tier.modelId).toContain(`-${tier.totalBillions}b`);
    }
  });

  it('活化不會大於總量', () => {
    for (const tier of everyModel) {
      if (tier.activeBillions === undefined) continue;
      expect(tier.activeBillions).toBeLessThanOrEqual(tier.totalBillions);
    }
  });
});

describe('SCORER_CONTROL', () => {
  it('不屬於任何一道階梯 —— 它的分數不准讀成尺寸效應', () => {
    // 它沒有同家族對照（90b 三次探測全部逾時），所以一旦被當成一階排進去，
    // 報表上就會出現一條「11B 比 20B 差」的線，而那條線歸因不到尺寸。
    const ladderIds = MODEL_LADDERS.flatMap((ladder) => ladder.tiers).map((tier) => tier.modelId);
    expect(ladderIds).not.toContain(SCORER_CONTROL.modelId);
  });

  it('比每一道階梯的底板都小 —— 它探的是判準的下界', () => {
    const lowest = Math.min(
      ...MODEL_LADDERS.flatMap((ladder) => ladder.tiers).map((tier) => tier.totalBillions),
    );
    expect(SCORER_CONTROL.totalBillions).toBeLessThan(lowest);
  });
});

describe('ALL_MODELS_UNDER_TEST', () => {
  it('涵蓋所有階梯加上判準對照，沒有重複的 model id', () => {
    const expected = MODEL_LADDERS.flatMap((ladder) => ladder.tiers).length + 1;
    expect(ALL_MODELS_UNDER_TEST).toHaveLength(expected);
    const ids = ALL_MODELS_UNDER_TEST.map((tier) => tier.modelId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('label 兩兩不同 —— 報表靠它指名', () => {
    const labels = ALL_MODELS_UNDER_TEST.map((tier) => tier.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
