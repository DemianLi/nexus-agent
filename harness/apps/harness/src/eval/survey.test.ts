/**
 * 選型調查的清單本身。
 *
 * 跟 `tiers.test.ts` 一樣不連外 —— 端點上還叫不叫得動是**盤點**的事，綁進 CI 就成了
 * 一條需要憑證、而且會因為對方改權限而紅掉的測試。這裡守的是另一件事：
 * **這份清單還是不是一份「不比尺寸」的平坦清單。**
 */

import { describe, expect, it } from 'vitest';
import { SURVEY_INVENTORY_DATE, SURVEY_MODELS } from './survey.js';
import { MEASURED_MODELS } from './tiers.js';

describe('SURVEY_MODELS', () => {
  it('至少十個 —— 那是 #85 的門檻，掉到十個以下要停下來回報而不是照跑', () => {
    // 這條紅了不代表把清單補滿就好：湊不到十個時 #85 的指示是停下來報盤點數字，
    // 由 demian 決定要不要加第二個端點。改這個數字之前先去讀那一段。
    expect(SURVEY_MODELS.length).toBeGreaterThanOrEqual(10);
  });

  it('id 不重複', () => {
    const ids = SURVEY_MODELS.map((model) => model.modelId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('label 不重複 —— 報表靠它指名', () => {
    const labels = SURVEY_MODELS.map((model) => model.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('依 model id 的字典序 —— 任何其他順序都會被讀成排名或尺寸', () => {
    const ids = SURVEY_MODELS.map((model) => model.modelId);
    expect(ids).toEqual([...ids].sort());
  });

  it('每個候選只有 label 與 modelId 兩個鍵 —— 尺寸欄位在這裡是型別錯誤', () => {
    // 這條是絆索。有人往這份清單加 `totalBillions` 的那一刻它會紅，而那正是
    // 「這份報告不是在比尺寸」（#85 第 3 條）從型別退化成一句口號的時刻。
    for (const model of SURVEY_MODELS) {
      expect(Object.keys(model).sort()).toEqual(['label', 'modelId']);
    }
  });

  it('也出現在量過的清單裡的 id，label 一字不差', () => {
    // 同一個模型在兩張報表上叫不同名字的話，跨報表對照就得靠人腦記憶。
    // 這條擋的是「survey 這邊順手取了個新名字」。
    const byId = new Map(MEASURED_MODELS.map((measured) => [measured.modelId, measured.label]));
    for (const model of SURVEY_MODELS) {
      const existing = byId.get(model.modelId);
      if (existing === undefined) continue;
      expect(model.label).toBe(existing);
    }
  });

  it('盤點日期是 YYYY-MM-DD —— 報表要印它，因為這份集合會變', () => {
    expect(SURVEY_INVENTORY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
