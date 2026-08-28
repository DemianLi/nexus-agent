/**
 * 三個橫階的資料本身。
 *
 * 這裡不連外 —— 端點上叫不叫得動是**盤點**的事（見 `tiers.ts` 檔頭記的那次），
 * 綁進 CI 就變成一條需要憑證、而且會因為對方改權限而紅掉的測試。
 * 這個檔案守的是另一件事：**這道階梯還是不是一道階梯。**
 */

import { describe, expect, it } from 'vitest';
import { MODEL_TIERS } from './tiers.js';

describe('MODEL_TIERS', () => {
  it('三階', () => {
    expect(MODEL_TIERS).toHaveLength(3);
  });

  it('總量與活化都嚴格遞增 —— 兩種讀法下都要是階梯', () => {
    // 稀疏模型的計算量更接近活化參數量。只有總量單調的話，「隨尺寸衰減」這句話
    // 在按計算量讀的時候可能是反過來的。
    const totals = MODEL_TIERS.map((tier) => tier.totalBillions);
    const actives = MODEL_TIERS.map((tier) => tier.activeBillions);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
    expect(actives).toEqual([...actives].sort((a, b) => a - b));
    expect(new Set(totals).size).toBe(totals.length);
    expect(new Set(actives).size).toBe(actives.length);
  });

  it('活化不會大於總量', () => {
    for (const tier of MODEL_TIERS) {
      expect(tier.activeBillions).toBeLessThanOrEqual(tier.totalBillions);
    }
  });

  it('同一個家族 —— 換掉其中一階就不再是「只有尺寸在變」', () => {
    // 廠商、家族、訓練配方全部按住，才只剩尺寸這一個自變數。這條紅了代表有人往裡面
    // 塞了別家的模型，那時報表上的差異不再只是尺寸造成的。
    for (const tier of MODEL_TIERS) {
      expect(tier.modelId).toMatch(/^nvidia\/nemotron-3-/);
    }
  });

  it('id 裡的參數量與欄位對得起來', () => {
    // `-30b-a3b` 這種後綴是 NVIDIA 自己標的，欄位是我們抄下來的 —— 抄錯的話報表的
    // x 軸就是錯的，而那不會有任何其他東西紅。
    for (const tier of MODEL_TIERS) {
      expect(tier.modelId).toContain(`-${tier.totalBillions}b-a${tier.activeBillions}b`);
    }
  });

  it('label 兩兩不同', () => {
    const labels = MODEL_TIERS.map((tier) => tier.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
