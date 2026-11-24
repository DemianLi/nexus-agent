/**
 * 量過的模型這份清單本身。
 *
 * 這裡不連外 —— 端點上叫不叫得動是**盤點**的事（方法見 `tiers.ts` 檔頭），
 * 綁進 CI 就變成一條需要憑證、而且會因為對方改權限而紅掉的測試。
 *
 * **2026-09-05：這個檔案原本有六條守著兩道尺寸階梯的斷言，跟著階梯一起刪了（#167）。**
 * 沒有留空陣列繼續跑那六個 `for` 迴圈 —— 那會是六條永遠綠的測試。其中三條是承重的
 * （至少兩階／同家族前綴／至少一階在 30B 以下），已經翻面寫成重建的驗收條件，
 * 放在 `tiers.ts` 的檔頭。下面第一條就是在擋這個坑的下一次。
 */

import { describe, expect, it } from 'vitest';
import { MEASURED_MODELS, SCORER_CONTROL, type MeasuredModel } from './tiers.js';

describe('MEASURED_MODELS', () => {
  it('不是空的 —— 空清單會讓底下每一條斷言都變成永遠綠', () => {
    // 收掉階梯的時候差一點就踩到：資料刪光、`for (const x of [])` 全部通過。
    // 這條在資料被清空的那一刻紅，而預設模型那條絆索（live-model.test.ts）也才有東西可比。
    expect(MEASURED_MODELS.length).toBeGreaterThan(0);
  });

  it('每個項目只有四個鍵 —— 尺寸欄位在這裡是型別錯誤', () => {
    // 這條是絆索，接的是階梯收掉之前那條「同一道階梯上是同一個家族」。這份清單跨四個家族，
    // 有人加上 `totalBillions` 的那一刻，報表就多出一條讀不成尺寸效應的線。
    // 同樣的規矩在 `survey.test.ts` 也有一條（#85 第 3 條）。
    for (const model of MEASURED_MODELS) {
      expect(Object.keys(model).sort()).toEqual(['label', 'measuredOn', 'modelId', 'note']);
    }
  });

  it('依 model id 的字典序 —— 沒有階梯之後，任何其他順序都會被讀成排名', () => {
    const ids = MEASURED_MODELS.map((model) => model.modelId);
    expect(ids).toEqual([...ids].sort());
  });

  it('label 與 model id 都兩兩不同 —— 報表靠 label 指名', () => {
    const labels = MEASURED_MODELS.map((model) => model.label);
    const ids = MEASURED_MODELS.map((model) => model.modelId);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('量測日期是 YYYY-MM-DD —— 報表要印它，因為這份集合會變', () => {
    // 三輪盤點掉了 5 個可用的模型（14 → 16 → 9）。沒有日期的數字讀不出還算不算數。
    for (const model of MEASURED_MODELS) {
      expect(model.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('每個項目都說得出那一次量到什麼', () => {
    for (const model of MEASURED_MODELS) {
      expect(model.note.trim()).not.toBe('');
    }
  });
});

describe('SCORER_CONTROL', () => {
  it('是這份清單裡的一員，而且是同一個物件', () => {
    // 分開宣告是為了它有自己的角色說明（判準的下界，不是選型候選）。同一個物件
    // 而不是同名的複本 —— 兩份會各自漂移，而漂移不會有任何東西紅。
    expect(MEASURED_MODELS).toContain<MeasuredModel>(SCORER_CONTROL);
  });
});
