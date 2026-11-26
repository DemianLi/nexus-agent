/**
 * 平凡地板 —— 三個不需要模型的 agent，跑的是同一份題目、同一個 runner、同一組評分器。
 *
 * **它們存在是為了讓每個分數旁邊都有一條地板。** 評分器沒有地板保護的時候，「一個與題目
 * 無關的固定亂吐 agent 在工具成功率與回覆提到兩欄各自有可判的六題全拿 `1.00`」這種事
 * 沒有人會發現：沒有人跑過「什麼都不懂的 agent 會得幾分」。這裡把那件事變成每次 CI 都跑、
 * 每份報表都印的東西（[#1001](https://github.com/DemianLi/nexus-agent/issues/1001)，
 * 對應藍圖量測規則 1）。
 *
 * ## 三個 agent 各自擋什麼
 *
 * | agent | 它是什麼 | 它擋的是 |
 * | --- | --- | --- |
 * | {@link DO_NOTHING} | 一句話都不說、一個工具都不叫 | 「沒有東西可判所以全對」的空洞成功 |
 * | {@link FIXED_SPRAY} | 與題目無關的固定一串工具呼叫，回覆裡塞滿所有題目要的關鍵字 | **只看名字與關鍵字的寬鬆判準**：工具成功率與回覆提到兩欄它全拿 `1.00` |
 * | {@link RANDOM_LEGAL} | 種子固定的隨機合法動作：真的存在的工具、過得了 schema 的參數、中性的字 | 靠運氣過關的判準（那一欄真的有鑑別力嗎） |
 *
 * **只有第二個有牙齒**，另外兩個在任何合理的判準下都判不成功 —— 它們留著是因為
 * 「在任何判準下都不成功」本身就是要釘住的事（有人把判準改成「沒有失敗就算成功」時
 * 第一個先紅）。第二個的牙齒由 `floor.test.ts` 釘住：它在寬鬆的兩欄必須真的拿滿分，
 * 否則地板測試綠著，卻什麼都沒擋到（一個連寬鬆判準都騙不過的「亂吐」是稻草人）。
 *
 * ## 為什麼參數與多叫次數擋得住第二個
 *
 * 它的工具呼叫是**合法但與題目無關**的參數（寫它自己的檔、grep 它自己的字）：名字對得上
 * 每一題的期望序列，參數一個都對不上。判準若退回只看名字與關鍵字，它就成功。
 */

import type { AgentModel } from '@nexus/core';
import { ScriptedChatModel, type ScriptedToolCall } from '../scripted-model.js';
import { compareTiers, summarize, type TierReport, type TierSummary } from './compare.js';
import { BENCHMARK, type BenchmarkCase } from './dataset.js';
import type { ModelUnderTest } from './model-under-test.js';
import { mulberry32 } from './stats.js';

/** 一個平凡 agent。 */
export interface FloorAgent extends ModelUnderTest {
  /** 這一題要用的假模型。 */
  createModel(testCase: BenchmarkCase): AgentModel;
}

/**
 * 地板用的「亂吐」字串。**任何一題的資料集字串都不准出現在裡面** —— `floor.test.ts` 逐題掃。
 * 出現的話，隨機動作就可能撞上正確答案，地板變成運氣。
 */
const NEUTRAL_WORDS: readonly string[] = [
  '蘋果',
  '香蕉',
  '晴天',
  'banana',
  'alpha',
  'lorem ipsum',
  '無關緊要',
  '隨便',
];

/** 地板自己的檔名。不是任何一題要寫的那幾個。 */
const SCRATCH_PATHS: readonly string[] = ['/floor-1.md', '/floor-2.md', '/floor-3.md'];

/** 沒有任何一個題目會問到的中性回覆。 */
const NEUTRAL_REPLY = '我不確定這是不是你要的，不過我試過了。';

/** 地板用的字串全集，給測試掃它有沒有撞上資料集。 */
export const FLOOR_STRINGS: readonly string[] = [...NEUTRAL_WORDS, ...SCRATCH_PATHS, NEUTRAL_REPLY];

/** 什麼都不做：一句話都不說，一個工具都不叫。 */
export const DO_NOTHING: FloorAgent = {
  label: '什麼都不做',
  modelId: 'floor-do-nothing',
  createModel: () => new ScriptedChatModel({ turns: [{ content: '' }] }),
};

/**
 * 固定亂吐的那一串工具呼叫。
 *
 * **這個順序是承重的**：每一題的期望序列（`echo`／`write_file`×2／`read_file`／`edit_file`／
 * `grep` 的各種排列）都是它的子序列，所以工具成功率那一欄在每一個有呼叫的題目上都是 `1.00`。
 * 改它之前先看 `floor.test.ts` 那條「牙齒」的斷言。
 */
export const SPRAY_CALLS: readonly ScriptedToolCall[] = [
  { name: 'echo', args: { message: '無關緊要' } },
  { name: 'write_file', args: { file_path: '/floor-1.md', content: '無關緊要' } },
  { name: 'write_file', args: { file_path: '/floor-2.md', content: '隨便' } },
  { name: 'read_file', args: { file_path: '/floor-1.md' } },
  {
    name: 'edit_file',
    args: { file_path: '/floor-1.md', old_string: '無關緊要', new_string: '隨便' },
  },
  { name: 'write_file', args: { file_path: '/floor-3.md', content: 'alpha' } },
  { name: 'grep', args: { pattern: 'banana' } },
];

/**
 * 固定亂吐：同一串工具呼叫（一輪全部吐完），最後一句話把**整份資料集**所有要提的字串都
 * 念一遍。與題目無關，所以題目換了它一個字都不變。
 *
 * 關鍵字從 {@link BENCHMARK} 現算，不手抄：資料集加了題目，它的回覆自動跟著帶上新的字，
 * 「回覆提到」那一欄永遠騙得過。手抄的話，加題目那天它就靜靜變弱了。
 */
export const FIXED_SPRAY: FloorAgent = {
  label: '固定亂吐',
  modelId: 'floor-fixed-spray',
  createModel: () =>
    new ScriptedChatModel({
      turns: [
        { content: '', toolCalls: SPRAY_CALLS },
        { content: BENCHMARK.flatMap((entry) => entry.expected.mentions ?? []).join('、') },
      ],
    }),
};

/** 字串的 32 位元雜湊，當亂數種子用。 */
function seedOf(text: string): number {
  let hash = 2166136261;
  for (const char of text) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  }
  return hash >>> 0;
}

/**
 * 一題的隨機合法動作：一到三次工具呼叫，每一次都是真的存在的工具、參數過得了 schema，
 * 內容全從 {@link NEUTRAL_WORDS} 與 {@link SCRATCH_PATHS} 取。
 *
 * 種子是題目 id，所以**同一題永遠同一串**（CI 可重現）、**不同題各自不同**。
 */
export function randomLegalCalls(caseId: string): readonly ScriptedToolCall[] {
  const next = mulberry32(seedOf(caseId));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const word = (): string => pick(NEUTRAL_WORDS);
  const path = (): string => pick(SCRATCH_PATHS);

  const makers: readonly (() => ScriptedToolCall)[] = [
    () => ({ name: 'echo', args: { message: word() } }),
    () => ({ name: 'write_file', args: { file_path: path(), content: word() } }),
    () => ({ name: 'read_file', args: { file_path: path() } }),
    () => ({
      name: 'edit_file',
      args: { file_path: path(), old_string: word(), new_string: word() },
    }),
    () => ({ name: 'grep', args: { pattern: word() } }),
    () => ({ name: 'ls', args: { path: '/' } }),
  ];

  const count = 1 + Math.floor(next() * 3);
  return Array.from({ length: count }, () => pick(makers)());
}

/** 隨機合法動作：見 {@link randomLegalCalls}。 */
export const RANDOM_LEGAL: FloorAgent = {
  label: '隨機合法動作',
  modelId: 'floor-random-legal',
  createModel: (testCase) =>
    new ScriptedChatModel({
      turns: [
        { content: '', toolCalls: randomLegalCalls(testCase.id) },
        { content: NEUTRAL_REPLY },
      ],
    }),
};

/** 三個平凡 agent，報表上的順序。 */
export const FLOOR_AGENTS: readonly FloorAgent[] = [DO_NOTHING, FIXED_SPRAY, RANDOM_LEGAL];

/**
 * 把三個平凡 agent 跑一遍。
 *
 * 走的是 {@link compareTiers} —— **跟真模型同一條路**（同一個 runner、同一組評分器、同一個
 * 迴圈上限與時間預算），所以地板量到的就是評分器在這條路上對它們的態度，不是另一條路。
 * 零憑證，不連外。
 *
 * @param cases - 跑哪幾題。報表上的地板要跟模型跑同一批題目才對得上。
 */
export async function runFloor(
  cases: readonly BenchmarkCase[] = BENCHMARK,
): Promise<readonly TierReport<FloorAgent>[]> {
  return compareTiers(FLOOR_AGENTS, {
    createModel: (modelId, testCase) => {
      const agent = FLOOR_AGENTS.find((entry) => entry.modelId === modelId);
      if (agent === undefined) throw new Error(`不認得的地板 agent：${modelId}`);
      return agent.createModel(testCase);
    },
    cases,
  });
}

/**
 * 三個平凡 agent 的成功題數，印成一行。**報表（`eval:compare`）上每個模型的成功題數旁
 * 都要有這一行** —— 分數旁邊總有地板，讀的人才知道「5/7」是在什麼背景下的 5。
 *
 * 放在這裡而不是 CLI 檔裡，是因為 CLI 檔一 import 就會開跑（要憑證）；這一行零憑證、
 * 該有測試釘住它印得出來。
 */
export function formatFloor(summaries: readonly TierSummary[]): string {
  return summaries
    .map((entry) => `${entry.tier.label} ${entry.successes}/${entry.scored}`)
    .join('、');
}

/**
 * 地板跑完之後的狀態：全部 0 成功、而且每一題都真的跑完。
 *
 * 不是這個狀態就代表這一輪的「這題成功」不可信：有平凡 agent 被判成功是評分器的洞，
 * 有執行沒跑完是地板自己壞了 —— 兩種都不該悄悄過去。
 */
export function floorHolds(summaries: readonly TierSummary[], caseCount: number): boolean {
  return summaries.every((entry) => entry.successes === 0 && entry.scored === caseCount);
}

/** {@link runFloor} 再彙總。 */
export async function summarizeFloor(
  cases: readonly BenchmarkCase[] = BENCHMARK,
): Promise<readonly TierSummary[]> {
  return (await runFloor(cases)).map((report) => summarize(report));
}
