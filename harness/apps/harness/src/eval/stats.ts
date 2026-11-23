/**
 * 以題目為單位的區間與「一題等於幾個百分點」—— 純函式、零相依。
 *
 * [#1002](https://github.com/DemianLi/nexus-agent/issues/1002)，對應藍圖量測規則 7、T7-06
 * 與 T8-06 的前半（誤差棒）。
 *
 * ## 為什麼不用最小到最大
 *
 * `compare.ts` 的 {@link Spread} 是平均加最小到最大，它把兩種變異混在一起：**不同題目之間**
 * 的差（這題難、那題簡單）與**同一題重跑之間**的差（取樣是隨機的）。拿它當誤差棒，讀的人
 * 無從分辨一個寬的範圍是因為題目難易不一還是因為模型不穩。藍圖 T8-06 明寫不要拿 min–max
 * 當誤差棒；它在這裡改名叫「範圍」，另外報區間。
 *
 * ## 方法（會原樣印在報表上）
 *
 * **以題目為單位重抽的百分位 bootstrap。** 每一題先把自己所有判得動的執行取平均（同題重跑
 * 的變異在這一步被收掉，不會單獨撐大區間），再把「題」當成獨立的單位：從 n 題裡有放回地
 * 抽 n 題、取平均，重複 {@link BOOTSTRAP_RESAMPLES} 次，取 2.5% 與 97.5% 兩個百分位。
 * 不把每次試跑當獨立樣本 —— 同一題的三次取樣不是三個獨立的證據（藍圖 T7-06 的次要項，
 * 證據較弱，但方向是保守的：不這樣做區間會偏窄）。
 *
 * **種子固定**（{@link BOOTSTRAP_SEED}），同一份資料永遠算出同一個區間：結果檔重新彙總
 * 要得到一樣的數字，兩次報表的差不能有一部分是抽樣造成的。
 *
 * **起手值（95%、2000 次）是我們訂的，不是文獻給的**（T7-06 的「起手預設值」寫「文獻沒給，
 * 不自己訂」）。它們只影響區間的邊緣精度，不影響「題目少所以很寬」這個結論。
 *
 * ## 已知的邊界
 *
 * - **少於兩題不報區間**：一題沒有「換一題」的變異可抽，印出來的任何區間都是假的。
 * - **所有題目同值時區間塌成一點**（例如七題全 1.00 → `[1, 1]`）。那不是沒有不確定度，是
 *   重抽抽不出來：七題全對仍然與「真實成功率 0.7」相容。結果上有 {@link CaseStats.collapsed}
 *   標記，報表會明說。
 */

/** 一次執行在某一欄的觀測值。 */
export interface ColumnEntry {
  readonly caseId: string;
  /** 這次執行在這一欄的值。 */
  readonly value: number;
}

/** 重抽次數。 */
export const BOOTSTRAP_RESAMPLES = 2000;

/** 信賴水準。 */
export const BOOTSTRAP_LEVEL = 0.95;

/** 亂數種子。換掉它區間會小幅抖動；固定它同一份資料永遠同一個答案。 */
export const BOOTSTRAP_SEED = 0x1002;

/** 區間本身。 */
export interface CaseInterval {
  readonly low: number;
  readonly high: number;
  readonly level: number;
  readonly resamples: number;
}

/** 一欄的統計。 */
export interface CaseStats {
  /** 以題為單位的平均：每題先取平均，再對題取平均。 */
  readonly mean: number;
  /** 有貢獻的題數（重抽的單位）。 */
  readonly cases: number;
  /** 判得動的執行數。 */
  readonly runs: number;
  /** 一題從 1 掉到 0，這一欄的平均動幾個百分點：`100 / cases`。 */
  readonly pointsPerCase: number;
  /** 一次執行從 1 掉到 0，這一欄的平均動幾個百分點：`100 / runs`。 */
  readonly pointsPerRun: number;
  /** 少於兩題時沒有。 */
  readonly interval?: CaseInterval;
  /** 區間塌成一點（所有題目同值）。 */
  readonly collapsed: boolean;
}

/** 種子固定的小亂數（mulberry32）。要的是確定，不是品質。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 每題先收成一個平均。保留第一次出現的順序，讓結果不依賴物件鍵的排序。 */
function perCaseMeans(entries: readonly ColumnEntry[]): readonly number[] {
  const sums = new Map<string, { total: number; count: number }>();
  for (const entry of entries) {
    const slot = sums.get(entry.caseId) ?? { total: 0, count: 0 };
    slot.total += entry.value;
    slot.count += 1;
    sums.set(entry.caseId, slot);
  }
  return [...sums.values()].map((slot) => slot.total / slot.count);
}

/**
 * 一欄的統計。
 *
 * @param entries - 這一欄所有**判得動**的執行（缺席的不進來，理由同 `scorers.ts`）。
 * @returns 沒有任何一筆時回 `undefined`。
 */
export function caseStats(entries: readonly ColumnEntry[]): CaseStats | undefined {
  if (entries.length === 0) return undefined;
  const means = perCaseMeans(entries);
  const cases = means.length;
  const mean = means.reduce((sum, value) => sum + value, 0) / cases;

  const base = {
    mean,
    cases,
    runs: entries.length,
    pointsPerCase: 100 / cases,
    pointsPerRun: 100 / entries.length,
  };
  if (cases < 2) return { ...base, collapsed: false };

  const next = mulberry32(BOOTSTRAP_SEED);
  const resampled: number[] = [];
  for (let round = 0; round < BOOTSTRAP_RESAMPLES; round += 1) {
    let total = 0;
    for (let draw = 0; draw < cases; draw += 1) {
      total += means[Math.floor(next() * cases)] as number;
    }
    resampled.push(total / cases);
  }
  resampled.sort((a, b) => a - b);

  const tail = (1 - BOOTSTRAP_LEVEL) / 2;
  const low = resampled[Math.floor(tail * (BOOTSTRAP_RESAMPLES - 1))] as number;
  const high = resampled[Math.ceil((1 - tail) * (BOOTSTRAP_RESAMPLES - 1))] as number;
  return {
    ...base,
    interval: { low, high, level: BOOTSTRAP_LEVEL, resamples: BOOTSTRAP_RESAMPLES },
    collapsed: low === high,
  };
}

/** 一個百分點數，印成一位小數。 */
function points(value: number): string {
  return value.toFixed(1);
}

/**
 * 把一欄統計印成報表上的字。**方法與 n 都在字裡**（卡片要求），所以讀的人不必去翻原始碼
 * 才知道這個區間是怎麼來的。
 *
 * @param stats - {@link caseStats} 的結果。
 */
export function formatCaseStats(stats: CaseStats | undefined): string {
  if (stats === undefined) return '—';
  const granularity =
    stats.runs === stats.cases
      ? `一題 = ${points(stats.pointsPerCase)} 個百分點`
      : `一題 = ${points(stats.pointsPerCase)} 個百分點（一次執行 = ${points(stats.pointsPerRun)}，共 ${stats.runs} 次）`;
  if (stats.interval === undefined) {
    return `只有 ${stats.cases} 題，抽不出區間；${granularity}`;
  }
  const { low, high, level, resamples } = stats.interval;
  // 區間配著它自己的中心值印：它是**以題為單位**的平均，跟上一行逐次合併的平均在取樣不止
  // 一次、又有失敗吃掉某幾題的執行時會分開，不印的話區間看起來像沒包住上一行的數字。
  const range = `題均 ${stats.mean.toFixed(2)}，${Math.round(level * 100)}% 區間 ${low.toFixed(2)}–${high.toFixed(2)}`;
  const method = `以 ${stats.cases} 題為單位重抽 ${resamples} 次`;
  const collapsed = stats.collapsed ? '；**所有題目同值，區間塌成一點，不代表沒有不確定度**' : '';
  return `${range}（${method}）；${granularity}${collapsed}`;
}
