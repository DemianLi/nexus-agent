/**
 * 兩個 eval 進入點共用的命令列解析。
 *
 * **抽出來的理由有兩個，第二個才是重點。** 第一是 `eval:compare` 與 `eval:survey` 要吃
 * 同一組旗標，同一份規則寫兩遍遲早會分歧。第二是**這些函式原本測不到** ——
 * `compare-cli.ts` 結尾有一行 top-level `await main(...)`，`import` 它就會當場開始跑一輪
 * 真的比較，所以裡面的解析邏輯從第一天就沒有單測。搬到這個沒有副作用的模組之後才測得了。
 */

import { BENCHMARK, type BenchmarkCase } from './dataset.js';
import type { ModelUnderTest } from './model-under-test.js';

/**
 * `--cases` 解析。
 *
 * **認不得的 id 一律當場拋，不默默略過。** 打錯一個字就跑了個比預期少的子集，
 * 而報表上完全看不出來少了哪一題 —— 那與 #79 那個 `status === 'idle'` 是同一型的假綠。
 */
export function parseCases(argv: readonly string[]): readonly BenchmarkCase[] {
  const at = argv.indexOf('--cases');
  if (at < 0) return BENCHMARK;
  const raw = argv[at + 1];
  if (raw === undefined || raw.startsWith('--')) throw new Error('--cases 要一串以逗號分隔的 id');

  const wanted = raw.split(',').map((id) => id.trim());
  const known = new Set(BENCHMARK.map((entry) => entry.id));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `--cases 認不得這些 id：${unknown.join('、')}。可用的是 ${[...known].join('、')}`,
    );
  }
  // 依資料集的順序跑，不依命令列打字的順序 —— 報表的列順序才不會隨手打的參數而變。
  return BENCHMARK.filter((entry) => wanted.includes(entry.id));
}

/** `--samples` 解析。非正整數當場拋。 */
export function parseSamples(argv: readonly string[]): number {
  const at = argv.indexOf('--samples');
  if (at < 0) return 1;
  const raw = argv[at + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--samples 要一個正整數，收到 ${raw ?? '（空的）'}`);
  }
  return value;
}

/**
 * `--models` 解析 —— 只跑清單裡的某幾個 label。
 *
 * 存在的理由是**冒煙**：整輪是小時級的，開跑前先拿一題一次取樣掃過全部候選，
 * 才知道誰會在半路失敗、每次要跑多久。認不得的 label 同樣當場拋，理由同 `--cases`。
 *
 * 回傳的順序依 `all` 的順序，不依打字的順序。
 */
export function parseModels<T extends ModelUnderTest>(
  argv: readonly string[],
  all: readonly T[],
): readonly T[] {
  const at = argv.indexOf('--models');
  if (at < 0) return all;
  const raw = argv[at + 1];
  if (raw === undefined || raw.startsWith('--')) throw new Error('--models 要一串以逗號分隔的短名');

  const wanted = raw.split(',').map((label) => label.trim());
  const known = new Set(all.map((model) => model.label));
  const unknown = wanted.filter((label) => !known.has(label));
  if (unknown.length > 0) {
    throw new Error(
      `--models 認不得這些短名：${unknown.join('、')}。可用的是 ${[...known].join('、')}`,
    );
  }
  return all.filter((model) => wanted.includes(model.label));
}
